//! Independent RTMP outputs. CPU frames own their pixels and never retain compositor leases.
use std::{path::PathBuf, sync::{Arc, Mutex, atomic::{AtomicBool, Ordering}}, time::{Duration, Instant}};
use anyhow::{Context, Result};
use elsewhere_core::{broadcast::{self, Audio, Capabilities, Control, Progress, Start, State}, Bytes, CursorImage, Frame, FrameBuffer, FrameSink, OutputGeometry, SinkError, Submit};
use gstreamer as gst;
use gst::prelude::*;
use gstreamer_app as app;
use tokio::sync::watch;

#[derive(Clone)]
struct Picture { data: Bytes, width: u32, height: u32, cursor: Option<CursorImage>, x: f64, y: f64, scale: f64 }
struct Sink { tx: watch::Sender<Option<Picture>>, cursor: Option<CursorImage>, x: f64, y: f64, scale: f64, fps: u32, stopped: Arc<AtomicBool> }
impl FrameSink for Sink {
    fn wants_pixels(&self) -> bool { true }
    fn cadence(&self) -> Option<Duration> { (!self.stopped.load(Ordering::Relaxed)).then(|| Duration::from_secs_f64(1.0 / self.fps as f64)) }
    fn output_changed(&mut self, _: OutputGeometry, _: u32, _: u64) {}
    fn cursor(&mut self, image: Option<CursorImage>, x: f64, y: f64, scale: f64) { self.cursor = image; self.x = x; self.y = y; self.scale = scale; }
    fn submit(&mut self, frame: Frame) -> Result<Submit, SinkError> {
        if !self.stopped.load(Ordering::Relaxed) {
            if let FrameBuffer::Memory { data, .. } = frame.buffer {
                self.tx.send_replace(Some(Picture { data, width: frame.width, height: frame.height, cursor: self.cursor.clone(), x: self.x, y: self.y, scale: self.scale }));
            }
        }
        Ok(Submit::Encoded)
    }
}

struct Running { stopped: Arc<AtomicBool>, progress: Arc<Mutex<Progress>> }
impl Control for Running {
    fn progress(&self) -> Progress { self.progress.lock().unwrap().clone() }
    fn stop(&self) {
        self.stopped.store(true, Ordering::Relaxed);
        let mut p = self.progress.lock().unwrap();
        if !p.state.terminal() { p.state = State::Stopping; }
    }
}
impl Drop for Running { fn drop(&mut self) { self.stop(); } }

fn aac_encoder() -> Option<&'static str> { ["fdkaacenc", "voaacenc", "avenc_aac"].into_iter().find(|n| gst::ElementFactory::find(n).is_some()) }

pub fn capabilities(audio: bool) -> Capabilities {
    let available = gst::init().is_ok() && ["x264enc", "h264parse", "aacparse", "flvmux", "rtmp2sink", "videoconvertscale"].iter().all(|n| gst::ElementFactory::find(n).is_some()) && aac_encoder().is_some();
    Capabilities { available, desktop_audio: audio && gst::ElementFactory::find("pipewiresrc").is_some(), video_codec: "h264", audio_codec: "aac", max_outputs: 4, max_width: 3840, max_height: 2160, max_fps: 60, min_bitrate_kbps: 100, max_bitrate_kbps: 50000, error: (!available).then(|| "Broadcasting needs the GStreamer H.264, AAC and RTMP plugins.".into()) }
}

pub fn start(settings: Start, socket: Option<PathBuf>) -> Result<(Box<dyn FrameSink>, Arc<dyn broadcast::Control>)> {
    gst::init()?;
    let (tx, rx) = watch::channel(None);
    let stopped = Arc::new(AtomicBool::new(false));
    let progress = Arc::new(Mutex::new(Progress::default()));
    let control = Arc::new(Running { stopped: stopped.clone(), progress: progress.clone() });
    let sink = Sink { tx, cursor: None, x: 0.0, y: 0.0, scale: 1.0, fps: settings.fps, stopped: stopped.clone() };
    std::thread::Builder::new().name("broadcast".into()).spawn(move || {
        run(settings, socket, rx, &stopped, &progress);
        stopped.store(true, Ordering::Relaxed);
        let mut p = progress.lock().unwrap();
        if p.state != State::Failed { p.state = State::Stopped; }
    })?;
    Ok((Box::new(sink), control))
}

