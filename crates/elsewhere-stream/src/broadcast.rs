//! Independent RTMP outputs. CPU frames own their pixels and never retain compositor leases.
use std::{collections::VecDeque, ffi::{CString, c_void}, io::{Read, Write}, os::{fd::AsRawFd, unix::process::CommandExt}, path::PathBuf, process::{Child, ChildStdin, ChildStdout, Command, Stdio}, ptr, sync::{Arc, Mutex, atomic::{AtomicBool, AtomicU64, Ordering}}, time::{Duration, Instant}};
use anyhow::{Context, Result, ensure};
use elsewhere_core::{broadcast::{self, Audio, Capabilities, Control, Progress, Start, State}, Bytes, CursorImage, Frame, FrameBuffer, FrameSink, OutputGeometry, SinkError, Submit};
use ffmpeg_next::{self as ffmpeg, codec, encoder, ffi, format, frame, software, ChannelLayout, Dictionary, Packet, Rational};
use tokio::sync::watch;

#[derive(Clone)]
struct Picture { data: Bytes, width: u32, height: u32, stride: u32, cursor: Option<CursorImage>, x: f64, y: f64, scale: f64 }
struct Sink { tx: watch::Sender<Option<Picture>>, cursor: Option<CursorImage>, x: f64, y: f64, scale: f64, fps: u32, stopped: Arc<AtomicBool> }
impl FrameSink for Sink {
    fn wants_pixels(&self) -> bool { !self.stopped.load(Ordering::Relaxed) }
    fn cadence(&self) -> Option<Duration> { (!self.stopped.load(Ordering::Relaxed)).then(|| Duration::from_secs_f64(1.0 / self.fps as f64)) }
    fn output_changed(&mut self, _: OutputGeometry, _: u32, _: u64) {}
    fn cursor(&mut self, image: Option<CursorImage>, x: f64, y: f64, scale: f64) { self.cursor = image; self.x = x; self.y = y; self.scale = scale; }
    fn submit(&mut self, frame: Frame) -> Result<Submit, SinkError> {
        if !self.stopped.load(Ordering::Relaxed) {
            if let FrameBuffer::Memory { data, stride } = frame.buffer {
                let needed = (frame.height.saturating_sub(1) as usize).checked_mul(stride as usize).and_then(|n| n.checked_add(frame.width as usize * 4));
                if frame.width == 0 || frame.height == 0 || stride < frame.width.saturating_mul(4) || needed.is_none_or(|n| data.len() < n) {
                    return Err(anyhow::anyhow!("invalid broadcast pixels").into());
                }
                self.tx.send_replace(Some(Picture { data, width: frame.width, height: frame.height, stride, cursor: self.cursor.clone(), x: self.x, y: self.y, scale: self.scale }));
            }
        }
        Ok(Submit::Encoded)
    }
}

struct Running { stopped: Arc<AtomicBool>, progress: Arc<Mutex<Progress>> }
impl Control for Running {
    fn progress(&self) -> Progress { self.progress.lock().unwrap_or_else(|e| e.into_inner()).clone() }
    fn stop(&self) {
        self.stopped.store(true, Ordering::Relaxed);
        let mut p = self.progress.lock().unwrap_or_else(|e| e.into_inner());
        if !p.state.terminal() { p.state = State::Stopping; }
    }
}
impl Drop for Running { fn drop(&mut self) { self.stop(); } }

pub fn capabilities(audio: bool) -> Capabilities {
    let available = crate::init().is_ok() && encoder::find_by_name("libx264").is_some() && encoder::find_by_name("aac").is_some() && unsafe {
        !ffi::av_guess_format(c"flv".as_ptr(), ptr::null(), ptr::null()).is_null()
            && !ffi::avio_find_protocol_name(c"rtmp://localhost/live".as_ptr()).is_null()
            && !ffi::avio_find_protocol_name(c"rtmps://localhost/live".as_ptr()).is_null()
    };
    Capabilities { available, desktop_audio: audio && available, video_codec: "h264", audio_codec: "aac", max_outputs: 4, max_width: 3840, max_height: 2160, max_fps: 60, min_bitrate_kbps: 100, max_bitrate_kbps: 50000, error: (!available).then(|| "Broadcasting needs FFmpeg H.264, AAC and RTMP support.".into()) }
}

