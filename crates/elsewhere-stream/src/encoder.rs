//! Low-delay viewer encoders and conversion from owned CPU pictures.
use std::{ffi::CString, os::fd::{AsRawFd, OwnedFd}, path::{Path, PathBuf}, ptr, sync::Arc};
use anyhow::{Context, Result, bail, ensure};
use elsewhere_core::{Codec, EffortState, EncodingEffort, Frame, FrameBuffer, FrameTransport, Quality};
use ffmpeg_next::{self as ffmpeg, ffi as av, format::Pixel};

const TIME_BASE: (i32, i32) = (1, 1_000_000);
pub(crate) const BUFFER_MS: u32 = 100;

#[derive(Clone, Debug)]
pub(crate) struct Choice { pub codec: Codec, pub name: &'static str, pub low_power: bool }

#[derive(Debug)]
pub(crate) enum Backend { Vaapi(PathBuf), Nvenc(i32), Software }

/// Encoders proven to produce a recovery picture on the selected device.
pub struct Encoders { pub(crate) backend: Backend, transport: FrameTransport, choices: Vec<Choice> }

impl Encoders {
    pub fn probe(node: Option<&Path>, software: bool, allowed: &[Codec]) -> Result<Arc<Self>> {
        crate::init()?;
        let mut choices = Vec::new();
        let order = [Codec::H264, Codec::Hevc, Codec::Av1, Codec::Vp9, Codec::Vp8];
        let nvidia = node.map(crate::nvidia::pci_device).transpose()?.flatten();
        let backend = if software || node.is_none() { Backend::Software }
            else if let Some(pci) = &nvidia { Backend::Nvenc(crate::nvidia::cuda_device(pci)?) }
            else { Backend::Vaapi(node.unwrap().to_path_buf()) };
        let transport = if nvidia.is_some() || node.is_none() { FrameTransport::Memory }
            else if software { FrameTransport::LinearDmabuf } else { FrameTransport::Dmabuf };
        let hardware = match &backend { Backend::Vaapi(node) => Some(ProbeFrames::new(node)
            .context("open VA-API encoder device; use --software-encoding for CPU encoding")?), _ => None };
        for codec in order.into_iter().filter(|codec| allowed.contains(codec)) {
            let names: &[&'static str] = match (&backend, codec) {
                (Backend::Vaapi(_), Codec::H264) => &["h264_vaapi"],
                (Backend::Vaapi(_), Codec::Hevc) => &["hevc_vaapi"],
                (Backend::Vaapi(_), Codec::Vp9) => &["vp9_vaapi"],
                (Backend::Vaapi(_), Codec::Av1) => &["av1_vaapi"],
                (Backend::Vaapi(_), Codec::Vp8) => &[],
                (Backend::Nvenc(_), Codec::H264) => &["h264_nvenc"],
                (Backend::Nvenc(_), Codec::Hevc) => &["hevc_nvenc"],
                (Backend::Nvenc(_), Codec::Av1) => &["av1_nvenc"],
                (Backend::Nvenc(_), Codec::Vp8 | Codec::Vp9) => &[],
                (Backend::Software, Codec::H264) => &["libx264", "libopenh264"],
                (Backend::Software, Codec::Hevc) => &["libx265"],
                (Backend::Software, Codec::Vp8) => &["libvpx"],
                (Backend::Software, Codec::Vp9) => &["libvpx-vp9"],
                (Backend::Software, Codec::Av1) => &["libaom-av1"],
            };
            'candidate: for &name in names {
                if ffmpeg::encoder::find_by_name(name).is_none() { continue; }
                for low_power in [false, true].into_iter().take(if hardware.is_some() { 2 } else { 1 }) {
                    let choice = Choice { codec, name, low_power };
                    let result = (|| -> Result<()> {
                        let mut enc = VideoEncoder::open(&choice, &backend, (320, 180), 30, Quality { bitrate_kbps: 1000, max_fps: 0 }, EncodingEffort::Fast, hardware.as_ref().map_or(ptr::null_mut(), |h| h.frames))?;
                        let frame = if let Some(hardware) = &hardware { hardware.picture()? } else { black(Pixel::YUV420P, 320, 180) };
                        let packets = enc.encode(frame, true)?;
                        let key = packets.iter().find(|p| p.is_key()).context("encoder did not produce a recovery keyframe")?;
                        super::codec_string(codec, key.data().context("empty keyframe")?, 320, 180).context("keyframe lacks codec configuration")?;
                        Ok(())
                    })();
                    match result {
                        Ok(()) => { choices.push(choice); break 'candidate; }
                        Err(error) => tracing::debug!(name, low_power, %error, "encoder probe failed"),
                    }
                }
            }
        }
        ensure!(!choices.is_empty(), "no usable FFmpeg video encoder for {backend:?}; check the GPU driver and FFmpeg build, or use --software-encoding");
        tracing::info!(?backend, ?transport, encoders = ?choices.iter().map(|c| c.name).collect::<Vec<_>>(), "verified video encoders");
        Ok(Arc::new(Self { backend, transport, choices }))
    }

