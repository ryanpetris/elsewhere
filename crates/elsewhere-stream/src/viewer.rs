//! One bounded encoder worker per desktop or window viewer.
use std::{sync::{Arc, Condvar, Mutex, Weak, atomic::{AtomicU32, Ordering}}, time::{Duration, Instant}};
use anyhow::{Context, Result, ensure};
use elsewhere_core::{Bytes, Codec, EffortState, EncodingEffort, EncodedFrame, Frame, FrameBuffer, FrameSink, OutputGeometry, Quality, SinkError, StreamControl, StreamInfo, StreamMsg, Submit};
use tokio::sync::{Notify, mpsc};
use crate::encoder::{Encoders, SoftwareConverter, VideoEncoder};

static STREAM_SEQ: AtomicU32 = AtomicU32::new(1);
type Redraw = Arc<dyn Fn() + Send + Sync>;

#[derive(Clone, Copy, Debug, PartialEq)]
struct Source { geometry: OutputGeometry, fourcc: u32, modifier: u64 }
#[derive(Clone, Copy, Debug, PartialEq)]
struct Settings { source: Option<Source>, size: Option<(u32, u32)>, codec: Codec, quality: Quality, effort: EncodingEffort }
struct Pending { frame: Frame, source: Source, submitted: Instant }
struct State {
    settings: Settings,
    epoch: u64,
    pending: Option<Pending>,
    last_submit: Option<Instant>,
    ready: bool,
    started: bool,
    pressure: bool,
    failed: bool,
    stop: bool,
    paused: bool,
    keyframe: bool,
    effort: EffortState,
}
impl State {
    fn restart(&mut self) -> Option<Pending> {
        self.epoch = self.epoch.wrapping_add(1);
        let pending = self.pending.take();
        self.ready = false;
        self.started = false;
        self.failed = false;
        self.pressure = false;
        self.effort = EffortState::pending(self.settings.effort);
        pending
    }
}
struct Shared { state: Mutex<State>, changed: Condvar, control: Notify }
struct Owner { shared: Arc<Shared> }
impl Drop for Owner {
    fn drop(&mut self) {
        let mut state = self.shared.state.lock().unwrap_or_else(|e| e.into_inner());
        state.stop = true;
        let pending = state.pending.take();
        drop(state);
        drop(pending);
        self.shared.changed.notify_one();
        self.shared.control.notify_one();
    }
}

#[derive(Clone)]
pub struct FfmpegSink { owner: Arc<Owner> }
pub struct FfmpegControl { owner: Weak<Owner> }

impl FfmpegSink {
    pub fn new(bitrate_kbps: u32, encoders: Arc<Encoders>, tx: mpsc::Sender<StreamMsg>, redraw: Redraw) -> Result<Self> {
        crate::init()?;
        ensure!(tx.max_capacity() >= 2, "video channel must fit stream configuration and keyframe");
        let codec = *encoders.codecs().first().context("no video encoder")?;
        let shared = Arc::new(Shared {
            state: Mutex::new(State {
                settings: Settings { source: None, size: None, codec, quality: Quality { bitrate_kbps, max_fps: 0 }, effort: EncodingEffort::Fast },
                epoch: 0, pending: None, last_submit: None, ready: false, started: false, pressure: false, failed: false, stop: false, paused: false, keyframe: true,
                effort: EffortState::pending(EncodingEffort::Fast),
            }),
            changed: Condvar::new(), control: Notify::new(),
        });
        let runtime = tokio::runtime::Builder::new_current_thread().enable_time().build()?;
        let worker = shared.clone();
        std::thread::Builder::new().name("video-encoder".into()).spawn(move || {
            if let Err(error) = run(&worker, &encoders, &tx, &redraw, &runtime) {
                tracing::error!(%error, "video worker stopped");
            }
        })?;
        Ok(Self { owner: Arc::new(Owner { shared }) })
    }
    pub fn control(&self) -> FfmpegControl { FfmpegControl { owner: Arc::downgrade(&self.owner) } }
}

impl FfmpegControl {
    fn update(&self, update: impl FnOnce(&mut State) -> Option<Pending>) {
        let Some(owner) = self.owner.upgrade() else { return };
        let shared = &owner.shared;
        let mut state = shared.state.lock().unwrap_or_else(|e| e.into_inner());
        let epoch = state.epoch;
        let pending = update(&mut state);
        let restarted = epoch != state.epoch;
        drop(state);
        drop(pending);
        shared.changed.notify_one();
        if restarted { shared.control.notify_one(); }
    }
}
impl StreamControl for FfmpegControl {
    fn request_keyframe(&self) { self.update(|s| { s.keyframe = true; None }); }
    fn set_codec(&self, codec: Codec) { self.update(|s| { s.settings.codec = codec; s.paused = false; s.restart() }); }
    fn epoch(&self) -> u64 { self.owner.upgrade().map_or(u64::MAX, |o| o.shared.state.lock().unwrap_or_else(|e| e.into_inner()).epoch) }
    fn pause(&self) { self.update(|s| { s.paused = true; s.restart() }); }
    fn set_size(&self, size: Option<(u32, u32)>) { self.update(|s| { if s.settings.size != size { s.settings.size = size; s.restart() } else { None } }); }
    fn set_effort(&self, effort: EncodingEffort) { self.update(|s| { if s.settings.effort != effort { s.settings.effort = effort; s.restart() } else { None } }); }
    fn set_quality(&self, quality: Quality) {
        self.update(|s| {
            let reopen = quality.bitrate_kbps != s.settings.quality.bitrate_kbps && s.effort.encoder.as_deref() != Some("libx264");
            s.settings.quality = quality;
            if reopen { s.restart() } else { None }
        });
    }
    fn effort(&self) -> EffortState {
        self.owner.upgrade().map(|owner| owner.shared.state.lock().unwrap_or_else(|e| e.into_inner()).effort.clone()).unwrap_or_else(|| EffortState::pending(EncodingEffort::Fast))
    }
}