pub fn start(settings: Start, socket: Option<PathBuf>) -> Result<(Box<dyn FrameSink>, Arc<dyn broadcast::Control>)> {
    crate::init()?;
    ensure!(settings.width >= 64 && settings.height >= 64 && settings.width <= 3840 && settings.height <= 2160 && settings.width % 2 == 0 && settings.height % 2 == 0 && matches!(settings.fps, 24 | 25 | 30 | 50 | 60) && (100..=50000).contains(&settings.bitrate_kbps), "invalid broadcast settings");
    ensure!(settings.url.starts_with("rtmp://") || settings.url.starts_with("rtmps://"), "invalid broadcast protocol");
    let (tx, rx) = watch::channel(None);
    let stopped = Arc::new(AtomicBool::new(false));
    let progress = Arc::new(Mutex::new(Progress::default()));
    let control = Arc::new(Running { stopped: stopped.clone(), progress: progress.clone() });
    let sink = Sink { tx, cursor: None, x: 0.0, y: 0.0, scale: 1.0, fps: settings.fps, stopped: stopped.clone() };
    std::thread::Builder::new().name("broadcast".into()).spawn(move || {
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| run(settings, socket, rx, &stopped, &progress)));
        let cancelled = stopped.swap(true, Ordering::Relaxed);
        let mut p = progress.lock().unwrap_or_else(|e| e.into_inner());
        if result.is_err() && !cancelled { p.state = State::Failed; p.error = Some("Broadcast worker failed.".into()); }
        else if cancelled || p.state != State::Failed { p.state = State::Stopped; }
    })?;
    Ok((Box::new(sink), control))
}

fn check(code: i32) -> Result<()> { if code < 0 { Err(ffmpeg::Error::from(code).into()) } else { Ok(()) } }

struct Interrupt { stop: Arc<AtomicBool>, origin: Instant, deadline_ms: AtomicU64 }
impl Interrupt {
    fn arm(&self, timeout: Duration) { self.deadline_ms.store(self.origin.elapsed().as_millis() as u64 + timeout.as_millis() as u64, Ordering::Relaxed); }
}
unsafe extern "C" fn interrupt(opaque: *mut c_void) -> i32 {
    // The boxed state outlives every operation and the output context's destructor.
    let state = unsafe { &*(opaque as *const Interrupt) };
    i32::from(state.stop.load(Ordering::Relaxed) || state.origin.elapsed().as_millis() as u64 >= state.deadline_ms.load(Ordering::Relaxed))
}