    pub fn frame_transport(&self) -> FrameTransport { self.transport }

    pub fn validate_frame(&self, frame: Frame) -> Result<()> {
        if let Backend::Vaapi(node) = &self.backend { return crate::gpu::probe(node, frame); }
        let size = (frame.width, frame.height);
        let mut converter = SoftwareConverter::new(size.0, size.1, frame.fourcc, size)?;
        let picture = converter.convert(frame)?;
        if matches!(self.backend, Backend::Nvenc(_)) {
            VideoEncoder::open(&self.choices[0], &self.backend, size, 60,
                Quality { bitrate_kbps: 1000, max_fps: 0 }, EncodingEffort::Fast, ptr::null_mut())?.encode(picture, true)?;
        }
        Ok(())
    }

    pub fn codecs(&self) -> Vec<Codec> { self.choices.iter().map(|c| c.codec).collect() }
    pub(crate) fn choice(&self, codec: Codec) -> Result<&Choice> {
        self.choices.iter().find(|c| c.codec == codec).context("selected video codec is unavailable")
    }
}

pub(crate) struct VideoEncoder {
    context: ffmpeg::codec::encoder::video::Encoder,
    pub effort: EffortState,
    pub live_rate: bool,
}

impl VideoEncoder {
    pub fn open(choice: &Choice, backend: &Backend, size: (u32, u32), fps: u32, quality: Quality, effort: EncodingEffort, hw_frames: *mut av::AVBufferRef) -> Result<Self> {
        let codec = ffmpeg::encoder::find_by_name(choice.name).context("FFmpeg encoder unavailable")?;
        let (width, height) = size;
        ensure!(width >= 2 && height >= 2 && width <= 8192 && height <= 8192 && width % 2 == 0 && height % 2 == 0, "invalid video dimensions");
        ensure!(fps > 0 && fps <= 1000, "invalid video frame rate");
        let mut video = unsafe {
            let raw = av::avcodec_alloc_context3(codec.as_ptr());
            ensure!(!raw.is_null(), "allocate video encoder");
            ffmpeg::codec::Context::wrap(raw, None).encoder().video()?
        };
        video.set_width(width);
        video.set_height(height);
        video.set_time_base(TIME_BASE);
        video.set_frame_rate(Some((fps as i32, 1)));
        video.set_format(if hw_frames.is_null() { Pixel::YUV420P } else { Pixel::VAAPI });
        video.set_max_b_frames(0);
        video.set_gop(if matches!(backend, Backend::Software) { i32::MAX as u32 } else { 1024 });
        video.set_qmin(0);
        // VA uses native quantizer indices; software VP9/AV1 expose the 0..63 scale.
        video.set_qmax(match choice.codec {
            Codec::H264 | Codec::Hevc => 51,
            Codec::Vp9 | Codec::Av1 if matches!(backend, Backend::Vaapi(_)) => 255,
            Codec::Av1 if matches!(backend, Backend::Nvenc(_)) => 255,
            _ => 63,
        });
        let mut options = ffmpeg::Dictionary::new();
        let index = match effort { EncodingEffort::Fast => 0, EncodingEffort::Balanced => 1, EncodingEffort::High => 2 };
        let mut state = EffortState { requested: effort, applied: Some(effort), encoder: Some(choice.name.into()), setting: None, pending: true };
        unsafe {
            let ctx = &mut *video.as_mut_ptr();
            ctx.thread_count = 4;
            ctx.refs = 1;
            ctx.profile = match choice.codec { Codec::H264 => 77, Codec::Hevc => 1, _ => 0 };
            ctx.colorspace = av::AVColorSpace::AVCOL_SPC_BT709;
            ctx.color_range = av::AVColorRange::AVCOL_RANGE_MPEG;
            ctx.color_primaries = av::AVColorPrimaries::AVCOL_PRI_BT709;
            ctx.color_trc = av::AVColorTransferCharacteristic::AVCOL_TRC_BT709;
            rate(ctx, quality.bitrate_kbps)?;
            if !hw_frames.is_null() {
                ctx.hw_frames_ctx = av::av_buffer_ref(hw_frames);
                ensure!(!ctx.hw_frames_ctx.is_null(), "reference hardware frame pool");
                options.set("rc_mode", "CBR");
                options.set("async_depth", "1");
                options.set("low_power", if choice.low_power { "1" } else { "0" });
                if let Some(maximum) = crate::gpu::quality_range(hw_frames, choice.codec, choice.low_power).filter(|&n| n > 0) {
                    let level = [maximum, maximum.div_ceil(2), 1][index];
                    ctx.compression_level = level as i32;
                    state.setting = Some(format!("compression_level={level}"));
                } else { state.applied = None; }
            } else if let Backend::Nvenc(gpu) = backend {
                options.set("gpu", &gpu.to_string());
                let preset = ["p1", "p3", "p5"][index];
                options.set("preset", preset);
                options.set("tune", "ull");
                options.set("rc", "cbr");
                options.set("rc-lookahead", "0");
                options.set("zerolatency", "1");
                options.set("delay", "0");
                if choice.codec != Codec::Av1 { options.set("forced-idr", "1"); }
                state.setting = Some(format!("preset={preset}"));
            } else {
                match choice.name {
                    "libx264" => {
                        let preset = ["superfast", "fast", "medium"][index];
                        options.set("preset", preset);
                        options.set("tune", "zerolatency");
                        options.set("forced-idr", "1");
                        options.set("x264-params", "repeat-headers=1:scenecut=0");
                        state.setting = Some(format!("preset={preset}"));
                    }
                    "libx265" => {
                        let preset = ["ultrafast", "superfast", "fast"][index];
                        options.set("preset", preset);
                        options.set("tune", "zerolatency");
                        options.set("forced-idr", "1");
                        options.set("x265-params", "repeat-headers=1:scenecut=0:open-gop=0:log-level=error:frame-threads=1:pools=4");
                        state.setting = Some(format!("preset={preset}"));
                    }
                    "libvpx" | "libvpx-vp9" => {
                        // VP9 speeds 5 and above enable native realtime CBR overshoot handling.
                        let speed = if choice.codec == Codec::Vp8 { ["8", "4", "2"][index] } else { ["8", "6", "5"][index] };
                        options.set("deadline", "realtime");
                        options.set("lag-in-frames", "0");
                        options.set("auto-alt-ref", "0");
                        options.set("cpu-used", speed);
                        if choice.codec == Codec::Vp9 {
                            options.set("row-mt", "1");
                            // Keep buffer compensation below the delivery budget and repay deficits promptly.
                            options.set("overshoot-pct", "0");
                            options.set("undershoot-pct", "100");
                        }
                        state.setting = Some(format!("cpu-used={speed}"));
                    }
                    "libaom-av1" => {
                        let speed = ["8", "6", "4"][index];
                        options.set("usage", "realtime");
                        options.set("lag-in-frames", "0");
                        options.set("auto-alt-ref", "0");
                        options.set("row-mt", "1");
                        options.set("cpu-used", speed);
                        state.setting = Some(format!("cpu-used={speed}"));
                    }
                    "libopenh264" => { state.applied = None; }
                    _ => bail!("unknown software encoder"),
                }
            }
            let mut raw_options = options.disown();
            let result = av::avcodec_open2(video.as_mut_ptr(), codec.as_ptr(), &mut raw_options);
            let unused = ffmpeg::Dictionary::own(raw_options);
            check(result).context("open video encoder")?;
            ensure!(unused.iter().next().is_none(), "video encoder rejected options: {unused:?}");
        }
        Ok(Self { context: ffmpeg::codec::encoder::video::Encoder(video), effort: state, live_rate: choice.name == "libx264" })
    }

