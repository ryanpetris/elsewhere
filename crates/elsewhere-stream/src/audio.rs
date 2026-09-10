//! Private PipeWire PCM I/O and FFmpeg Opus. Device callbacks never run codecs.
use crate::Running;
use anyhow::{Context, Result, bail, ensure};
use elsewhere_core::{Bytes, StreamMsg};
use ffmpeg_next as av;
use pipewire::{self as pw, properties::properties, spa::{
    buffer::meta::MetaHeader,
    param::{ParamType, audio::{AudioFormat, AudioInfoRaw}},
    pod::{Object, Pod, Value, serialize::PodSerializer},
    utils::Direction,
}};
use std::{cell::RefCell, collections::VecDeque, io::Cursor, os::unix::net::UnixStream,
    path::Path, rc::Rc, sync::{Arc, Mutex, atomic::Ordering, mpsc::{self, Receiver, sync_channel}},
    time::{Duration, Instant}};
use tokio::sync::mpsc as async_mpsc;

const RATE: u32 = 48_000;
const OPUS_FRAMES: usize = 960;
const MIC_FRAMES: usize = RATE as usize / 5;

/// Interleaved stereo floats at 48 kHz. Position counts sample frames since capture started;
/// missing positions mean capture or queue loss, and must not be concatenated across a gap.
pub(crate) struct PcmChunk {
    pub samples: Vec<f32>,
    pub position: u64,
}

#[derive(Default)]
struct CaptureClock { origin: Option<i64>, next: u64 }

impl CaptureClock {
    fn position(&mut self, timestamp: Option<i64>, frames: usize) -> u64 {
        if let Some(timestamp) = timestamp.filter(|&t| t >= 0) {
            let elapsed_ns = (self.next as u128 * 1_000_000_000 / RATE as u128).min(i64::MAX as u128) as i64;
            let origin = *self.origin.get_or_insert(timestamp.saturating_sub(elapsed_ns));
            if timestamp < origin {
                // A restarted graph clock begins a new epoch without moving packet PTS backwards.
                self.origin = Some(timestamp.saturating_sub(elapsed_ns));
            } else {
                let clock = ((timestamp - origin) as u128 * RATE as u128 / 1_000_000_000) as u64;
                // Nanosecond rounding should not split a continuous Opus frame.
                if clock > self.next.saturating_add(2) { self.next = clock; }
            }
        }
        let position = self.next;
        self.next = self.next.saturating_add(frames as u64);
        position
    }
}

/// Capture the selected private sink monitor. Five 20 ms chunks bound the PCM backlog.
pub(crate) fn capture(socket: &Path, device: &str) -> Result<(Running, Receiver<PcmChunk>)> {
    let (tx, rx) = sync_channel(5);
    let mut clock = CaptureClock::default();
    let running = pipewire(socket, device, "elsewhere-capture", Direction::Input, 2, move |stream| {
        while let Some(mut buffer) = stream.dequeue_buffer() {
            let timestamp = buffer.find_meta::<MetaHeader>().map(|header| header.pts()).filter(|&timestamp| timestamp >= 0)
                .or_else(|| stream.time().ok().map(|time| time.now()));
            let Some(data) = buffer.datas_mut().first_mut() else { continue; };
            let offset = data.chunk().offset() as usize;
            let size = data.chunk().size() as usize;
            let Some(bytes) = data.data().and_then(|bytes| bytes.get(offset..offset.saturating_add(size))) else { continue; };
            if bytes.len() % 8 != 0 { continue; }
            let position = clock.position(timestamp, bytes.len() / 8);
            for (index, bytes) in bytes.chunks(OPUS_FRAMES * 8).enumerate() {
                let samples = bytes.chunks_exact(4).map(|value| {
                    let sample = f32::from_ne_bytes(value.try_into().unwrap());
                    if sample.is_finite() { sample } else { 0.0 }
                }).collect();
                let _ = tx.try_send(PcmChunk { samples, position: position + (index * OPUS_FRAMES) as u64 });
            }
        }
    })?;
    Ok((running, rx))
}