// Only network I/O lives in the helper. A stalled libc resolver cannot retain a stopped output.
struct Network {
    child: Child,
    input: ChildStdin,
    status: ChildStdout,
    stop: Arc<AtomicBool>,
    connected: bool,
    bytes: u64,
    ack: [u8; 8],
    ack_used: usize,
}
impl Network {
    fn start(s: &Start, stop: Arc<AtomicBool>) -> Result<Box<Self>> {
        let mut command = Command::new("/proc/self/exe");
        command.arg("--broadcast-output-worker").stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null());
        let parent = unsafe { libc::getpid() };
        unsafe {
            command.pre_exec(move || {
                if libc::prctl(libc::PR_SET_PDEATHSIG, libc::SIGKILL) < 0 { return Err(std::io::Error::last_os_error()); }
                if libc::getppid() != parent { return Err(std::io::Error::from_raw_os_error(libc::ECHILD)); }
                Ok(())
            });
        }
        let mut child = command.spawn()?;
        let input = child.stdin.take().context("broadcast input unavailable")?;
        let status = child.stdout.take().context("broadcast status unavailable")?;
        let mut network = Box::new(Self { child, input, status, stop, connected: false, bytes: 0, ack: [0; 8], ack_used: 0 });
        for fd in [network.input.as_raw_fd(), network.status.as_raw_fd()] {
            unsafe { check(libc::fcntl(fd, libc::F_SETFL, libc::fcntl(fd, libc::F_GETFL) | libc::O_NONBLOCK))?; }
        }
        let destination = if s.stream_key.is_empty() { s.url.clone() } else { format!("{}/{}", s.url.trim_end_matches('/'), s.stream_key) };
        ensure!(destination.len() <= 16 * 1024, "invalid destination");
        let deadline = Instant::now() + Duration::from_secs(5);
        network.write(&(destination.len() as u32).to_le_bytes(), deadline)?;
        network.write(destination.as_bytes(), deadline)?;
        while !network.connected {
            network.check(deadline)?;
            network.read_status()?;
            if !network.connected { std::thread::sleep(Duration::from_millis(10)); }
        }
        Ok(network)
    }
    fn check(&self, deadline: Instant) -> Result<()> {
        ensure!(!self.stop.load(Ordering::Relaxed) && Instant::now() < deadline, "broadcast output cancelled or timed out");
        Ok(())
    }
    fn read_status(&mut self) -> Result<()> {
        loop {
            match self.status.read(&mut self.ack[self.ack_used..]) {
                Ok(0) => anyhow::bail!("broadcast output ended"),
                Ok(n) => {
                    self.ack_used += n;
                    if self.ack_used == 8 { self.bytes = u64::from_le_bytes(self.ack); self.connected = true; self.ack_used = 0; }
                }
                Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => return Ok(()),
                Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
                Err(e) => return Err(e.into()),
            }
        }
    }
    fn write(&mut self, mut data: &[u8], deadline: Instant) -> Result<()> {
        while !data.is_empty() {
            self.check(deadline)?;
            self.read_status()?;
            match self.input.write(data) {
                Ok(0) => anyhow::bail!("broadcast input ended"),
                Ok(n) => data = &data[n..],
                Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => std::thread::sleep(Duration::from_millis(2)),
                Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
                Err(e) => return Err(e.into()),
            }
        }
        Ok(())
    }
}
impl Drop for Network {
    fn drop(&mut self) { let _ = self.child.kill(); let _ = self.child.wait(); }
}
unsafe extern "C" fn write_flv(opaque: *mut c_void, data: *const u8, size: i32) -> i32 {
    let network = unsafe { &mut *(opaque as *mut Network) };
    let data = unsafe { std::slice::from_raw_parts(data, size as usize) };
    match network.write(data, Instant::now() + Duration::from_secs(5)) { Ok(()) => size, Err(_) => -libc::EIO }
}

