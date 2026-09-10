//! Docker check: real tiled/linear inputs, modifier changes, fresh keys and released frame leases.
use anyhow::{Context, Result, ensure};
use elsewhere_core::{Codec, EncodedFrame, Frame, FrameBuffer, FrameSink, OutputGeometry, StreamControl, StreamInfo, StreamMsg, Submit};
use elsewhere_stream::{Encoders, FfmpegSink};
use ffmpeg_next as av;
use std::{ffi::c_void, fs::OpenOptions, os::fd::{AsRawFd, FromRawFd, OwnedFd}, path::PathBuf,
    ptr, sync::{Arc, atomic::{AtomicUsize, Ordering}}, time::{Duration, Instant}};

const WIDTH: u32 = 320;
const HEIGHT: u32 = 180;
const FOURCC: u32 = u32::from_le_bytes(*b"AR24");

#[link(name = "gbm")]
unsafe extern "C" {
    fn gbm_create_device(fd: i32) -> *mut c_void;
    fn gbm_device_destroy(device: *mut c_void);
    fn gbm_bo_create_with_modifiers2(device: *mut c_void, width: u32, height: u32, format: u32,
        modifiers: *const u64, count: u32, flags: u32) -> *mut c_void;
    fn gbm_bo_destroy(buffer: *mut c_void);
    fn gbm_bo_get_fd(buffer: *mut c_void) -> i32;
    fn gbm_bo_get_modifier(buffer: *mut c_void) -> u64;
    fn gbm_bo_get_plane_count(buffer: *mut c_void) -> i32;
    fn gbm_bo_get_stride_for_plane(buffer: *mut c_void, plane: i32) -> u32;
    fn gbm_bo_get_offset(buffer: *mut c_void, plane: i32) -> u32;
    fn gbm_bo_map(buffer: *mut c_void, x: u32, y: u32, width: u32, height: u32, flags: u32,
        stride: *mut u32, map: *mut *mut c_void) -> *mut c_void;
    fn gbm_bo_unmap(buffer: *mut c_void, map: *mut c_void);
}

struct Device { raw: *mut c_void, _fd: OwnedFd }
impl Drop for Device { fn drop(&mut self) { unsafe { gbm_device_destroy(self.raw) }; } }
struct Buffer<'a> { raw: *mut c_void, _device: &'a Device, modifier: u64, stride: u32, offset: u32 }
impl Drop for Buffer<'_> { fn drop(&mut self) { unsafe { gbm_bo_destroy(self.raw) }; } }
impl<'a> Buffer<'a> {
    fn new(device: &'a Device, modifier: u64, rgb: [u8; 3]) -> Result<Self> {
        // GBM_BO_USE_RENDERING; the explicit modifier selects the allocation layout.
        let raw = unsafe { gbm_bo_create_with_modifiers2(device.raw, WIDTH, HEIGHT, FOURCC, &modifier, 1, 4) };
        ensure!(!raw.is_null(), "GBM cannot allocate requested modifier {modifier:#x}");
        let buffer = Self { raw, _device: device, modifier: unsafe { gbm_bo_get_modifier(raw) },
            stride: unsafe { gbm_bo_get_stride_for_plane(raw, 0) }, offset: unsafe { gbm_bo_get_offset(raw, 0) } };
        ensure!(unsafe { gbm_bo_get_plane_count(raw) } == 1, "GBM allocation must have one plane");
        let (mut stride, mut map) = (0, ptr::null_mut());
        let data = unsafe { gbm_bo_map(raw, 0, 0, WIDTH, HEIGHT, 2, &mut stride, &mut map) };
        ensure!(!data.is_null() && data != libc::MAP_FAILED, "map GBM pixels");
        if stride < WIDTH * 4 {
            unsafe { gbm_bo_unmap(raw, map) };
            anyhow::bail!("GBM map stride is too short");
        }
        for y in 0..HEIGHT as usize {
            let row = unsafe { std::slice::from_raw_parts_mut(data.cast::<u8>().add(y * stride as usize), WIDTH as usize * 4) };
            for pixel in row.chunks_exact_mut(4) { pixel.copy_from_slice(&[rgb[2], rgb[1], rgb[0], 255]); }
        }
        unsafe { gbm_bo_unmap(raw, map) };
        Ok(buffer)
    }
    fn frame(&self, seq: u64, leases: &Arc<Leases>) -> Result<Frame> {
        let fd = unsafe { gbm_bo_get_fd(self.raw) };
        ensure!(fd >= 0, "export GBM buffer");
        leases.created.fetch_add(1, Ordering::Relaxed);
        Ok(Frame { width: WIDTH, height: HEIGHT, fourcc: FOURCC, pts: Duration::from_micros(seq * 33_333), seq, refine: false,
            buffer: FrameBuffer::Dmabuf { fd: unsafe { OwnedFd::from_raw_fd(fd) }, modifier: self.modifier,
                stride: self.stride, offset: self.offset, slot_id: seq as u32, lease: Box::new(Lease(leases.clone())) } })
    }
}