fn pipewire(socket: &Path, device: &str, name: &'static str, direction: Direction, channels: u32,
    process: impl FnMut(&pw::stream::Stream) + Send + 'static) -> Result<Running>
{
    ensure!(socket.is_absolute(), "private PipeWire socket must be absolute");
    ensure!(!device.is_empty(), "private PipeWire target is required");
    let connection = UnixStream::connect(socket).context("private PipeWire connection")?;
    let device = device.to_owned();
    let (ready, initialized) = sync_channel(1);
    let running = Running::spawn(name, move |stop| {
        pw::init();
        let mainloop = pw::main_loop::MainLoopRc::new(None)?;
        let context = pw::context::ContextRc::new(&mainloop, None)?;
        let core = context.connect_fd_rc(connection.into(), Some(properties! { "application.name" => "Elsewhere audio" }))?;
        let error = Rc::new(RefCell::new(None));
        let failed = error.clone();
        let quit = mainloop.clone();
        let _core_listener = core.add_listener_local().error(move |_, _, code, _| {
            *failed.borrow_mut() = Some(format!("private PipeWire error {code}"));
            quit.quit();
        }).register();
        let properties = properties! {
            "node.name" => name, "media.name" => name,
            "media.type" => "Audio", "media.category" => if direction == Direction::Input { "Capture" } else { "Playback" },
            "media.class" => if direction == Direction::Input { "Stream/Input/Audio" } else { "Stream/Output/Audio" },
            "media.role" => "Communication", "target.object" => device,
            "node.autoconnect" => "true",
            // WirePlumber can briefly rebuild a sink's session item while linking another stream.
            "node.dont-fallback" => "true", "node.linger" => "true", "node.latency" => "960/48000",
            "stream.capture.sink" => (direction == Direction::Input).to_string(),
        };
        let stream = pw::stream::StreamRc::new(core, name, properties.to_owned())?;
        let failed = error.clone();
        let quit = mainloop.clone();
        let format_error = error.clone();
        let format_quit = mainloop.clone();
        let activity = Rc::new(RefCell::new(Instant::now()));
        let processed = activity.clone();
        let _listener = stream.add_local_listener_with_user_data(process)
            .state_changed(move |_, _, old, state| {
                tracing::debug!(name, ?old, ?state, "private audio state");
                let message = match state {
                    pw::stream::StreamState::Error(_) => Some("private PipeWire stream failed"),
                    pw::stream::StreamState::Unconnected if !matches!(old, pw::stream::StreamState::Unconnected) => Some("private PipeWire stream disconnected"),
                    _ => None,
                };
                if let Some(message) = message { *failed.borrow_mut() = Some(message.into()); quit.quit(); }
            })
            .param_changed(move |_, _, id, param| {
                if id != ParamType::Format.as_raw() { return; }
                let Some(param) = param else { return; };
                let mut format = AudioInfoRaw::new();
                if format.parse(param).is_err() || format.format() != AudioFormat::F32LE || format.rate() != RATE || format.channels() != channels {
                    tracing::debug!(name, ?format, "incompatible private audio format");
                    *format_error.borrow_mut() = Some("private PipeWire negotiated an incompatible audio format".into());
                    format_quit.quit();
                }
            })
            .process(move |stream, process| { *processed.borrow_mut() = Instant::now(); process(stream); }).register()?;
        let mut format = AudioInfoRaw::new();
        format.set_format(AudioFormat::F32LE);
        format.set_rate(RATE);
        format.set_channels(channels);
        let mut positions = [0; pw::spa::sys::SPA_AUDIO_MAX_CHANNELS as usize];
        if channels == 1 { positions[0] = pw::spa::sys::SPA_AUDIO_CHANNEL_MONO; }
        else { positions[0] = pw::spa::sys::SPA_AUDIO_CHANNEL_FL; positions[1] = pw::spa::sys::SPA_AUDIO_CHANNEL_FR; }
        format.set_position(positions);
        let bytes = PodSerializer::serialize(Cursor::new(Vec::new()), &Value::Object(Object {
            type_: pw::spa::utils::SpaTypes::ObjectParamFormat.as_raw(),
            id: ParamType::EnumFormat.as_raw(), properties: format.into(),
        }))?.0.into_inner();
        // Callbacks share this worker's main loop; encoding and network I/O use other threads.
        stream.connect(direction, None, pw::stream::StreamFlags::AUTOCONNECT | pw::stream::StreamFlags::MAP_BUFFERS | pw::stream::StreamFlags::INACTIVE,
            &mut [Pod::from_bytes(&bytes).context("private audio format")?])?;
        // pw_stream_connect applies PIPEWIRE_NODE/PROPS after caller properties. Restore private
        // routing before this loop dispatches any messages or the inactive stream processes audio.
        let result = unsafe { pw::sys::pw_stream_update_properties(stream.as_raw_ptr(), properties.dict().as_raw_ptr()) };
        ensure!(result >= 0, "restore private PipeWire stream properties: {result}");
        stream.set_active(true)?;
        let quit = mainloop.clone();
        let stalled = error.clone();
        let timer = mainloop.loop_().add_timer(move |_| {
            if stop.load(Ordering::Relaxed) { quit.quit(); }
            else if activity.borrow().elapsed() > Duration::from_secs(3) {
                *stalled.borrow_mut() = Some("private PipeWire stream stopped processing audio".into());
                quit.quit();
            }
        });
        timer.update_timer(Some(Duration::from_millis(10)), Some(Duration::from_millis(10))).into_result()?;
        let _ = ready.send(());
        mainloop.run();
        if let Some(error) = error.borrow_mut().take() { bail!("{error}"); }
        Ok(())
    })?;
    if initialized.recv_timeout(Duration::from_secs(3)).is_err() {
        running.check()?;
        bail!("private PipeWire initialization did not complete");
    }
    Ok(running)
}

pub fn audio_source(socket: &Path, device: &str, tx: async_mpsc::Sender<StreamMsg>) -> Result<Running> {
    crate::init()?;
    let encoder = OpusEncoder::new()?;
    let (capture, rx) = capture(socket, device)?;
    Running::spawn("audio-encode", move |stop| {
        let mut encoder = encoder;
        let mut pending = VecDeque::new();
        let mut position = 0;
        while !stop.load(Ordering::Relaxed) && !tx.is_closed() {
            capture.check()?;
            let chunk = match rx.recv_timeout(Duration::from_millis(10)) {
                Ok(chunk) => chunk, Err(mpsc::RecvTimeoutError::Timeout) => continue,
                Err(mpsc::RecvTimeoutError::Disconnected) => bail!("private audio capture ended"),
            };
            if chunk.position != position + (pending.len() / 2) as u64 {
                pending.clear();
                position = chunk.position;
            }
            pending.extend(chunk.samples);
            while pending.len() >= OPUS_FRAMES * 2 {
                let samples: Vec<f32> = pending.drain(..OPUS_FRAMES * 2).collect();
                for (pts_us, data) in encoder.encode(&samples, position)? {
                    let _ = tx.try_send(StreamMsg::Audio { pts_us, data });
                }
                position += OPUS_FRAMES as u64;
            }
        }
        Ok(())
    })
}

struct OpusEncoder { encoder: av::codec::encoder::audio::Encoder, positions: VecDeque<u64> }

impl OpusEncoder {
    fn new() -> Result<Self> {
        let codec = av::encoder::find_by_name("libopus").context("FFmpeg libopus encoder is unavailable")?;
        let mut encoder = av::codec::context::Context::new_with_codec(codec).encoder().audio()?;
        encoder.set_rate(RATE as i32);
        encoder.set_channel_layout(av::ChannelLayout::STEREO);
        encoder.set_format(av::format::Sample::F32(av::format::sample::Type::Packed));
        encoder.set_time_base((1, RATE as i32));
        encoder.set_bit_rate(96_000);
        let mut options = av::Dictionary::new();
        options.set("application", "audio");
        options.set("frame_duration", "20");
        // Enable DTX when the installed FFmpeg encoder exposes it.
        unsafe {
            if !av::ffi::av_opt_find((*encoder.as_ptr()).priv_data, c"dtx".as_ptr(), std::ptr::null(), 0, 0).is_null() { options.set("dtx", "1"); }
        }
        let encoder = encoder.open_as_with(codec, options)?;
        ensure!(encoder.frame_size() == OPUS_FRAMES as u32, "libopus did not select 20 ms frames");
        Ok(Self { encoder, positions: VecDeque::new() })
    }

    fn encode(&mut self, samples: &[f32], position: u64) -> Result<Vec<(u64, Bytes)>> {
        ensure!(samples.len() == OPUS_FRAMES * 2, "invalid Opus input size");
        let mut frame = av::frame::Audio::new(self.encoder.format(), OPUS_FRAMES, av::ChannelLayout::STEREO);
        frame.set_rate(RATE);
        frame.set_pts(Some(position as i64));
        frame.plane_mut::<f32>(0).copy_from_slice(samples);
        self.encoder.send_frame(&frame)?;
        self.positions.push_back(position);
        let mut output = Vec::new();
        loop {
            let mut packet = av::Packet::empty();
            match self.encoder.receive_packet(&mut packet) {
                Ok(()) => {
                    // FFmpeg's audio frame queue flattens timestamp gaps. Raw 20 ms Opus has one
                    // packet per submitted frame, so retain capture positions across discontinuities.
                    let pts = self.positions.pop_front().context("Opus packet without capture position")?;
                    output.push((pts * 1_000_000 / RATE as u64, Bytes::copy_from_slice(packet.data().context("empty Opus packet")?)));
                }
                Err(av::Error::Other { errno: av::error::EAGAIN }) => break,
                Err(error) => return Err(error.into()),
            }
        }
        Ok(output)
    }
}

/// Plays browser Opus into the private virtual microphone, with at most 200 ms queued PCM.
pub fn audio_sink(socket: &Path, device: &str, mut rx: async_mpsc::Receiver<Bytes>) -> Result<Running> {
    crate::init()?;
    let mut decoder = OpusDecoder::new()?;
    let pcm = Arc::new(Mutex::new(VecDeque::<f32>::new()));
    let output = pcm.clone();
    let playback = pipewire(socket, device, "elsewhere-microphone-stream", Direction::Output, 1, move |stream| {
        let Some(mut buffer) = stream.dequeue_buffer() else { return; };
        let requested = buffer.requested() as usize;
        let Some(data) = buffer.datas_mut().first_mut() else { return; };
        let Some(bytes) = data.data() else { return; };
        let frames = if requested == 0 { bytes.len() / 4 } else { requested.min(bytes.len() / 4) };
        let mut pcm = output.try_lock().ok();
        for sample in bytes[..frames * 4].chunks_exact_mut(4) {
            let value = pcm.as_mut().and_then(|pcm| pcm.pop_front()).unwrap_or(0.0);
            sample.copy_from_slice(&value.to_ne_bytes());
        }
        *data.chunk_mut().offset_mut() = 0;
        *data.chunk_mut().stride_mut() = 4;
        *data.chunk_mut().size_mut() = (frames * 4) as u32;
    })?;
    Running::spawn("microphone-decode", move |stop| {
        while !stop.load(Ordering::Relaxed) {
            playback.check()?;
            let mut packets = VecDeque::new();
            let mut duration = 0;
            for _ in 0..rx.max_capacity() {
                match rx.try_recv() {
                    Ok(packet) => if let Some(frames) = opus_duration(&packet) {
                        duration += frames;
                        packets.push_back((packet, frames));
                        while duration > MIC_FRAMES { duration -= packets.pop_front().unwrap().1; }
                    },
                    Err(async_mpsc::error::TryRecvError::Empty) => break,
                    Err(async_mpsc::error::TryRecvError::Disconnected) => return Ok(()),
                }
            }
            for (packet, _) in packets {
                // A malformed browser packet cannot tear down desktop audio.
                if let Ok(samples) = decoder.decode(&packet) {
                    let mut queue = pcm.lock().unwrap_or_else(|p| p.into_inner());
                    let excess = (queue.len() + samples.len()).saturating_sub(MIC_FRAMES).min(queue.len());
                    queue.drain(..excess);
                    queue.extend(samples.into_iter().take(MIC_FRAMES));
                } else { decoder.decoder.flush(); }
            }
            std::thread::sleep(Duration::from_millis(5));
        }
        Ok(())
    })
}

fn opus_duration(packet: &[u8]) -> Option<usize> {
    if packet.len() > 65_536 { return None; }
    let toc = *packet.first()?;
    let samples = if toc & 0x80 != 0 { 120 << ((toc >> 3) & 3) }
        else if toc & 0x60 == 0x60 { 480 << ((toc >> 3) & 1) }
        else { (480 << ((toc >> 3) & 3)).min(2880) };
    let frames = match toc & 3 { 0 => 1, 1 | 2 => 2, _ => (packet.get(1)? & 0x3f) as usize };
    let samples = samples * frames;
    (samples > 0 && samples <= 5760).then_some(samples)
}

struct OpusDecoder { decoder: av::codec::decoder::Audio, resampler: Option<av::software::resampling::Context> }

impl OpusDecoder {
    fn new() -> Result<Self> {
        let codec = av::decoder::find_by_name("libopus").context("FFmpeg libopus decoder is unavailable")?;
        let mut context = av::codec::context::Context::new_with_codec(codec);
        unsafe {
            (*context.as_mut_ptr()).sample_rate = RATE as i32;
            av::ffi::av_channel_layout_default(&mut (*context.as_mut_ptr()).ch_layout, 1);
        }
        let decoder = context.decoder().open_as(codec)?.audio()?;
        Ok(Self { decoder, resampler: None })
    }

    fn decode(&mut self, bytes: &[u8]) -> Result<Vec<f32>> {
        ensure!(opus_duration(bytes).is_some(), "invalid Opus packet duration");
        self.decoder.send_packet(&av::Packet::copy(bytes))?;
        let mut samples = Vec::new();
        loop {
            let mut frame = av::frame::Audio::empty();
            match self.decoder.receive_frame(&mut frame) {
                Ok(()) => {
                    ensure!(frame.samples() <= 5760 && frame.channels() == 1 && frame.rate() == RATE, "invalid microphone audio format");
                    let resampler = match self.resampler.as_mut() {
                        Some(resampler) if resampler.input().format == frame.format() => resampler,
                        _ => self.resampler.insert(av::software::resampling::Context::get(frame.format(), av::ChannelLayout::MONO, RATE,
                            av::format::Sample::F32(av::format::sample::Type::Packed), av::ChannelLayout::MONO, RATE)?),
                    };
                    let mut converted = av::frame::Audio::empty();
                    resampler.run(&frame, &mut converted)?;
                    samples.extend_from_slice(converted.plane::<f32>(0));
                }
                Err(av::Error::Other { errno: av::error::EAGAIN }) => return Ok(samples),
                Err(error) => return Err(error.into()),
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn opus_roundtrip_and_clock_gaps() -> Result<()> {
        crate::init()?;
        let mut encoder = OpusEncoder::new()?;
        let mut decoder = OpusDecoder::new()?;
        let mut clock = CaptureClock::default();
        assert_eq!(clock.position(Some(1_000_000_000), 1024), 0);
        assert_eq!(clock.position(Some(1_021_333_333), 1024), 1024);
        assert_eq!(clock.position(Some(1_100_000_000), 1024), 4800);
        let samples: Vec<f32> = (0..OPUS_FRAMES).flat_map(|i| { let s = (i as f32 * std::f32::consts::TAU * 440.0 / RATE as f32).sin() * 0.2; [s, s] }).collect();
        for position in [0, 960, 4800] {
            let packets = encoder.encode(&samples, position)?;
            assert_eq!(packets.len(), 1);
            assert_eq!(packets[0].0, position * 1_000_000 / RATE as u64);
            assert_eq!(opus_duration(&packets[0].1), Some(960));
            let decoded = decoder.decode(&packets[0].1)?;
            assert_eq!(decoded.len(), 960);
            assert!(decoded.iter().all(|s| s.is_finite()));
            assert!(decoded.iter().any(|s| s.abs() > 0.05));
        }
        assert!(decoder.decode(&[]).is_err());
        assert!(decoder.decode(&[3, 0]).is_err());
        assert_eq!(decoder.decode(&encoder.encode(&samples, 5760)?[0].1)?.len(), 960);
        Ok(())
    }

    #[test]
    #[ignore = "requires ELSEWHERE_TEST_PIPEWIRE pointing to an isolated Elsewhere audio graph"]
    fn private_pipewire_capture_microphone_and_stop() -> Result<()> {
        use std::time::Instant;
        crate::init()?;
        let socket = std::env::var_os("ELSEWHERE_TEST_PIPEWIRE").context("test PipeWire socket")?;
        let socket = Path::new(&socket);
        let (audio_tx, mut audio_rx) = async_mpsc::channel(8);
        let source = audio_source(socket, "elsewhere-output", audio_tx)?;
        let (mic_tx, mic_rx) = async_mpsc::channel(64);
        let microphone = audio_sink(socket, "elsewhere-microphone-input", mic_rx)?;
        let (monitor, monitor_rx) = capture(socket, "elsewhere-microphone-input")?;
        let mut phase = 0u64;
        let tone = pipewire(socket, "elsewhere-output", "audio-test-tone", Direction::Output, 2, move |stream| {
            let Some(mut buffer) = stream.dequeue_buffer() else { return; };
            let requested = buffer.requested() as usize;
            let Some(data) = buffer.datas_mut().first_mut() else { return; };
            let Some(bytes) = data.data() else { return; };
            let frames = requested.min(bytes.len() / 8);
            for pair in bytes[..frames * 8].chunks_exact_mut(8) {
                let sample = (phase as f32 * std::f32::consts::TAU * 440.0 / RATE as f32).sin() * 0.2;
                pair[..4].copy_from_slice(&sample.to_ne_bytes());
                pair[4..].copy_from_slice(&sample.to_ne_bytes());
                phase += 1;
            }
            *data.chunk_mut().offset_mut() = 0;
            *data.chunk_mut().stride_mut() = 8;
            *data.chunk_mut().size_mut() = (frames * 8) as u32;
        })?;
        let mut encoder = OpusEncoder::new()?;
        let mut decoder = OpusDecoder::new()?;
        let samples: Vec<f32> = (0..OPUS_FRAMES).flat_map(|i| { let s = (i as f32 * std::f32::consts::TAU * 880.0 / RATE as f32).sin() * 0.2; [s, s] }).collect();
        let start = Instant::now();
        let mut next = 0;
        let mut position = 0;
        let mut captured = 0;
        let mut previous = None;
        let mut gaps = 0;
        let mut mic_signal = false;
        let mut resumed = false;
        let mut quiet = 0;
        let mut burst = false;
        let mut split_quantum = false;
        while start.elapsed() < Duration::from_secs(4) {
            source.check()?; microphone.check()?; monitor.check()?; tone.check()?;
            let elapsed = start.elapsed().as_millis();
            if elapsed >= next {
                if !(1500..2500).contains(&elapsed) {
                    let packet = encoder.encode(&samples, position)?.pop().context("test Opus packet")?.1;
                    let _ = mic_tx.try_send(packet.clone());
                    if elapsed > 800 && !burst {
                        burst = true;
                        for _ in 0..32 { let _ = mic_tx.try_send(packet.clone()); let _ = mic_tx.try_send(Bytes::from_static(&[3, 0])); }
                    }
                    position += OPUS_FRAMES as u64;
                }
                next = elapsed + 20;
            }
            while let Ok(StreamMsg::Audio { pts_us, data }) = audio_rx.try_recv() {
                if let Some(previous) = previous { ensure!(pts_us > previous, "capture PTS moved backwards"); if pts_us - previous != 20_000 { gaps += 1; } }
                previous = Some(pts_us);
                if decoder.decode(&data)?.iter().any(|s| s.abs() > 0.05) { captured += 1; }
            }
            while let Ok(chunk) = monitor_rx.try_recv() {
                split_quantum |= chunk.samples.len() == (1024 - OPUS_FRAMES) * 2;
                let peak = chunk.samples.iter().copied().map(f32::abs).fold(0.0, f32::max);
                if elapsed < 1500 && peak > 0.05 { mic_signal = true; }
                if elapsed > 3000 && peak > 0.05 { resumed = true; }
                if (2100..2400).contains(&elapsed) { ensure!(peak < 0.0001, "old microphone speech survived its bounded queue: {peak}"); quiet += 1; }
            }
            std::thread::sleep(Duration::from_millis(5));
        }
        ensure!(captured > 100, "desktop Opus capture did not deliver continuous audio");
        ensure!(gaps < 5, "continuous 1024-sample capture has {gaps} timestamp gaps");
        ensure!(split_quantum, "test graph did not exercise 1024-sample capture quanta");
        ensure!(mic_signal && resumed && quiet > 5, "microphone signal, silence or resume failed");
        let stop = Instant::now();
        drop(source); drop(microphone); drop(monitor); drop(tone);
        ensure!(stop.elapsed() < Duration::from_millis(500), "native audio did not join before the supervisor deadline");
        ensure!(mic_tx.is_closed(), "microphone input survived its worker");
        eprintln!("private PCM/Opus: {captured} tone packets, {gaps} timestamp gaps, stop {:?}", stop.elapsed());
        let (tx, _rx) = async_mpsc::channel(1);
        let missing = audio_source(socket, "elsewhere-missing-test-node", tx)?;
        let deadline = Instant::now() + Duration::from_secs(4);
        while missing.check().is_ok() {
            ensure!(Instant::now() < deadline, "missing target neither failed nor stayed isolated");
            std::thread::sleep(Duration::from_millis(20));
        }
        drop(missing);
        Ok(())
    }
}