struct Output { context: format::context::Output, stop: Arc<AtomicBool>, network: Option<Box<Network>>, header_bytes: u64, first_media_end: Option<u64>, media_written: bool }
impl Output {
    fn create(stop: Arc<AtomicBool>) -> Result<Self> {
        let mut context = ptr::null_mut();
        unsafe {
            check(ffi::avformat_alloc_output_context2(&mut context, ptr::null(), c"flv".as_ptr(), ptr::null()))?;
            ensure!(!context.is_null(), "broadcast muxer unavailable");
            (*context).max_interleave_delta = 100_000;
            (*context).flags |= ffi::AVFMT_FLAG_FLUSH_PACKETS | ffi::AVFMT_FLAG_CUSTOM_IO;
            (*context).avoid_negative_ts = ffi::AVFMT_AVOID_NEG_TS_MAKE_NON_NEGATIVE;
            Ok(Self { context: format::context::Output::wrap(context), stop, network: None, header_bytes: 0, first_media_end: None, media_written: false })
        }
    }
    fn connect(&mut self, s: &Start) -> Result<()> {
        let mut network = Network::start(s, self.stop.clone())?;
        unsafe {
            let buffer = ffi::av_malloc(8192).cast::<u8>();
            ensure!(!buffer.is_null(), "broadcast buffer unavailable");
            // Native headers differ only in the buffer pointer's const qualifier, with the same C ABI.
            let write = std::mem::transmute(write_flv as unsafe extern "C" fn(*mut c_void, *const u8, i32) -> i32);
            let pb = ffi::avio_alloc_context(buffer, 8192, 1, (&mut *network as *mut Network).cast(), None, Some(write), None);
            if pb.is_null() { ffi::av_free(buffer.cast()); anyhow::bail!("broadcast I/O unavailable"); }
            (*self.context.as_mut_ptr()).pb = pb;
        }
        self.network = Some(network);
        let mut options = Dictionary::new();
        options.set("flvflags", "no_duration_filesize");
        self.context.write_header_with(options)?;
        unsafe { let pb = (*self.context.as_mut_ptr()).pb; ffi::avio_flush(pb); check((*pb).error)?; self.header_bytes = (*pb).bytes_written.max(0) as u64; }
        Ok(())
    }
    fn write(&mut self, packet: &mut Packet, stream: usize, time_base: Rational) -> Result<()> {
        packet.set_stream(stream);
        packet.rescale_ts(time_base, self.context.stream(stream).context("broadcast stream unavailable")?.time_base());
        packet.write_interleaved(&mut self.context)?;
        unsafe {
            let pb = (*self.context.as_mut_ptr()).pb;
            ffi::avio_flush(pb); check((*pb).error)?;
            let end = (*pb).bytes_written.max(0) as u64;
            if end > self.header_bytes { self.first_media_end.get_or_insert(end); }
        }
        Ok(())
    }
    fn bytes(&mut self) -> Result<u64> {
        let network = self.network.as_mut().context("broadcast output unavailable")?;
        network.read_status()?;
        self.media_written |= self.first_media_end.is_some_and(|end| network.bytes >= end);
        Ok(network.bytes)
    }
}
impl Drop for Output {
    fn drop(&mut self) {
        unsafe {
            let ctx = self.context.as_mut_ptr();
            let mut pb = (*ctx).pb;
            (*ctx).pb = ptr::null_mut();
            if !pb.is_null() { ffi::av_free((*pb).buffer.cast()); ffi::avio_context_free(&mut pb); }
        }
    }
}

/// Native network stage, entered only by the supervised broadcast helper process.
pub fn output_worker() -> Result<()> {
    crate::init()?;
    let mut input = std::io::stdin().lock();
    let mut status = std::io::stdout().lock();
    let mut length = [0u8; 4];
    input.read_exact(&mut length)?;
    let length = u32::from_le_bytes(length) as usize;
    ensure!(length <= 16 * 1024, "invalid destination");
    let mut destination = vec![0u8; length];
    input.read_exact(&mut destination)?;
    let url = CString::new(destination).context("invalid destination")?;
    let state = Box::new(Interrupt { stop: Arc::new(AtomicBool::new(false)), origin: Instant::now(), deadline_ms: AtomicU64::new(0) });
    let callback = ffi::AVIOInterruptCB { callback: Some(interrupt), opaque: (&*state as *const Interrupt).cast_mut().cast() };
    struct Io(*mut ffi::AVIOContext);
    impl Drop for Io { fn drop(&mut self) { unsafe { ffi::avio_closep(&mut self.0); } } }
    let mut io = Io(ptr::null_mut());
    let mut options = Dictionary::new();
    options.set("rw_timeout", "5000000"); options.set("tls_verify", "1");
    state.arm(Duration::from_secs(5));
    unsafe {
        let mut raw_options = options.disown();
        let result = ffi::avio_open2(&mut io.0, url.as_ptr(), ffi::AVIO_FLAG_WRITE, &callback, &mut raw_options);
        drop(Dictionary::own(raw_options)); check(result)?;
    }
    status.write_all(&0u64.to_le_bytes())?; status.flush()?;
    let mut buffer = [0u8; 8192];
    loop {
        let n = input.read(&mut buffer)?;
        if n == 0 { break; }
        state.arm(Duration::from_secs(5));
        unsafe {
            ffi::avio_write(io.0, buffer.as_ptr(), n as i32); ffi::avio_flush(io.0); check((*io.0).error)?;
            status.write_all(&((*io.0).bytes_written.max(0) as u64).to_le_bytes())?; status.flush()?;
        }
    }
    state.arm(Duration::from_millis(200));
    Ok(())
}