impl FrameSink for FfmpegSink {
    fn output_changed(&mut self, geometry: OutputGeometry, fourcc: u32, modifier: u64) {
        self.control().update(|s| {
            let source = Some(Source { geometry, fourcc, modifier });
            if s.settings.source != source { s.settings.source = source; s.restart() } else { None }
        });
    }
    fn submit(&mut self, frame: Frame) -> Result<Submit, SinkError> {
        let shared = &self.owner.shared;
        let mut state = match shared.state.try_lock() {
            Ok(state) => state,
            Err(std::sync::TryLockError::WouldBlock) => return Ok(Submit::Held),
            Err(std::sync::TryLockError::Poisoned(error)) => error.into_inner(),
        };
        if state.stop || !state.ready || state.pressure { return Ok(Submit::Deferred); }
        let Some(source) = state.settings.source else { return Ok(Submit::Deferred) };
        if source.geometry.width_px != frame.width || source.geometry.height_px != frame.height || source.fourcc != frame.fourcc ||
            matches!(&frame.buffer, FrameBuffer::Dmabuf { modifier, .. } if *modifier != source.modifier) {
            return Ok(Submit::Held);
        }
        let now = Instant::now();
        let fps = state.settings.quality.max_fps;
        if !frame.refine && fps > 0 && let Some(last) = state.last_submit {
            let due = last + Duration::from_micros(900_000 / fps as u64);
            if now < due { return Ok(Submit::RetryAt(due)); }
        }
        state.last_submit = Some(now);
        let replaced = state.pending.replace(Pending { frame, source, submitted: now });
        let result = if state.started { Submit::Encoded } else { Submit::Held };
        drop(state);
        drop(replaced);
        shared.changed.notify_one();
        Ok(result)
    }
}

enum Converter { Software(SoftwareConverter), Hardware(crate::gpu::Converter) }
struct Active { encoder: VideoEncoder, converter: Converter, settings: Settings, epoch: u64, info: Option<StreamInfo>, stream_id: u32 }

/// Accumulate delivered bytes with one codec-buffer period of burst allowance. Excess waits for
/// its budget without retaining a compositor buffer; variable packet sizes can share the allowance.
struct Admission { due: Instant, kbps: u32 }
impl Admission {
    fn new(kbps: u32) -> Self { Self { due: Instant::now(), kbps: kbps.max(1) } }
    fn set_rate(&mut self, kbps: u32, now: Instant) {
        let kbps = kbps.max(1);
        if kbps != self.kbps {
            let remaining = self.due.saturating_duration_since(now);
            self.due = now + remaining.mul_f64(f64::from(self.kbps) / f64::from(kbps));
            self.kbps = kbps;
        }
    }
    fn delay(&self, now: Instant) -> Duration {
        self.due.saturating_duration_since(now + Duration::from_millis(crate::encoder::BUFFER_MS.into()))
    }
    fn delivered(&mut self, bytes: usize, started: Instant, encoding: Duration, now: Instant) {
        let cost = Duration::from_secs_f64(bytes as f64 * 8.0 / (f64::from(self.kbps) * 1000.0));
        let unpaid = self.due.saturating_duration_since(started);
        // Preserve existing debt. Encoding pays it down; blocked output does not earn new credit.
        self.due = now + (unpaid + cost).saturating_sub(encoding);
    }
}

impl Active {
    fn open(settings: Settings, epoch: u64, encoders: &Encoders) -> Result<Self> {
        let source = settings.source.context("missing video source")?;
        let source_size = (source.geometry.width_px, source.geometry.height_px);
        let size = settings.size.unwrap_or(source_size);
        let converter = match encoders.node.as_deref() {
            Some(node) => Converter::Hardware(crate::gpu::Converter::new(node, source_size.0, source_size.1, source.fourcc, source.modifier, size)?),
            None => Converter::Software(SoftwareConverter::new(source_size.0, source_size.1, source.fourcc, size)?),
        };
        let frames = match &converter { Converter::Hardware(gpu) => gpu.hw_frames_ctx(), Converter::Software(_) => std::ptr::null_mut() };
        let encoder = VideoEncoder::open(encoders.choice(settings.codec)?, size, (source.geometry.refresh_mhz / 1000).max(1) as u32, settings.quality, settings.effort, frames)?;
        let stream_id = STREAM_SEQ.fetch_add(1, Ordering::Relaxed);
        let scale = source.geometry.scale * size.0 as f64 / source_size.0 as f64;
        Ok(Self { encoder, converter, settings, epoch, stream_id, info: Some(StreamInfo { stream_id, codec: String::new(), width: size.0, height: size.1, scale }) })
    }
}