struct Pipeline { pipeline: gst::Pipeline, src: app::AppSrc, output: gst::Element, _connection: Option<std::os::unix::net::UnixStream> }
impl Drop for Pipeline { fn drop(&mut self) { let _ = self.pipeline.set_state(gst::State::Null); } }
fn pipeline(s: &Start, socket: Option<&PathBuf>) -> Result<Pipeline> {
    let audio = if s.audio == Audio::Silence { "audiotestsrc is-live=true wave=silence" } else { "pipewiresrc name=audio target-object=elsewhere-output stream-properties=\"properties,stream.capture.sink=(boolean)true,node.dont-fallback=(boolean)true\"" };
    let aac = aac_encoder().context("AAC encoder unavailable")?;
    let desc = format!(
        "appsrc name=video is-live=true format=time do-timestamp=true block=false max-buffers=1 leaky-type=downstream \
         ! videoconvertscale add-borders=true ! video/x-raw,format=I420,width={},height={},framerate={}/1,pixel-aspect-ratio=1/1 \
         ! x264enc tune=zerolatency speed-preset=veryfast bitrate={} key-int-max={} bframes=0 vbv-buf-capacity=1000 \
         ! h264parse config-interval=-1 ! video/x-h264,stream-format=avc,alignment=au \
         ! queue max-size-buffers=60 max-size-bytes=0 max-size-time=0 ! mux.video \
         {audio} ! audioconvert ! audioresample ! audio/x-raw,rate=44100,channels=2 \
         ! {aac} bitrate=128000 ! aacparse ! queue max-size-buffers=100 max-size-bytes=0 max-size-time=0 ! mux.audio \
         flvmux name=mux streamable=true ! rtmp2sink name=output timeout=5 sync=false",
        s.width, s.height, s.fps, s.bitrate_kbps, s.fps * 2);
    let pipeline = gst::parse::launch(&desc)?.downcast::<gst::Pipeline>().map_err(|_| anyhow::anyhow!("broadcast pipeline unavailable"))?;
    let src = pipeline.by_name("video").unwrap().downcast::<app::AppSrc>().unwrap();
    let output = pipeline.by_name("output").unwrap();
    // Connection strings are properties, never pipeline syntax or diagnostic text.
    let destination = if s.stream_key.is_empty() { s.url.clone() } else { format!("{}/{}", s.url.trim_end_matches('/'), s.stream_key) };
    output.set_property("location", destination);
    let connection = if s.audio == Audio::Desktop {
        use std::os::fd::AsRawFd;
        let connection = std::os::unix::net::UnixStream::connect(socket.context("desktop audio unavailable")?)?;
        pipeline.by_name("audio").unwrap().set_property("fd", connection.as_raw_fd());
        Some(connection)
    } else { None };
    let result = Pipeline { pipeline, src, output, _connection: connection };
    result.pipeline.set_state(gst::State::Playing)?;
    Ok(result)
}