struct Video {
    encoder: codec::encoder::video::Encoder,
    scaler: Option<software::scaling::Context>,
    frame: frame::Video,
    fitted: (u32, u32),
}
impl Video {
    fn new(s: &Start) -> Result<Self> {
        let codec = encoder::find_by_name("libx264").context("H.264 encoder unavailable")?;
        let mut encoder = codec::context::Context::new_with_codec(codec).encoder().video()?;
        encoder.set_width(s.width); encoder.set_height(s.height); encoder.set_format(format::Pixel::YUV420P);
        encoder.set_time_base((1, 90000)); encoder.set_frame_rate(Some((s.fps as i32, 1)));
        encoder.set_bit_rate(s.bitrate_kbps as usize * 1000); encoder.set_max_bit_rate(s.bitrate_kbps as usize * 1000);
        encoder.set_gop(s.fps * 2); encoder.set_max_b_frames(0);
        encoder.set_flags(codec::flag::Flags::GLOBAL_HEADER | codec::flag::Flags::CLOSED_GOP);
        unsafe {
            let c = encoder.as_mut_ptr();
            (*c).rc_buffer_size = (s.bitrate_kbps * 1000) as i32;
            (*c).thread_count = 4;
            (*c).color_range = ffi::AVColorRange::AVCOL_RANGE_MPEG;
            (*c).colorspace = ffi::AVColorSpace::AVCOL_SPC_BT709;
            (*c).color_primaries = ffi::AVColorPrimaries::AVCOL_PRI_BT709;
            (*c).color_trc = ffi::AVColorTransferCharacteristic::AVCOL_TRC_BT709;
        }
        let mut options = Dictionary::new();
        options.set("preset", "veryfast"); options.set("tune", "zerolatency");
        options.set("x264-params", "nal-hrd=cbr:filler=1:scenecut=0:force-cfr=1");
        let encoder = encoder.open_as_with(codec, options)?;
        let mut frame = frame::Video::empty();
        frame.set_format(format::Pixel::YUV420P); frame.set_width(s.width); frame.set_height(s.height);
        unsafe { check(ffi::av_frame_get_buffer(frame.as_mut_ptr(), 32))?; }
        Ok(Self { encoder, scaler: None, frame, fitted: (0, 0) })
    }
    fn send(&mut self, picture: &Picture, cursor: bool, pts: i64) -> Result<()> {
        if self.scaler.as_ref().is_none_or(|s| (s.input().width, s.input().height) != (picture.width, picture.height)) {
            let ratio = (self.frame.width() as f64 / picture.width as f64).min(self.frame.height() as f64 / picture.height as f64);
            self.fitted = (((picture.width as f64 * ratio) as u32 & !1).max(2), ((picture.height as f64 * ratio) as u32 & !1).max(2));
            let mut scaler = software::scaling::Context::get(format::Pixel::BGRZ, picture.width, picture.height, format::Pixel::YUV420P, self.fitted.0, self.fitted.1, software::scaling::Flags::BILINEAR)?;
            unsafe {
                let coefficients = ffi::sws_getCoefficients(ffi::SWS_CS_ITU709);
                check(ffi::sws_setColorspaceDetails(scaler.as_mut_ptr(), coefficients, 1, coefficients, 0, 0, 1 << 16, 1 << 16))?;
            }
            self.scaler = Some(scaler);
        }
        let bytes = if cursor { blend_cursor(picture) } else { picture.data.clone() };
        unsafe {
            check(ffi::av_frame_make_writable(self.frame.as_mut_ptr()))?;
            let f = self.frame.as_mut_ptr();
            for plane in 0..3 {
                let height = self.frame.height() as usize >> usize::from(plane != 0);
                ptr::write_bytes((*f).data[plane], if plane == 0 { 16 } else { 128 }, (*f).linesize[plane] as usize * height);
            }
            let x = ((self.frame.width() - self.fitted.0) / 2 & !1) as usize;
            let y = ((self.frame.height() - self.fitted.1) / 2 & !1) as usize;
            let mut output = (*f).data;
            for plane in 0..3 {
                let shift = usize::from(plane != 0);
                output[plane] = output[plane].add((y >> shift) * (*f).linesize[plane] as usize + (x >> shift));
            }
            let input = [bytes.as_ptr(), ptr::null(), ptr::null(), ptr::null()];
            let strides = [picture.stride as i32, 0, 0, 0];
            check(ffi::sws_scale(self.scaler.as_mut().unwrap().as_mut_ptr(), input.as_ptr(), strides.as_ptr(), 0, picture.height as i32, output.as_ptr(), (*f).linesize.as_ptr()))?;
        }
        self.frame.set_pts(Some(pts));
        self.encoder.send_frame(&self.frame)?;
        Ok(())
    }
}