    pub fn set_rate(&mut self, kbps: u32) -> Result<()> {
        ensure!(self.live_rate, "encoder requires reopening for bitrate changes");
        unsafe { rate(&mut *self.context.as_mut_ptr(), kbps) }
    }

    pub fn encode(&mut self, mut frame: ffmpeg::frame::Video, keyframe: bool) -> Result<Vec<ffmpeg::Packet>> {
        frame.set_kind(if keyframe { ffmpeg::picture::Type::I } else { ffmpeg::picture::Type::None });
        self.context.send_frame(&frame).context("submit video frame")?;
        let mut packets = Vec::new();
        loop {
            let mut packet = ffmpeg::Packet::empty();
            match self.context.receive_packet(&mut packet) {
                Ok(()) => packets.push(packet),
                Err(ffmpeg::Error::Other { errno: libc::EAGAIN }) => break,
                Err(error) => return Err(error).context("receive video packet"),
            }
        }
        ensure!(!packets.is_empty(), "low-delay encoder buffered its input frame");
        ensure!(packets.len() == 1, "video encoder returned multiple packets for one input frame");
        Ok(packets)
    }
}

fn rate(context: &mut av::AVCodecContext, kbps: u32) -> Result<()> {
    ensure!(kbps > 0 && kbps <= 4_294_967, "video bitrate is out of range");
    // Reserve 10% of the delivery budget for variation in native rate control.
    let bps = i64::from(kbps) * 900;
    context.bit_rate = bps;
    context.rc_min_rate = bps;
    context.rc_max_rate = bps;
    context.rc_buffer_size = i32::try_from(bps * i64::from(BUFFER_MS) / 1000).context("video rate buffer is too large")?;
    context.rc_initial_buffer_occupancy = context.rc_buffer_size * 3 / 4;
    tracing::debug!(stream_target_kbps = kbps, encoder_target_bps = bps, buffer_bits = context.rc_buffer_size, "ffmpeg video rate");
    Ok(())
}

pub(crate) fn check(code: i32) -> Result<()> { if code < 0 { Err(ffmpeg::Error::from(code).into()) } else { Ok(()) } }

pub(crate) struct SoftwareConverter { context: ffmpeg::software::scaling::Context, size: (u32, u32) }
impl SoftwareConverter {
    pub fn new(width: u32, height: u32, fourcc: u32, target: (u32, u32)) -> Result<Self> {
        ensure!([u32::from_le_bytes(*b"XR24"), u32::from_le_bytes(*b"AR24")].contains(&fourcc), "unsupported RGB layout");
        let mut context = ffmpeg::software::scaling::Context::get(Pixel::BGRA, width, height, Pixel::YUV420P, target.0, target.1, ffmpeg::software::scaling::Flags::BILINEAR)?;
        unsafe {
            let coefficients = av::sws_getCoefficients(av::SWS_CS_ITU709);
            check(av::sws_setColorspaceDetails(context.as_mut_ptr(), coefficients, 1, coefficients, 0, 0, 1 << 16, 1 << 16))?;
        }
        Ok(Self { context, size: target })
    }