#[derive(Default)]
struct Leases { created: AtomicUsize, released: AtomicUsize }
struct Lease(Arc<Leases>);
impl Drop for Lease { fn drop(&mut self) { self.0.released.fetch_add(1, Ordering::Relaxed); } }

fn resources() -> Result<(usize, usize)> {
    let fds = std::fs::read_dir("/proc/self/fd")?.count();
    let mut workers = 0;
    for task in std::fs::read_dir("/proc/self/task")? {
        if std::fs::read_to_string(task?.path().join("comm")).is_ok_and(|name| name.trim() == "video-encoder") { workers += 1; }
    }
    Ok((fds, workers))
}

fn decode(frame: &EncodedFrame, green: bool) -> Result<()> {
    let codec = av::decoder::find(av::codec::Id::H264).context("H264 decoder")?;
    let mut decoder = av::codec::Context::new_with_codec(codec).decoder().video()?;
    decoder.send_packet(&av::Packet::copy(&frame.data))?;
    decoder.send_eof()?;
    let mut picture = av::frame::Video::empty();
    decoder.receive_frame(&mut picture)?;
    ensure!((picture.width(), picture.height()) == (WIDTH, HEIGHT), "decoded geometry");
    ensure!(picture.format() == av::format::Pixel::YUV420P, "unexpected decoded pixel format");
    let expected: [i16; 3] = if green { [173, 42, 26] } else { [63, 102, 240] };
    for (plane, wanted) in expected.into_iter().enumerate() {
        let scale = if plane == 0 { 1 } else { 2 };
        let at = (HEIGHT as usize / scale / 2) * picture.stride(plane) + WIDTH as usize / scale / 2;
        ensure!((i16::from(picture.data(plane)[at]) - wanted).abs() <= 12, "decoded color plane {plane}");
    }
    Ok(())
}

fn encode(sink: &mut FfmpegSink, buffer: &Buffer<'_>, seq: u64, leases: &Arc<Leases>, rx: &mut tokio::sync::mpsc::Receiver<StreamMsg>, info: &mut Option<StreamInfo>) -> Result<EncodedFrame> {
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        while let Ok(message) = rx.try_recv() {
            match message {
                StreamMsg::Info(_, value) => *info = Some(value),
                StreamMsg::Frame(_, value) if value.pts_us == seq * 33_333 => return Ok(value),
                StreamMsg::Frame(_, _) => {},
                _ => anyhow::bail!("unexpected encoder failure or audio"),
            }
        }
        ensure!(Instant::now() < deadline, "complete input did not produce a packet");
        sink.submit(buffer.frame(seq, leases)?).map_err(|e| anyhow::anyhow!("{e}"))?;
        std::thread::sleep(Duration::from_millis(2));
    }
}