struct AudioFeed {
    encoder: codec::encoder::audio::Encoder,
    capture: Option<(crate::Running, std::sync::mpsc::Receiver<crate::audio::PcmChunk>)>,
    resampler: software::resampling::Context,
    samples: VecDeque<(f32, f32)>,
    expected: Option<u64>,
    last_chunk: Instant,
    frame: frame::Audio,
}
impl AudioFeed {
    fn new() -> Result<Self> {
        let codec = encoder::find_by_name("aac").context("AAC encoder unavailable")?;
        let mut encoder = codec::context::Context::new_with_codec(codec).encoder().audio()?;
        encoder.set_rate(44100); encoder.set_channel_layout(ChannelLayout::STEREO);
        encoder.set_format(format::Sample::F32(format::sample::Type::Planar));
        encoder.set_bit_rate(128000); encoder.set_time_base((1, 44100)); encoder.set_flags(codec::flag::Flags::GLOBAL_HEADER);
        let encoder = encoder.open_as(codec)?;
        let mut frame = frame::Audio::empty();
        frame.set_format(encoder.format()); frame.set_samples(encoder.frame_size() as usize); frame.set_channel_layout(ChannelLayout::STEREO); frame.set_rate(44100);
        unsafe { check(ffi::av_frame_get_buffer(frame.as_mut_ptr(), 0))?; }
        Ok(Self { encoder, capture: None, resampler: Self::resampler()?, samples: VecDeque::new(), expected: None, last_chunk: Instant::now(), frame })
    }
    fn resampler() -> Result<software::resampling::Context> {
        Ok(software::resampling::Context::get(format::Sample::F32(format::sample::Type::Packed), ChannelLayout::STEREO, 48000, format::Sample::F32(format::sample::Type::Planar), ChannelLayout::STEREO, 44100)?)
    }
    fn poll(&mut self) -> Result<()> {
        let Some((running, rx)) = &self.capture else { return Ok(()) };
        running.check()?;
        loop {
            let chunk = match rx.try_recv() {
                Ok(chunk) => chunk,
                Err(std::sync::mpsc::TryRecvError::Empty) => break,
                Err(std::sync::mpsc::TryRecvError::Disconnected) => anyhow::bail!("desktop audio ended"),
            };
            if chunk.samples.is_empty() { continue; }
            if self.expected.is_some_and(|position| position != chunk.position) {
                self.samples.clear(); self.resampler = Self::resampler()?;
            }
            self.expected = Some(chunk.position + chunk.samples.len() as u64 / 2);
            let mut input = frame::Audio::empty();
            input.set_format(format::Sample::F32(format::sample::Type::Packed)); input.set_samples(chunk.samples.len() / 2); input.set_channel_layout(ChannelLayout::STEREO); input.set_rate(48000);
            unsafe { check(ffi::av_frame_get_buffer(input.as_mut_ptr(), 0))?; ptr::copy_nonoverlapping(chunk.samples.as_ptr(), (*input.as_mut_ptr()).data[0].cast::<f32>(), chunk.samples.len()); }
            let mut output = frame::Audio::empty();
            self.resampler.run(&input, &mut output)?;
            self.samples.extend(output.plane::<f32>(0).iter().copied().zip(output.plane::<f32>(1).iter().copied()));
            if self.samples.len() > 4410 { self.samples.drain(..self.samples.len() - 4410); }
            self.last_chunk = Instant::now();
        }
        ensure!(self.last_chunk.elapsed() < Duration::from_secs(2), "desktop audio stopped producing samples");
        Ok(())
    }
    fn send(&mut self, pts: i64) -> Result<()> {
        unsafe { check(ffi::av_frame_make_writable(self.frame.as_mut_ptr()))?; }
        for index in 0..self.frame.samples() {
            let (left, right) = self.samples.pop_front().unwrap_or((0.0, 0.0));
            self.frame.plane_mut::<f32>(0)[index] = left;
            self.frame.plane_mut::<f32>(1)[index] = right;
        }
        self.frame.set_pts(Some(pts)); self.encoder.send_frame(&self.frame)?;
        Ok(())
    }
}

