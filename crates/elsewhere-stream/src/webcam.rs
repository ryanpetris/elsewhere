//! VP8 decoding and fixed-format output to a selected V4L2 loopback camera.
use crate::Running;
use anyhow::{Context, Result, ensure};
use elsewhere_core::Bytes;
use ffmpeg_next as av;
use std::{ffi::CString, fs::OpenOptions, os::{fd::AsRawFd, unix::{ffi::OsStrExt, fs::OpenOptionsExt}},
    path::Path, sync::atomic::Ordering, time::Duration};
use tokio::sync::mpsc;

const WIDTH: u32 = 1280;
const HEIGHT: u32 = 720;

/// Decode each accepted compressed frame; device backpressure drops only decoded raw pictures.
pub fn video_sink(device: &Path, mut rx: mpsc::Receiver<Bytes>) -> Result<Running> {
    crate::init()?;
    let codec = av::decoder::find(av::codec::Id::VP8).context("FFmpeg VP8 decoder is unavailable")?;
    let mut context = av::codec::context::Context::new_with_codec(codec);
    // Browser input is untrusted. This bounds allocations before the decoder sees a frame header.
    unsafe { (*context.as_mut_ptr()).max_pixels = 4096 * 4096; }
    let mut decoder = context.decoder().video()?;
    let mut output = Camera::new(device)?;
    Running::spawn("webcam", move |stop| {
        let mut scaler = None;
        let mut waiting_key = true;
        let mut sequence = 0;
        while !stop.load(Ordering::Relaxed) {
            let bytes = match rx.try_recv() {
                Ok(bytes) => bytes,
                Err(mpsc::error::TryRecvError::Empty) => { std::thread::sleep(Duration::from_millis(5)); continue; }
                Err(mpsc::error::TryRecvError::Disconnected) => return Ok(()),
            };
            if bytes.is_empty() || bytes.len() > 16 * 1024 * 1024 { waiting_key = true; continue; }
            let key = bytes[0] & 1 == 0;
            if waiting_key && !key { continue; }
            if key && waiting_key { decoder.flush(); }
            if decoder.send_packet(&av::Packet::copy(&bytes)).is_err() { waiting_key = true; continue; }
            loop {
                let mut frame = av::frame::Video::empty();
                match decoder.receive_frame(&mut frame) {
                    Ok(()) => {
                        waiting_key = false;
                        let image = letterbox(&frame, &mut scaler)?;
                        let mut packet = av::Packet::copy(&image);
                        packet.set_stream(0);
                        packet.set_pts(Some(sequence));
                        packet.set_dts(Some(sequence));
                        sequence += 1;
                        match packet.write(&mut output.context) {
                            Ok(_) | Err(av::Error::Other { errno: av::error::EAGAIN }) => {}
                            Err(error) => return Err(error).context("write webcam frame"),
                        }
                    }
                    Err(av::Error::Other { errno: av::error::EAGAIN }) => break,
                    Err(_) => { waiting_key = true; break; }
                }
            }
        }
        Ok(())
    })
}

struct Camera { context: av::format::context::Output }

impl Camera {
    fn new(device: &Path) -> Result<Self> {
        let path = CString::new(device.as_os_str().as_bytes()).context("invalid webcam device path")?;
        let mut raw = std::ptr::null_mut();
        // libavdevice owns the nonblocking device FD. There is no AVIO file wrapper for NOFILE muxers.
        let result = unsafe { av::ffi::avformat_alloc_output_context2(&mut raw, std::ptr::null(), c"video4linux2".as_ptr(), path.as_ptr()) };
        if result < 0 { return Err(av::Error::from(result)).context("create webcam output"); }
        ensure!(!raw.is_null(), "FFmpeg did not allocate webcam output");
        let mut context = unsafe { av::format::context::Output::wrap(raw) };
        unsafe { (*context.as_mut_ptr()).flags |= av::ffi::AVFMT_FLAG_NONBLOCK; }
        {
            let mut stream = context.add_stream(av::encoder::find(av::codec::Id::RAWVIDEO))?;
            stream.set_time_base((1, 30));
            let mut parameters = stream.parameters();
            unsafe {
                let parameters = &mut *parameters.as_mut_ptr();
                parameters.codec_type = av::ffi::AVMediaType::AVMEDIA_TYPE_VIDEO;
                parameters.codec_id = av::ffi::AVCodecID::AV_CODEC_ID_RAWVIDEO;
                parameters.format = av::ffi::AVPixelFormat::AV_PIX_FMT_YUYV422 as i32;
                parameters.width = WIDTH as i32;
                parameters.height = HEIGHT as i32;
            }
        }
        context.write_header().context("open webcam device")?;
        let camera = Self { context };
        verify_format(device)?;
        Ok(camera)
    }
}