    pub fn convert(&mut self, frame: Frame) -> Result<ffmpeg::frame::Video> {
        let (width, height) = (frame.width, frame.height);
        let mut converted = ffmpeg::frame::Video::new(Pixel::YUV420P, self.size.0, self.size.1);
        let convert = |context: &mut ffmpeg::software::scaling::Context, output: &mut ffmpeg::frame::Video, data: &[u8], stride: u32| -> Result<()> {
            ensure!(stride >= width.checked_mul(4).context("invalid RGB width")? && stride <= i32::MAX as u32, "invalid RGB stride");
            let required = (height as usize).checked_sub(1).and_then(|h| h.checked_mul(stride as usize)).and_then(|n| n.checked_add(width as usize * 4)).context("invalid RGB size")?;
            ensure!(data.len() >= required, "truncated RGB frame");
            unsafe {
                let input = [data.as_ptr(), ptr::null(), ptr::null(), ptr::null()];
                let strides = [stride as i32, 0, 0, 0];
                let out = &mut *output.as_mut_ptr();
                let rows = av::sws_scale(context.as_mut_ptr(), input.as_ptr(), strides.as_ptr(), 0, height as i32, out.data.as_ptr(), out.linesize.as_ptr());
                ensure!(rows == output.height() as i32, "incomplete RGB conversion");
            }
            Ok(())
        };
        match &frame.buffer {
            FrameBuffer::Memory { data, stride } => convert(&mut self.context, &mut converted, data, *stride)?,
            FrameBuffer::Dmabuf { fd, modifier, stride, offset, .. } => {
                ensure!(*modifier == 0 || *modifier == 0x00ff_ffff_ffff_ffff, "software encoding requires a linear DMA-buf");
                let mapping = Mapping::read(fd)?;
                let data = mapping.bytes().get(*offset as usize..).context("DMA-buf plane offset exceeds allocation")?;
                convert(&mut self.context, &mut converted, data, *stride)?;
            }
        }
        converted.set_pts(Some(i64::try_from(frame.pts.as_micros()).context("video timestamp overflow")?));
        unsafe { set_color(&mut *converted.as_mut_ptr()); }
        Ok(converted)
    }
}

struct Mapping<'a> { fd: &'a OwnedFd, address: *mut libc::c_void, size: usize }
impl<'a> Mapping<'a> {
    fn read(fd: &'a OwnedFd) -> Result<Self> {
        let size = unsafe { libc::lseek(fd.as_raw_fd(), 0, libc::SEEK_END) };
        ensure!(size > 0, "invalid DMA-buf allocation size");
        sync(fd, false)?;
        let address = unsafe { libc::mmap(ptr::null_mut(), size as usize, libc::PROT_READ, libc::MAP_SHARED, fd.as_raw_fd(), 0) };
        if address == libc::MAP_FAILED { let error = std::io::Error::last_os_error(); let _ = sync(fd, true); return Err(error).context("map linear DMA-buf"); }
        Ok(Self { fd, address, size: size as usize })
    }
    fn bytes(&self) -> &[u8] { unsafe { std::slice::from_raw_parts(self.address.cast(), self.size) } }
}
impl Drop for Mapping<'_> {
    fn drop(&mut self) {
        unsafe { libc::munmap(self.address, self.size); }
        if let Err(error) = sync(self.fd, true) { tracing::warn!(%error, "end DMA-buf CPU read"); }
    }
}
fn sync(fd: &OwnedFd, end: bool) -> Result<()> {
    // Linux DMA_BUF_IOCTL_SYNC, with READ and optional END flags.
    let flags: u64 = 1 | if end { 4 } else { 0 };
    loop {
        if unsafe { libc::ioctl(fd.as_raw_fd(), 0x4008_6200, &flags) } == 0 { return Ok(()); }
        let error = std::io::Error::last_os_error();
        if error.kind() != std::io::ErrorKind::Interrupted { return Err(error).context("synchronize DMA-buf CPU read"); }
    }
}