#[derive(Clone, Copy)]
enum Failure { Audio, Encoder, Network }
struct Connection { output: Output, video: Video, audio: AudioFeed }
impl Connection {
    fn new(s: &Start, socket: Option<&PathBuf>, stop: Arc<AtomicBool>) -> std::result::Result<Self, Failure> {
        let video = Video::new(s).map_err(|_| Failure::Encoder)?;
        let mut audio = AudioFeed::new().map_err(|_| Failure::Encoder)?;
        if s.audio == Audio::Desktop {
            audio.capture = Some(crate::audio::capture(socket.ok_or(Failure::Audio)?.as_path(), "elsewhere-output").map_err(|_| Failure::Audio)?);
        }
        let mut output = Output::create(stop).map_err(|_| Failure::Encoder)?;
        output.context.add_stream_with(&video.encoder).map_err(|_| Failure::Encoder)?.set_time_base((1, 90000));
        output.context.add_stream_with(&audio.encoder).map_err(|_| Failure::Encoder)?.set_time_base((1, 44100));
        output.connect(s).map_err(|_| Failure::Network)?;
        if let Some((_, rx)) = &audio.capture { while rx.try_recv().is_ok() {} }
        audio.last_chunk = Instant::now();
        Ok(Self { output, video, audio })
    }
    fn drain(encoder: &mut codec::encoder::Encoder, output: &mut Output, stream: usize, time_base: Rational) -> std::result::Result<(), Failure> {
        let mut packet = Packet::empty();
        loop {
            match encoder.receive_packet(&mut packet) {
                Ok(()) => output.write(&mut packet, stream, time_base).map_err(|_| Failure::Network)?,
                Err(ffmpeg::Error::Other { errno: libc::EAGAIN }) | Err(ffmpeg::Error::Eof) => return Ok(()),
                Err(_) => return Err(Failure::Encoder),
            }
        }
    }
}