fn run(settings: Start, socket: Option<PathBuf>, pictures: watch::Receiver<Option<Picture>>, stop: &AtomicBool, progress: &Mutex<Progress>) {
    let interval = Duration::from_secs_f64(1.0 / settings.fps as f64);
    let mut attempts = 0u32;
    while !stop.load(Ordering::Relaxed) {
        let pipe = match pipeline(&settings, socket.as_ref()) {
            Ok(p) => p,
            Err(_) => { let mut p = progress.lock().unwrap(); p.state = State::Failed; p.error = Some("Could not initialize the broadcast encoder or audio source.".into()); return; }
        };
        let bus = pipe.pipeline.bus().unwrap();
        let mut size = (0, 0);
        let mut next = Instant::now();
        let mut last_bytes = 0;
        let mut last_output = Instant::now();
        let mut failed_audio = false;
        let mut failed_encoder = false;
        let mut failed_network = false;
        loop {
            if stop.load(Ordering::Relaxed) { break; }
            let mut failed = false;
            for message in bus.iter() {
                match message.view() {
                    gst::MessageView::Error(e) => {
                        let name = e.src().map(|o| o.name().to_string()).unwrap_or_default();
                        failed_audio |= name == "audio";
                        failed_network |= name == "output";
                        failed_encoder |= name != "output" && name != "audio";
                        failed = true;
                    }
                    gst::MessageView::Eos(_) => failed = true,
                    _ => {}
                }
            }
            if failed || last_output.elapsed() > Duration::from_secs(15) { break; }
            if Instant::now() >= next {
                let picture = pictures.borrow().clone();
                if let Some(picture) = picture {
                    if size != (picture.width, picture.height) {
                        size = (picture.width, picture.height);
                        pipe.src.set_caps(Some(&gst::Caps::builder("video/x-raw").field("format", "BGRx").field("width", size.0 as i32).field("height", size.1 as i32).field("framerate", gst::Fraction::new(settings.fps as i32, 1)).field("pixel-aspect-ratio", gst::Fraction::new(1, 1)).build()));
                    }
                    let bytes = if settings.cursor { blend_cursor(&picture) } else { picture.data.clone() };
                    let mut buffer = gst::Buffer::from_mut_slice(bytes.to_vec());
                    buffer.get_mut().unwrap().set_duration(gst::ClockTime::from_nseconds(interval.as_nanos() as u64));
                    if pipe.src.push_buffer(buffer).is_err() { break; }
                    progress.lock().unwrap().frames += 1;
                }
                next += interval;
                if next < Instant::now() { next = Instant::now() + interval; }
                let stats = pipe.output.property::<gst::Structure>("stats");
                let bytes = stats.get::<u64>("out-bytes-total").unwrap_or(0);
                if bytes > last_bytes {
                    last_output = Instant::now();
                    let mut p = progress.lock().unwrap();
                    p.bytes += bytes - last_bytes;
                    // Handshake bytes alone do not mean the media is being sent.
                    if bytes > 8192 && p.state != State::Stopping { p.state = State::Sending; p.error = None; }
                    last_bytes = bytes;
                }
            }
            std::thread::sleep(next.saturating_duration_since(Instant::now()).min(Duration::from_millis(5)));
        }
        drop(pipe);
        if stop.load(Ordering::Relaxed) { break; }
        if failed_audio || (failed_encoder && !failed_network) {
            let mut p = progress.lock().unwrap(); p.state = State::Failed;
            p.error = Some(if failed_audio { "Desktop audio became unavailable." } else { "Broadcast encoding failed." }.into());
            return;
        }
        attempts += 1;
        { let mut p = progress.lock().unwrap(); if p.state != State::Stopping { p.state = State::Reconnecting; } p.retries = attempts; p.error = Some("Destination disconnected or timed out. Check the address, key and network.".into()); }
        let until = Instant::now() + Duration::from_secs(1u64 << attempts.min(5));
        while !stop.load(Ordering::Relaxed) && Instant::now() < until { std::thread::sleep(Duration::from_millis(25)); }
    }
}

fn blend_cursor(p: &Picture) -> Bytes {
    let Some(c) = &p.cursor else { return p.data.clone(); };
    let mut data = p.data.to_vec();
    let w = (c.logical_w as f64 * p.scale).round().max(1.0) as usize;
    let h = (c.logical_h as f64 * p.scale).round().max(1.0) as usize;
    let left = ((p.x - c.hot_x as f64) * p.scale).round() as i64;
    let top = ((p.y - c.hot_y as f64) * p.scale).round() as i64;
    for y in (-top).max(0) as usize..h.min((p.height as i64 - top).max(0) as usize) {
        let dy = top + y as i64;
        if dy < 0 || dy >= p.height as i64 { continue; }
        for x in (-left).max(0) as usize..w.min((p.width as i64 - left).max(0) as usize) {
            let dx = left + x as i64;
            if dx < 0 || dx >= p.width as i64 { continue; }
            let src = ((y * c.height as usize / h) * c.width as usize + x * c.width as usize / w) * 4;
            if src + 3 >= c.rgba.len() { continue; }
            let dst = (dy as usize * p.width as usize + dx as usize) * 4;
            let a = c.rgba[src + 3] as u32;
            for (d, s) in [(0, 2), (1, 1), (2, 0)] { data[dst+d] = ((c.rgba[src+s] as u32 * a + data[dst+d] as u32 * (255-a) + 127) / 255) as u8; }
        }
    }
    data.into()
}