fn run(shared: &Shared, encoders: &Encoders, tx: &mpsc::Sender<StreamMsg>, redraw: &Redraw, runtime: &tokio::runtime::Runtime) -> Result<()> {
    let mut active: Option<Active> = None;
    let mut admission = Admission::new(shared.state.lock().unwrap_or_else(|e| e.into_inner()).settings.quality.bitrate_kbps);
    loop {
        let (settings, epoch) = {
            let mut state = shared.state.lock().unwrap_or_else(|e| e.into_inner());
            loop {
                if state.stop || tx.is_closed() { return Ok(()); }
                if state.settings.source.is_some() && !state.paused && !state.failed && (active.as_ref().is_none_or(|a| a.epoch != state.epoch || a.settings.quality != state.settings.quality) || state.pending.is_some()) { break; }
                state = shared.changed.wait_timeout(state, Duration::from_millis(100)).unwrap_or_else(|e| e.into_inner()).0;
            }
            (state.settings, state.epoch)
        };
        admission.set_rate(settings.quality.bitrate_kbps, Instant::now());
        if active.as_ref().is_none_or(|a| a.epoch != epoch) {
            active = None;
            let opening = Instant::now();
            let result = Active::open(settings, epoch, encoders);
            tracing::debug!(epoch, codec = ?settings.codec, open_us = opening.elapsed().as_micros() as u64,
                success = result.is_ok(), stream_id = result.as_ref().map_or(0, |a| a.stream_id), "ffmpeg encoder open");
            let mut state = shared.state.lock().unwrap_or_else(|e| e.into_inner());
            if state.stop { return Ok(()); }
            if state.epoch != epoch { continue; }
            match result {
                Ok(opened) => {
                    state.ready = true;
                    state.keyframe = true;
                    state.effort = opened.encoder.effort.clone();
                    active = Some(opened);
                    drop(state);
                    redraw();
                }
                Err(error) => {
                    state.failed = true;
                    state.ready = false;
                    let pending = state.pending.take();
                    drop(state);
                    drop(pending);
                    tracing::warn!(codec = ?settings.codec, %error, "video encoder initialization failed");
                    if !deliver(shared, tx, vec![StreamMsg::Failed(epoch)], epoch, false, redraw, runtime)? { continue; }
                }
            }
            continue;
        }
        let running = active.as_mut().unwrap();
        if running.settings.quality != settings.quality {
            if running.settings.quality.bitrate_kbps != settings.quality.bitrate_kbps {
                if let Err(error) = running.encoder.set_rate(settings.quality.bitrate_kbps) {
                    active = None;
                    report_failure(shared, tx, epoch, &error, redraw, runtime)?;
                    continue;
                }
                redraw();
            }
            running.settings.quality = settings.quality;
        }
        let next = {
            let mut state = shared.state.lock().unwrap_or_else(|e| e.into_inner());
            if state.epoch != epoch || !state.ready { continue; }
            if state.pending.is_some() && !admission.delay(Instant::now()).is_zero() {
                state.pressure = true;
                let pending = state.pending.take();
                drop(state);
                drop(pending);
                wait_for_admission(shared, tx, epoch, &mut admission, redraw);
                continue;
            }
            state.pending.take().map(|frame| (frame, std::mem::take(&mut state.keyframe)))
        };
        let Some((pending, requested_key)) = next else { continue };
        if Some(pending.source) != settings.source { redraw(); continue; }
        let started = Instant::now();
        let seq = pending.frame.seq;
        let pts_us = u64::try_from(pending.frame.pts.as_micros()).context("video timestamp overflow")?;
        let result = (|| -> Result<Vec<StreamMsg>> {
            let frame = match &mut running.converter {
                Converter::Software(converter) => converter.convert(pending.frame)?,
                Converter::Hardware(converter) => converter.convert(pending.frame)?,
            };
            let packets = running.encoder.encode(frame, requested_key || running.info.is_some())?;
            let mut messages = Vec::new();
            for packet in packets {
                let keyframe = packet.is_key();
                let data = packet.data().context("empty video packet")?;
                if let Some(mut info) = running.info.take() {
                    ensure!(keyframe, "first video packet is not a recovery keyframe");
                    info.codec = crate::codec_string(settings.codec, data, info.width, info.height).context("recovery keyframe lacks codec headers")?;
                    tracing::info!(codec = %info.codec, width = info.width, height = info.height, "stream started");
                    messages.push(StreamMsg::Info(epoch, info));
                }
                let packet_pts = packet.pts().and_then(|pts| u64::try_from(pts).ok()).context("invalid encoded video timestamp")?;
                messages.push(StreamMsg::Frame(epoch, EncodedFrame { stream_id: running.stream_id, keyframe, pts_us: packet_pts, data: Bytes::copy_from_slice(data) }));
                tracing::debug!(stream_id = running.stream_id, seq, pts_us, keyframe, bytes = data.len(), encode_us = started.elapsed().as_micros() as u64, submit_to_packet_us = pending.submitted.elapsed().as_micros() as u64, "ffmpeg encoded");
            }
            Ok(messages)
        })();
        match result {
            Ok(messages) => {
                let key = messages.iter().any(|m| matches!(m, StreamMsg::Frame(_, f) if f.keyframe));
                let bytes = messages.iter().map(|m| match m { StreamMsg::Frame(_, f) => f.data.len(), _ => 0 }).sum();
                let encoding = started.elapsed();
                if deliver(shared, tx, messages, epoch, key, redraw, runtime)? {
                    admission.delivered(bytes, started, encoding, Instant::now());
                }
            }
            Err(error) => {
                active = None;
                report_failure(shared, tx, epoch, &error, redraw, runtime)?;
            }
        }
    }
}