fn main() -> Result<()> {
    let node = PathBuf::from(std::env::var_os("ELSEWHERE_TEST_RENDER_NODE").unwrap_or_else(|| "/dev/dri/renderD128".into()));
    // The external DRM modifier selects the rig's tiled allocation; it is checked against the export.
    let modifier = std::env::var("ELSEWHERE_TEST_TILED_MODIFIER").unwrap_or_else(|_| "0x0100000000000009".into());
    let tiled = u64::from_str_radix(modifier.trim_start_matches("0x"), 16)?;
    let fd: OwnedFd = OpenOptions::new().read(true).write(true).open(&node)?.into();
    let raw = unsafe { gbm_create_device(fd.as_raw_fd()) };
    ensure!(!raw.is_null(), "create GBM device");
    let device = Device { raw, _fd: fd };
    let buffers = [Buffer::new(&device, tiled, [255, 0, 0])?, Buffer::new(&device, 0, [0, 255, 0])?];
    ensure!(buffers[0].modifier == tiled && tiled != 0 && tiled != 0x00ff_ffff_ffff_ffff, "test needs a real tiled export");
    ensure!(matches!(buffers[1].modifier, 0 | 0x00ff_ffff_ffff_ffff), "test needs a real linear export");
    let encoders = Encoders::probe(Some(&node), false, &[Codec::H264])?;
    ensure!(encoders.codecs().contains(&Codec::H264), "H264 VA encoding unavailable");
    let baseline = resources()?;
    let leases = Arc::new(Leases::default());
    let (tx, mut rx) = tokio::sync::mpsc::channel(2);
    let redraws = Arc::new(AtomicUsize::new(0));
    let redraw = redraws.clone();
    let mut sink = FfmpegSink::new(4000, encoders, tx, Arc::new(move || { redraw.fetch_add(1, Ordering::Relaxed); }))?;
    let control = sink.control();
    control.set_codec(Codec::H264);
    let geometry = OutputGeometry { width_px: WIDTH, height_px: HEIGHT, scale: 1.0, refresh_mhz: 30_000 };
    let mut info = None::<StreamInfo>;
    let mut previous = None;
    for transition in 0..6 {
        let buffer = &buffers[transition % 2];
        let requested = redraws.load(Ordering::Relaxed);
        sink.output_changed(geometry, FOURCC, buffer.modifier);
        let deadline = Instant::now() + Duration::from_secs(5);
        while redraws.load(Ordering::Relaxed) == requested || control.effort().encoder.is_none() {
            ensure!(Instant::now() < deadline, "modifier reopen did not request a complete frame");
            std::thread::sleep(Duration::from_millis(2));
        }
        let seq = transition as u64 * 2 + 1;
        let frame = encode(&mut sink, buffer, seq, &leases, &mut rx, &mut info)?;
        ensure!(frame.keyframe && Some(frame.stream_id) != previous, "modifier change requires a new stream key");
        ensure!(info.as_ref().is_some_and(|info| info.stream_id == frame.stream_id), "Info must precede its frame");
        ensure!(!control.effort().pending, "first key delivery completes encoder startup");
        decode(&frame, transition % 2 == 1)?;
        let rejected = Arc::new(Leases::default());
        for attempt in 0..20 {
            while let Ok(message) = rx.try_recv() {
                ensure!(matches!(message, StreamMsg::Frame(_, _)), "unexpected message during stale-input rejection");
            }
            let stale = buffers[(transition + 1) % 2].frame(900 + transition as u64, &rejected)?;
            ensure!(sink.submit(stale).map_err(|e| anyhow::anyhow!("{e}"))? == Submit::Held, "stale modifier was accepted");
            ensure!(rejected.released.load(Ordering::Relaxed) == attempt + 1, "stale modifier retained its lease");
            std::thread::sleep(Duration::from_millis(2));
        }
        control.request_keyframe();
        let continued = encode(&mut sink, buffer, seq + 1, &leases, &mut rx, &mut info)?;
        ensure!(continued.keyframe && continued.stream_id == frame.stream_id, "valid input must recover in the same stream after stale input");
        decode(&continued, transition % 2 == 1)?;
        previous = Some(frame.stream_id);
        println!("transition={transition} modifier={:#x} stream_id={} pts_us={}", buffer.modifier, frame.stream_id, frame.pts_us);
    }
    drop(sink);
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        while rx.try_recv().is_ok() {}
        if rx.is_closed() && leases.created.load(Ordering::Relaxed) == leases.released.load(Ordering::Relaxed) && resources()? == baseline { break; }
        ensure!(Instant::now() < deadline, "GPU teardown retained leases, descriptors or workers: {:?}, baseline {baseline:?}", resources()?);
        std::thread::sleep(Duration::from_millis(5));
    }
    ensure!(control.effort().encoder.is_none(), "control keeps a dead worker alive");
    println!("six modifier transitions, fresh decoded keys, stale-input rejection and all {} leases released", leases.created.load(Ordering::Relaxed));
    Ok(())
}
