//! Docker webcam fixture: fixed-format output, malformed VP8 recovery and joined shutdown.
use anyhow::{Context, Result, ensure};
use ffmpeg_next as av;
use std::{path::PathBuf, time::{Duration, Instant}};

fn main() -> Result<()> {
    let device = PathBuf::from(std::env::args_os().nth(1).context("webcam device argument")?);
    let (tx, rx) = tokio::sync::mpsc::channel(4);
    let output = elsewhere_stream::video_sink(&device, rx)?;
    let codec = av::encoder::find_by_name("libvpx").context("libvpx")?;
    let mut encoder = av::codec::Context::new_with_codec(codec).encoder().video()?;
    encoder.set_width(640); encoder.set_height(480);
    encoder.set_format(av::format::Pixel::YUV420P);
    encoder.set_time_base((1, 30)); encoder.set_frame_rate(Some((30, 1)));
    encoder.set_bit_rate(1_000_000); encoder.set_gop(30);
    let mut options = av::Dictionary::new();
    options.set("deadline", "realtime"); options.set("lag-in-frames", "0"); options.set("cpu-used", "8");
    let mut encoder = encoder.open_as_with(codec, options)?;
    let start = Instant::now();
    let mut waiting_key = false;
    for index in 0..150 {
        output.check()?;
        let mut frame = av::frame::Video::new(av::format::Pixel::YUV420P, 640, 480);
        frame.data_mut(0).fill(if index < 15 { 64 } else { 180 });
        frame.data_mut(1).fill(128); frame.data_mut(2).fill(128);
        frame.set_pts(Some(index));
        frame.set_kind(if index % 30 == 0 { av::picture::Type::I } else { av::picture::Type::None });
        encoder.send_frame(&frame)?;
        loop {
            let mut packet = av::Packet::empty();
            match encoder.receive_packet(&mut packet) {
                Ok(()) => {
                    if index == 15 {
                        let _ = tx.try_send(elsewhere_core::Bytes::from_static(&[1, 2, 3]));
                    } else if packet.is_key() || !waiting_key {
                        match tx.try_send(elsewhere_core::Bytes::copy_from_slice(packet.data().context("VP8 packet")?)) {
                            Ok(()) => waiting_key = false,
                            Err(tokio::sync::mpsc::error::TrySendError::Full(_)) => waiting_key = true,
                            Err(error) => return Err(error.into()),
                        }
                    }
                }
                Err(av::Error::Other { errno: av::error::EAGAIN }) => break,
                Err(error) => return Err(error.into()),
            }
        }
        std::thread::sleep((start + Duration::from_millis((index as u64 + 1) * 1000 / 30)).saturating_duration_since(Instant::now()));
    }
    output.check()?;
    let stop = Instant::now();
    drop(output);
    ensure!(stop.elapsed() < Duration::from_millis(500), "webcam stop exceeded 500 ms");
    ensure!(tx.is_closed(), "webcam receiver survived its worker");
    eprintln!("webcam joined in {:?}", stop.elapsed());
    Ok(())
}
