//! A static source for Docker broadcast integration checks. The output worker supplies idle cadence.
use std::{sync::Arc, time::{Duration, Instant}};
use anyhow::{Context, Result, ensure};
use elsewhere_core::{broadcast::{Audio, Start, State}, Frame, FrameBuffer};

fn main() -> Result<()> {
    if std::env::args().nth(1).as_deref() == Some("--broadcast-output-worker") { return elsewhere_stream::broadcast::output_worker(); }
    let mut args = std::env::args().skip(1);
    let url = args.next().context("usage: broadcast-source RTMP_URL SECONDS [PIPEWIRE_SOCKET]")?;
    let seconds = args.next().context("missing duration")?.parse::<f64>()?;
    let socket = args.next().map(Into::into);
    let settings = Start { request_id: "broadcast-check".into(), label: "broadcast-check".into(), url, stream_key: String::new(), width: 640, height: 360, fps: 30, bitrate_kbps: std::env::var("BROADCAST_TEST_BITRATE").ok().and_then(|v| v.parse().ok()).unwrap_or(800), audio: if socket.is_some() { Audio::Desktop } else { Audio::Silence }, cursor: true };
    let (mut sink, control) = elsewhere_stream::broadcast::start(settings, socket)?;
    let mut pixels = vec![0u8; 640 * 480 * 4];
    for y in 0..480 { for x in 0..640 {
        let i = (y * 640 + x) * 4;
        pixels[i] = if x < 213 { 240 } else { 16 };
        pixels[i + 1] = if (213..426).contains(&x) { 240 } else { 16 };
        pixels[i + 2] = if x >= 426 { 240 } else { 16 };
    } }
    let pixels: elsewhere_core::Bytes = pixels.into();
    sink.submit(Frame { width: 640, height: 480, fourcc: u32::from_le_bytes(*b"XR24"), pts: Duration::ZERO, seq: 1, refine: false, buffer: FrameBuffer::Memory { data: pixels.clone(), stride: 640 * 4 } }).map_err(|e| anyhow::anyhow!("{e}"))?;
    let start = Instant::now();
    let mut max_submit = Duration::ZERO;
    while start.elapsed().as_secs_f64() < seconds {
        let p = control.progress();
        println!("state={:?} frames={} bytes={} retries={}", p.state, p.frames, p.bytes, p.retries);
        if p.state.terminal() { break; }
        if std::env::var_os("BROADCAST_TEST_SUBMIT").is_some() {
            let before = Instant::now();
            sink.submit(Frame { width: 640, height: 480, fourcc: u32::from_le_bytes(*b"XR24"), pts: start.elapsed(), seq: 2, refine: false, buffer: FrameBuffer::Memory { data: pixels.clone(), stride: 640 * 4 } }).map_err(|e| anyhow::anyhow!("{e}"))?;
            max_submit = max_submit.max(before.elapsed());
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    control.stop(); drop(sink);
    let start = Instant::now();
    while !control.progress().state.terminal() && start.elapsed() < Duration::from_secs(3) { std::thread::sleep(Duration::from_millis(10)); }
    let p = control.progress();
    println!("stop_ms={} state={:?} frames={} bytes={} retries={}", start.elapsed().as_millis(), p.state, p.frames, p.bytes, p.retries);
    println!("max_submit_ms={}", max_submit.as_millis());
    ensure!(p.state == State::Stopped, "broadcast failed or stop deadline exceeded");
    ensure!(Arc::strong_count(&control) == 1, "broadcast retains its controller");
    Ok(())
}