fn report_failure(shared: &Shared, tx: &mpsc::Sender<StreamMsg>, epoch: u64, error: &anyhow::Error, redraw: &Redraw, runtime: &tokio::runtime::Runtime) -> Result<()> {
    let mut state = shared.state.lock().unwrap_or_else(|e| e.into_inner());
    if state.epoch != epoch { return Ok(()); }
    state.failed = true;
    state.ready = false;
    let pending = state.pending.take();
    drop(state);
    drop(pending);
    tracing::warn!(%error, "video encoding failed");
    deliver(shared, tx, vec![StreamMsg::Failed(epoch)], epoch, false, redraw, runtime)?;
    Ok(())
}

/// Request a complete redraw after the discarded raw picture's byte budget becomes available.
fn wait_for_admission(shared: &Shared, tx: &mpsc::Sender<StreamMsg>, epoch: u64, admission: &mut Admission, redraw: &Redraw) {
    let mut state = shared.state.lock().unwrap_or_else(|e| e.into_inner());
    loop {
        if state.stop || state.epoch != epoch || tx.is_closed() { return; }
        let now = Instant::now();
        admission.set_rate(state.settings.quality.bitrate_kbps, now);
        let delay = admission.delay(now);
        if delay.is_zero() {
            state.pressure = false;
            drop(state);
            redraw();
            return;
        }
        state.pressure = true;
        if let Some(pending) = state.pending.take() {
            drop(state);
            drop(pending);
            state = shared.state.lock().unwrap_or_else(|e| e.into_inner());
            continue;
        }
        state = shared.changed.wait_timeout(state, delay.min(Duration::from_millis(100))).unwrap_or_else(|e| e.into_inner()).0;
    }
}

fn deliver(shared: &Shared, tx: &mpsc::Sender<StreamMsg>, messages: Vec<StreamMsg>, epoch: u64, keyframe: bool, redraw: &Redraw, runtime: &tokio::runtime::Runtime) -> Result<bool> {
    let count = messages.len();
    ensure!(count > 0 && count <= 2, "unexpected video output batch");
    let permits = loop {
        {
            let state = shared.state.lock().unwrap_or_else(|e| e.into_inner());
            if state.stop || state.epoch != epoch { return Ok(false); }
        }
        match tx.try_reserve_many(count) {
            Ok(permits) => break permits,
            Err(mpsc::error::TrySendError::Closed(_)) => return Ok(false),
            Err(mpsc::error::TrySendError::Full(_)) => {}
        }
        let pending = {
            let mut state = shared.state.lock().unwrap_or_else(|e| e.into_inner());
            if state.stop || state.epoch != epoch { return Ok(false); }
            state.pressure = true;
            state.pending.take()
        };
        drop(pending);
        let reserved = runtime.block_on(async {
            tokio::select! {
                biased;
                _ = shared.control.notified() => None,
                permits = tx.reserve_many(count) => Some(permits),
            }
        });
        match reserved {
            Some(Ok(permits)) => break permits,
            Some(Err(_)) => return Ok(false),
            None => continue,
        }
    };
    let mut state = shared.state.lock().unwrap_or_else(|e| e.into_inner());
    if state.stop || state.epoch != epoch { return Ok(false); }
    // Reserve both messages together so configuration cannot be separated from its first keyframe.
    for (permit, message) in permits.zip(messages) { permit.send(message); }
    if keyframe { state.started = true; state.effort.pending = false; }
    let resumed = std::mem::take(&mut state.pressure);
    drop(state);
    if resumed { redraw(); }
    Ok(true)
}