fn set_color(frame: &mut av::AVFrame) {
    frame.colorspace = av::AVColorSpace::AVCOL_SPC_BT709;
    frame.color_range = av::AVColorRange::AVCOL_RANGE_MPEG;
    frame.color_primaries = av::AVColorPrimaries::AVCOL_PRI_BT709;
    frame.color_trc = av::AVColorTransferCharacteristic::AVCOL_TRC_BT709;
}

fn black(format: Pixel, width: u32, height: u32) -> ffmpeg::frame::Video {
    let mut frame = ffmpeg::frame::Video::new(format, width, height);
    for plane in 0..frame.planes() { frame.data_mut(plane).fill(if plane == 0 { 16 } else { 128 }); }
    frame.set_pts(Some(0));
    unsafe { set_color(&mut *frame.as_mut_ptr()); }
    frame
}

struct ProbeFrames { frames: *mut av::AVBufferRef }
impl ProbeFrames {
    fn new(node: &Path) -> Result<Self> {
        use std::os::unix::ffi::OsStrExt;
        let path = CString::new(node.as_os_str().as_bytes())?;
        unsafe {
            let mut device = ptr::null_mut();
            check(av::av_hwdevice_ctx_create(&mut device, av::AVHWDeviceType::AV_HWDEVICE_TYPE_VAAPI, path.as_ptr(), ptr::null_mut(), 0))?;
            let frames = av::av_hwframe_ctx_alloc(device);
            av::av_buffer_unref(&mut device);
            ensure!(!frames.is_null(), "allocate hardware probe frames");
            let owner = Self { frames };
            let context = &mut *((*frames).data.cast::<av::AVHWFramesContext>());
            context.format = av::AVPixelFormat::AV_PIX_FMT_VAAPI;
            context.sw_format = av::AVPixelFormat::AV_PIX_FMT_NV12;
            context.width = 320;
            context.height = 180;
            context.initial_pool_size = 2;
            check(av::av_hwframe_ctx_init(frames))?;
            Ok(owner)
        }
    }
    fn picture(&self) -> Result<ffmpeg::frame::Video> {
        let cpu = black(Pixel::NV12, 320, 180);
        let mut hardware = ffmpeg::frame::Video::empty();
        unsafe {
            check(av::av_hwframe_get_buffer(self.frames, hardware.as_mut_ptr(), 0))?;
            check(av::av_hwframe_transfer_data(hardware.as_mut_ptr(), cpu.as_ptr(), 0))?;
            check(av::av_frame_copy_props(hardware.as_mut_ptr(), cpu.as_ptr()))?;
        }
        Ok(hardware)
    }
}
impl Drop for ProbeFrames { fn drop(&mut self) { unsafe { av::av_buffer_unref(&mut self.frames); } } }