fn run(settings: Start, socket: Option<PathBuf>, pictures: watch::Receiver<Option<Picture>>, stop: &Arc<AtomicBool>, progress: &Mutex<Progress>) {
    let mut attempts = 0u32;
    let mut consecutive = 0u32;
    while !stop.load(Ordering::Relaxed) {
        let result = Connection::new(&settings, socket.as_ref(), stop.clone()).and_then(|mut connection| {
            let epoch = Instant::now();
            let interval = Duration::from_secs_f64(1.0 / settings.fps as f64);
            let mut next_video = Duration::ZERO;
            let mut audio_pts = 0i64;
            let mut last_bytes = 0;
            let mut last_output = Instant::now();
            let mut sending_since = None;
            while !stop.load(Ordering::Relaxed) {
                connection.audio.poll().map_err(|_| Failure::Audio)?;
                let now = epoch.elapsed();
                if now >= next_video {
                    let picture = pictures.borrow().clone();
                    if let Some(picture) = picture {
                        connection.video.send(&picture, settings.cursor, (now.as_secs_f64() * 90000.0) as i64).map_err(|_| Failure::Encoder)?;
                        Connection::drain(&mut connection.video.encoder, &mut connection.output, 0, (1, 90000).into())?;
                        progress.lock().unwrap_or_else(|e| e.into_inner()).frames += 1;
                    }
                    next_video += interval;
                    if next_video < epoch.elapsed() { next_video = epoch.elapsed() + interval; }
                }
                if now.as_secs_f64() * 44100.0 >= audio_pts as f64 {
                    // A blocked destination never causes a burst of seconds-old speech on recovery.
                    if now.as_secs_f64() * 44100.0 - audio_pts as f64 > 4410.0 { audio_pts = (now.as_secs_f64() * 44100.0) as i64; connection.audio.samples.clear(); }
                    connection.audio.send(audio_pts).map_err(|_| Failure::Encoder)?;
                    Connection::drain(&mut connection.audio.encoder, &mut connection.output, 1, (1, 44100).into())?;
                    audio_pts += connection.audio.frame.samples() as i64;
                }
                let bytes = connection.output.bytes().map_err(|_| Failure::Network)?;
                if bytes > last_bytes {
                    last_output = Instant::now();
                    let mut p = progress.lock().unwrap_or_else(|e| e.into_inner());
                    p.bytes += bytes - last_bytes;
                    if connection.output.media_written && p.frames > 0 && p.state != State::Stopping {
                        p.state = State::Sending; p.error = None;
                        if sending_since.get_or_insert_with(Instant::now).elapsed() >= Duration::from_secs(10) { consecutive = 0; }
                    }
                    last_bytes = bytes;
                }
                if last_output.elapsed() > Duration::from_secs(15) { return Err(Failure::Network); }
                std::thread::sleep(Duration::from_millis(2));
            }
            Ok(())
        });
        if stop.load(Ordering::Relaxed) { return; }
        if let Err(failure) = result {
            if !matches!(failure, Failure::Network) {
                let mut p = progress.lock().unwrap_or_else(|e| e.into_inner()); p.state = State::Failed;
                p.error = Some(if matches!(failure, Failure::Audio) { "Desktop audio became unavailable." } else { "Broadcast encoding failed." }.into());
                return;
            }
        }
        attempts = attempts.saturating_add(1); consecutive = consecutive.saturating_add(1);
        { let mut p = progress.lock().unwrap_or_else(|e| e.into_inner()); if p.state != State::Stopping { p.state = State::Reconnecting; } p.retries = attempts; p.error = Some("Destination disconnected or timed out. Check the address, key and network.".into()); }
        let until = Instant::now() + Duration::from_secs(1u64 << consecutive.min(5));
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
            let dst = dy as usize * p.stride as usize + dx as usize * 4;
            let a = c.rgba[src + 3] as u32;
            for (d, s) in [(0, 2), (1, 1), (2, 0)] { data[dst+d] = ((c.rgba[src+s] as u32 * a + data[dst+d] as u32 * (255-a) + 127) / 255) as u8; }
        }
    }
    data.into()
}