/// CPU encoders can only map the compositor's packed, linear RGB allocations.
pub fn validate_software_frame(frame: Frame) -> Result<()> {
    let mut converter = SoftwareConverter::new(frame.width, frame.height, frame.fourcc, (frame.width, frame.height))?;
    converter.convert(frame)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{OnceLock, atomic::{AtomicUsize, Ordering}};

    #[test]
    fn admission_preserves_unpaid_bytes_and_credits_only_encoding() {
        let now = Instant::now();
        let mut budget = Admission { due: now, kbps: 8000 };
        // A 100 KB packet needs 100 ms; 20 ms of conversion/encoding already elapsed.
        budget.delivered(100_000, now, Duration::from_millis(20), now + Duration::from_millis(20));
        assert!(budget.delay(now + Duration::from_millis(20)).is_zero());
        budget.set_rate(4000, now + Duration::from_millis(40));
        assert_eq!(budget.delay(now + Duration::from_millis(40)), Duration::from_millis(20));
        budget.set_rate(8000, now + Duration::from_millis(60));
        assert_eq!(budget.due.duration_since(now + Duration::from_millis(60)), Duration::from_millis(50));
        // Existing debt survives a blocked delivery; only the ten milliseconds of encoding pays it.
        let delivered = now + Duration::from_secs(10);
        budget.delivered(100_000, now + Duration::from_millis(70), Duration::from_millis(10), delivered);
        assert_eq!(budget.delay(delivered), Duration::from_millis(30));
        // Idle time cannot accumulate more than the fixed allowance.
        let later = delivered + Duration::from_secs(10);
        budget.delivered(200_000, later, Duration::from_millis(20), later + Duration::from_millis(20));
        assert_eq!(budget.delay(later + Duration::from_millis(20)), Duration::from_millis(80));
    }

    #[test]
    fn admission_smooths_variable_frames_but_bounds_sustained_excess() {
        let now = Instant::now();
        let mut budget = Admission { due: now, kbps: 8000 };
        for frame in 0..300 {
            let started = now + Duration::from_millis(frame * 33);
            assert!(budget.delay(started).is_zero(), "ordinary packet variation skipped frame {frame}");
            let bytes = if frame % 2 == 0 { 10_000 } else { 50_000 };
            budget.delivered(bytes, started, Duration::from_millis(5), started + Duration::from_millis(5));
        }
        let mut budget = Admission { due: now, kbps: 8000 };
        for frame in 0..10 {
            let started = now + Duration::from_millis(frame * 33);
            if !budget.delay(started).is_zero() { return; }
            budget.delivered(60_000, started, Duration::from_millis(5), started + Duration::from_millis(5));
        }
        panic!("sustained excess must exhaust the burst allowance");
    }

    #[test]
    fn admission_wait_releases_input_and_preserves_controls_on_cancellation() {
        let source = Source { geometry: source(), fourcc: u32::from_le_bytes(*b"XR24"), modifier: 0 };
        struct Lease(Arc<AtomicUsize>);
        impl Drop for Lease { fn drop(&mut self) { self.0.fetch_add(1, Ordering::Relaxed); } }
        let released = Arc::new(AtomicUsize::new(0));
        let input = |seq| {
            let mut frame = frame(seq);
            frame.buffer = FrameBuffer::Dmabuf {
                fd: std::fs::File::open("/dev/null").unwrap().into(), modifier: 0, stride: 1280,
                offset: 0, slot_id: 1, lease: Box::new(Lease(released.clone())),
            };
            Pending { frame, source, submitted: Instant::now() }
        };
        let shared = Arc::new(Shared {
            state: Mutex::new(State {
                settings: Settings { source: Some(source), size: None, codec: Codec::Vp8,
                    quality: Quality { bitrate_kbps: 1000, max_fps: 0 }, effort: EncodingEffort::Fast },
                epoch: 1, pending: Some(input(1)),
                last_submit: None, ready: true, started: true, pressure: false, failed: false,
                stop: false, paused: false, keyframe: false, effort: EffortState::pending(EncodingEffort::Fast),
            }),
            changed: Condvar::new(), control: Notify::new(),
        });
        let redraws = Arc::new(AtomicUsize::new(0));
        let signal = redraws.clone();
        let redraw: Redraw = Arc::new(move || { signal.fetch_add(1, Ordering::Relaxed); });
        let (tx, rx) = mpsc::channel(2);
        let spawn_wait = |epoch, mut admission: Admission| {
            let (shared, tx, redraw) = (shared.clone(), tx.clone(), redraw.clone());
            std::thread::spawn(move || {
                wait_for_admission(&shared, &tx, epoch, &mut admission, &redraw);
                admission
            })
        };
        let worker = spawn_wait(1, Admission { due: Instant::now() + Duration::from_secs(80), kbps: 1000 });
        wait(|| { let state = shared.state.lock().unwrap(); state.pressure && state.pending.is_none() && released.load(Ordering::Relaxed) == 1 });
        {
            let mut state = shared.state.lock().unwrap();
            state.keyframe = true;
            state.settings.quality.bitrate_kbps = 8000;
            // Observe the waiter's next iteration, which must apply this rate before cancellation.
            state.pressure = false;
        }
        shared.changed.notify_one();
        wait(|| shared.state.lock().unwrap().pressure);
        let canceled = Instant::now();
        let pending = shared.state.lock().unwrap().restart();
        drop(pending);
        shared.changed.notify_one();
        let admission = worker.join().unwrap();
        assert!(canceled.elapsed() < Duration::from_millis(500));
        assert_eq!(admission.kbps, 8000);
        assert!(admission.delay(Instant::now()) > Duration::from_secs(5));
        assert!(admission.delay(Instant::now()) <= Duration::from_secs(10));
        {
            let mut state = shared.state.lock().unwrap();
            assert!(state.keyframe, "admission must not consume the pending recovery request");
            state.ready = true;
            state.pending = Some(input(2));
        }
        let worker = spawn_wait(2, admission);
        wait(|| { let state = shared.state.lock().unwrap(); state.pressure && state.pending.is_none() && released.load(Ordering::Relaxed) == 2 });
        let closed = Instant::now();
        drop(rx);
        let admission = worker.join().unwrap();
        assert!(closed.elapsed() < Duration::from_millis(500));
        assert!(admission.delay(Instant::now()) > Duration::from_secs(5));
        assert!(shared.state.lock().unwrap().keyframe);
        assert_eq!(released.load(Ordering::Relaxed), 2);
        assert_eq!(redraws.load(Ordering::Relaxed), 0, "canceled waits must not redraw");
    }

    fn encoders() -> Arc<Encoders> {
        static ENCODERS: OnceLock<Arc<Encoders>> = OnceLock::new();
        ENCODERS.get_or_init(|| {
            let encoders = Encoders::probe(None, &[Codec::H264, Codec::Hevc, Codec::Av1, Codec::Vp9, Codec::Vp8]).unwrap();
            for (codec, libraries) in [
                (Codec::H264, &["libx264", "libopenh264"][..]),
                (Codec::Hevc, &["libx265"][..]),
                (Codec::Vp8, &["libvpx"][..]),
                (Codec::Vp9, &["libvpx-vp9"][..]),
                (Codec::Av1, &["libaom-av1"][..]),
            ] {
                if libraries.iter().any(|name| ffmpeg_next::encoder::find_by_name(name).is_some()) {
                    assert!(encoders.codecs().contains(&codec), "installed software codec {codec:?} failed its capability probe");
                }
            }
            encoders
        }).clone()
    }
    fn source() -> OutputGeometry { OutputGeometry { width_px: 320, height_px: 180, scale: 1.0, refresh_mhz: 30_000 } }
    fn frame(seq: u64) -> Frame {
        let mut data = vec![0; 320 * 180 * 4];
        for (i, pixel) in data.chunks_exact_mut(4).enumerate() { pixel.copy_from_slice(&[(i % 255) as u8, (seq % 255) as u8, 180, 255]); }
        Frame { width: 320, height: 180, fourcc: u32::from_le_bytes(*b"XR24"), pts: Duration::from_micros(seq * 33_333), seq, refine: false, buffer: FrameBuffer::Memory { data: data.into(), stride: 320 * 4 } }
    }
    fn wait(mut condition: impl FnMut() -> bool) {
        let until = Instant::now() + Duration::from_secs(10);
        while !condition() { assert!(Instant::now() < until, "video worker condition timed out"); std::thread::sleep(Duration::from_millis(2)); }
    }
    fn submit(sink: &mut FfmpegSink, seq: u64) -> Submit {
        let previous = sink.owner.shared.state.lock().unwrap().last_submit;
        let mut result = None;
        wait(|| {
            let submitted = sink.submit(frame(seq)).unwrap();
            if sink.owner.shared.state.lock().unwrap().last_submit != previous { result = Some(submitted); }
            result.is_some()
        });
        result.unwrap()
    }
    fn receive(rx: &mut mpsc::Receiver<StreamMsg>, info: &mut Option<StreamInfo>, sink: &mut FfmpegSink, seq: u64, redraws: &AtomicUsize, seen: &mut usize) -> EncodedFrame {
        let mut result = None;
        wait(|| {
            while let Ok(message) = rx.try_recv() {
                match message {
                    StreamMsg::Info(_, value) => *info = Some(value),
                    StreamMsg::Frame(_, frame) if frame.pts_us == seq * 33_333 => { result = Some(frame); return true; }
                    StreamMsg::Frame(_, _) => {} // Already queued pictures remain in reference order.
                    StreamMsg::Failed(_) => panic!("video encoder failed"),
                    _ => panic!("unexpected audio on video channel"),
                }
            }
            let requested = redraws.load(Ordering::Relaxed);
            if requested != *seen {
                *seen = requested;
                submit(sink, seq); // The source changes only when the test changes seq.
            }
            false
        });
        result.unwrap()
    }
    fn decode(codec: Codec, frame: &EncodedFrame, size: (u32, u32)) {
        use ffmpeg_next as ffmpeg;
        let id = match codec { Codec::H264 => ffmpeg::codec::Id::H264, Codec::Hevc => ffmpeg::codec::Id::HEVC, Codec::Vp8 => ffmpeg::codec::Id::VP8, Codec::Vp9 => ffmpeg::codec::Id::VP9, Codec::Av1 => ffmpeg::codec::Id::AV1 };
        let codec = ffmpeg::decoder::find(id).unwrap();
        let mut decoder = ffmpeg::codec::Context::new_with_codec(codec).decoder().video().unwrap();
        decoder.send_packet(&ffmpeg::Packet::copy(&frame.data)).unwrap();
        decoder.send_eof().unwrap();
        let mut decoded = ffmpeg::frame::Video::empty();
        decoder.receive_frame(&mut decoded).unwrap();
        assert_eq!((decoded.width(), decoded.height()), size);
    }

    #[test]
    fn software_keys_reopen_controls_and_static_final_frame() {
        let available = encoders();
        for codec in available.codecs() {
            let redraws = Arc::new(AtomicUsize::new(0));
            let signal = redraws.clone();
            let (tx, mut rx) = mpsc::channel(2);
            let mut sink = FfmpegSink::new(100, available.clone(), tx, Arc::new(move || { signal.fetch_add(1, Ordering::Relaxed); })).unwrap();
            let control = sink.control();
            control.set_codec(codec);
            sink.output_changed(source(), u32::from_le_bytes(*b"XR24"), 0);
            wait(|| sink.owner.shared.state.lock().unwrap().ready);
            wait(|| redraws.load(Ordering::Relaxed) > 0);
            let mut seen = redraws.load(Ordering::Relaxed);
            let mut info = None;
            assert_eq!(submit(&mut sink, 1), Submit::Held);
            let key = receive(&mut rx, &mut info, &mut sink, 1, &redraws, &mut seen);
            assert!(key.keyframe, "{codec:?}");
            assert_eq!(key.pts_us, 33_333);
            assert_eq!(info.as_ref().unwrap().stream_id, key.stream_id);
            decode(codec, &key, (320, 180));
            assert_eq!(submit(&mut sink, 2), Submit::Encoded);
            // No further source change follows; a requested full redraw repeats this final picture.
            assert_eq!(receive(&mut rx, &mut info, &mut sink, 2, &redraws, &mut seen).pts_us, 66_666);

            control.request_keyframe();
            submit(&mut sink, 3);
            let recovery = receive(&mut rx, &mut info, &mut sink, 3, &redraws, &mut seen);
            assert!(recovery.keyframe, "{codec:?} refused a requested key");
            decode(codec, &recovery, (320, 180));

            control.set_quality(Quality { bitrate_kbps: 1000, max_fps: 0 });
            wait(|| sink.owner.shared.state.lock().unwrap().ready);
            submit(&mut sink, 4);
            let changed = receive(&mut rx, &mut info, &mut sink, 4, &redraws, &mut seen);
            if control.effort().encoder.as_deref() == Some("libx264") { assert_eq!(changed.stream_id, key.stream_id); }
            else { assert_ne!(changed.stream_id, key.stream_id); assert!(changed.keyframe); decode(codec, &changed, (320, 180)); }

            control.set_effort(EncodingEffort::Balanced);
            control.set_size(Some((160, 90)));
            wait(|| sink.owner.shared.state.lock().unwrap().ready);
            submit(&mut sink, 5);
            let resized = receive(&mut rx, &mut info, &mut sink, 5, &redraws, &mut seen);
            assert!(resized.keyframe, "{codec:?}: resized pts={} stream={}, expected pts={}", resized.pts_us, resized.stream_id, 5 * 33_333);
            assert_eq!((info.as_ref().unwrap().width, info.as_ref().unwrap().height), (160, 90));
            decode(codec, &resized, (160, 90));
            assert!(!control.effort().pending);
            assert_eq!(control.effort().requested, EncodingEffort::Balanced);
            drop(sink);
            wait(|| rx.is_closed());
            assert!(control.owner.upgrade().is_none());
        }
    }

    #[test]
    fn output_pressure_releases_input_and_drop_cancels_delivery() {
        struct Lease(Arc<AtomicUsize>);
        impl Drop for Lease { fn drop(&mut self) { self.0.fetch_add(1, Ordering::Relaxed); } }
        let (tx, mut rx) = mpsc::channel(2);
        // Fill the receiver before encoding so this exercises blocked delivery, not admission delay.
        tx.try_send(StreamMsg::Failed(0)).unwrap();
        tx.try_send(StreamMsg::Failed(0)).unwrap();
        let mut sink = FfmpegSink::new(4000, encoders(), tx, Arc::new(|| {})).unwrap();
        sink.output_changed(source(), u32::from_le_bytes(*b"XR24"), 0);
        wait(|| sink.owner.shared.state.lock().unwrap().ready);
        submit(&mut sink, 1);
        wait(|| sink.owner.shared.state.lock().unwrap().pressure);
        let released = Arc::new(AtomicUsize::new(0));
        let mut input = frame(3);
        input.buffer = FrameBuffer::Dmabuf {
            fd: std::fs::File::open("/dev/null").unwrap().into(), modifier: 0, stride: 1280, offset: 0, slot_id: 1, lease: Box::new(Lease(released.clone())),
        };
        assert_eq!(sink.submit(input).unwrap(), Submit::Deferred);
        assert_eq!(released.load(Ordering::Relaxed), 1);
        let control = sink.control();
        drop(sink);
        wait(|| rx.is_closed());
        assert!(control.owner.upgrade().is_none());
        assert_eq!(rx.len(), 2, "teardown must not wait for queued output to drain");
        rx.close();
    }

    #[test]
    fn output_pressure_requests_final_picture_after_drain() {
        let redraws = Arc::new(AtomicUsize::new(0));
        let signal = redraws.clone();
        let (tx, mut rx) = mpsc::channel(2);
        tx.try_send(StreamMsg::Failed(0)).unwrap();
        tx.try_send(StreamMsg::Failed(0)).unwrap();
        let mut sink = FfmpegSink::new(4000, encoders(), tx, Arc::new(move || { signal.fetch_add(1, Ordering::Relaxed); })).unwrap();
        sink.control().set_codec(Codec::Vp8);
        sink.output_changed(source(), u32::from_le_bytes(*b"XR24"), 0);
        wait(|| sink.owner.shared.state.lock().unwrap().ready);
        submit(&mut sink, 1);
        wait(|| sink.owner.shared.state.lock().unwrap().pressure);
        assert_eq!(sink.submit(frame(2)).unwrap(), Submit::Deferred);
        let before = redraws.load(Ordering::Relaxed);
        assert!(matches!(rx.try_recv().unwrap(), StreamMsg::Failed(0)));
        assert!(matches!(rx.try_recv().unwrap(), StreamMsg::Failed(0)));
        wait(|| redraws.load(Ordering::Relaxed) > before);
        let mut seen = redraws.load(Ordering::Relaxed);
        let first = receive(&mut rx, &mut None, &mut sink, 1, &redraws, &mut seen);
        submit(&mut sink, 2);
        let final_frame = receive(&mut rx, &mut None, &mut sink, 2, &redraws, &mut seen);
        assert_eq!(final_frame.pts_us, 66_666);
        let codec = ffmpeg_next::decoder::find(ffmpeg_next::codec::Id::VP8).unwrap();
        let mut decoder = ffmpeg_next::codec::Context::new_with_codec(codec).decoder().video().unwrap();
        for packet in [first, final_frame] {
            decoder.send_packet(&ffmpeg_next::Packet::copy(&packet.data)).unwrap();
            let mut decoded = ffmpeg_next::frame::Video::empty();
            decoder.receive_frame(&mut decoded).unwrap();
            assert_eq!((decoded.width(), decoded.height()), (320, 180));
        }
    }

    #[test]
    fn frame_cap_retries_final_picture_and_refinement_bypasses_cap() {
        let redraws = Arc::new(AtomicUsize::new(0));
        let signal = redraws.clone();
        let (tx, mut rx) = mpsc::channel(2);
        let mut sink = FfmpegSink::new(4000, encoders(), tx, Arc::new(move || { signal.fetch_add(1, Ordering::Relaxed); })).unwrap();
        assert_eq!(sink.submit(frame(1)).unwrap(), Submit::Deferred);
        let control = sink.control();
        control.set_codec(Codec::Vp8);
        sink.output_changed(source(), u32::from_le_bytes(*b"XR24"), 0);
        wait(|| sink.owner.shared.state.lock().unwrap().ready);
        submit(&mut sink, 1);
        let mut info = None;
        let mut seen = redraws.load(Ordering::Relaxed);
        receive(&mut rx, &mut info, &mut sink, 1, &redraws, &mut seen);
        control.set_quality(Quality { bitrate_kbps: 4000, max_fps: 1 });
        let mut due = None;
        wait(|| {
            if let Submit::RetryAt(deadline) = sink.submit(frame(2)).unwrap() { due = Some(deadline); }
            due.is_some()
        });
        std::thread::sleep(due.unwrap().saturating_duration_since(Instant::now()));
        submit(&mut sink, 2);
        assert_eq!(receive(&mut rx, &mut info, &mut sink, 2, &redraws, &mut seen).pts_us, 66_666);
        let start = Instant::now();
        wait(|| {
            let mut final_frame = frame(3);
            final_frame.refine = true;
            sink.submit(final_frame).unwrap() == Submit::Encoded
        });
        assert!(start.elapsed() < Duration::from_millis(500), "refinement waited for the one-fps cap");
        assert_eq!(receive(&mut rx, &mut info, &mut sink, 3, &redraws, &mut seen).pts_us, 99_999);
    }

    #[test]
    fn compositor_submit_does_not_wait_for_worker_state() {
        let (tx, _rx) = mpsc::channel(2);
        let mut sink = FfmpegSink::new(4000, encoders(), tx, Arc::new(|| {})).unwrap();
        let shared = sink.owner.shared.clone();
        let held = shared.state.lock().unwrap();
        let start = Instant::now();
        assert_eq!(sink.submit(frame(1)).unwrap(), Submit::Held);
        assert!(start.elapsed() < Duration::from_millis(50));
        drop(held);
    }
}