impl Drop for Camera {
    fn drop(&mut self) { let _ = self.context.write_trailer(); }
}

// Linux v4l2_format's union is 200 bytes and pointer-aligned. Query the actual format after
// libavdevice's S_FMT: the driver may have adjusted its requested geometry or stride.
#[repr(C)]
struct V4l2Format { kind: u32, format: V4l2FormatData }
#[repr(C)]
union V4l2FormatData { words: [u32; 50], align: *mut libc::c_void }

fn verify_format(device: &Path) -> Result<()> {
    let file = OpenOptions::new().read(true).write(true).custom_flags(libc::O_NONBLOCK).open(device).context("inspect webcam device")?;
    let mut format = V4l2Format { kind: 2, format: V4l2FormatData { words: [0; 50] } };
    let request = (3u64 << 30) | ((std::mem::size_of::<V4l2Format>() as u64) << 16) | ((b'V' as u64) << 8) | 4;
    let result = unsafe { libc::ioctl(file.as_raw_fd(), request as libc::c_ulong, &mut format) };
    if result < 0 { return Err(std::io::Error::last_os_error()).context("query webcam format"); }
    let words = unsafe { format.format.words };
    ensure!(words[0] == WIDTH && words[1] == HEIGHT && words[2] == u32::from_le_bytes(*b"YUYV")
        && words[4] == WIDTH * 2 && words[5] == WIDTH * HEIGHT * 2,
        "webcam device did not accept tightly packed 1280x720 YUYV422");
    Ok(())
}

fn letterbox(frame: &av::frame::Video, scaler: &mut Option<av::software::scaling::Context>) -> Result<Vec<u8>> {
    ensure!(frame.width() > 0 && frame.height() > 0, "empty webcam frame");
    let scale = (WIDTH as f64 / frame.width() as f64).min(HEIGHT as f64 / frame.height() as f64);
    let width = ((frame.width() as f64 * scale) as u32 & !1).max(2);
    let height = ((frame.height() as f64 * scale) as u32).max(1);
    let (x, y) = (((WIDTH - width) / 2) & !1, (HEIGHT - height) / 2);
    if !scaler.as_ref().is_some_and(|scaler| scaler.input().format == frame.format()
        && scaler.input().width == frame.width() && scaler.input().height == frame.height())
    {
        *scaler = Some(av::software::scaling::Context::get(frame.format(), frame.width(), frame.height(),
            av::format::Pixel::YUYV422, width, height, av::software::scaling::Flags::BILINEAR)?);
    }
    let mut scaled = av::frame::Video::empty();
    scaler.as_mut().unwrap().run(frame, &mut scaled)?;
    let mut output = vec![0; (WIDTH * HEIGHT * 2) as usize];
    for pair in output.chunks_exact_mut(4) { pair.copy_from_slice(&[16, 128, 16, 128]); }
    for row in 0..height as usize {
        let destination = ((y as usize + row) * WIDTH as usize + x as usize) * 2;
        let source = row * scaled.stride(0);
        output[destination..destination + width as usize * 2].copy_from_slice(&scaled.data(0)[source..source + width as usize * 2]);
    }
    Ok(output)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn webcam_letterbox_preserves_aspect_and_packed_stride() -> Result<()> {
        crate::init()?;
        let mut frame = av::frame::Video::new(av::format::Pixel::YUV420P, 640, 480);
        frame.data_mut(0).fill(180);
        frame.data_mut(1).fill(128);
        frame.data_mut(2).fill(128);
        let output = letterbox(&frame, &mut None)?;
        assert_eq!(output.len(), (WIDTH * HEIGHT * 2) as usize);
        assert_eq!(&output[..4], &[16, 128, 16, 128]);
        assert_eq!(&output[160 * 2..160 * 2 + 4], &[180, 128, 180, 128]);
        assert_eq!(&output[1120 * 2..1120 * 2 + 4], &[16, 128, 16, 128]);
        Ok(())
    }

    #[test]
    fn rejects_a_non_video_device_without_starting_a_worker() {
        let (tx, rx) = mpsc::channel(1);
        let error = match video_sink(Path::new("/dev/null"), rx) {
            Err(error) => error,
            Ok(_) => panic!("accepted a device without V4L2 output support"),
        };
        assert_eq!(error.to_string(), "open webcam device");
        assert!(tx.is_closed());
    }
}
