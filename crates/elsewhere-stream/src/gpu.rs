//! DMA-buf import and VAAPI conversion. Compositor leases end after conversion completes;
//! encoder references own separate NV12 surfaces.

use std::{any::Any, ffi::CString, io::{Seek, SeekFrom}, os::{fd::{AsRawFd, OwnedFd}, unix::ffi::OsStrExt}, path::Path, ptr};

use anyhow::{Context, Result, ensure};
use elsewhere_core::{Codec, Frame, FrameBuffer};
use ffmpeg_next::{self as ffmpeg, ffi, frame::Video};

#[link(name = "va")]
unsafe extern "C" {
    fn vaSyncSurface(display: ffi::VADisplay, surface: ffi::VASurfaceID) -> i32;
    fn vaGetConfigAttributes(display: ffi::VADisplay, profile: i32, entrypoint: i32, attributes: *mut ConfigAttribute, count: i32) -> i32;
}

#[repr(C)]
struct ConfigAttribute { kind: i32, value: u32 }

struct Buffer(*mut ffi::AVBufferRef);

impl Drop for Buffer {
    fn drop(&mut self) { unsafe { ffi::av_buffer_unref(&mut self.0) }; }
}

fn checked(code: i32, operation: &'static str) -> Result<()> {
    if code < 0 { Err(ffmpeg::Error::from(code)).context(operation) } else { Ok(()) }
}

fn video() -> Result<Video> {
    let frame = Video::empty();
    ensure!(!unsafe { frame.as_ptr() }.is_null(), "allocate video frame");
    Ok(frame)
}

fn device(node: &Path) -> Result<Buffer> {
    let path = CString::new(node.as_os_str().as_bytes()).context("render node contains NUL")?;
    let mut device = Buffer(ptr::null_mut());
    checked(unsafe { ffi::av_hwdevice_ctx_create(&mut device.0, ffi::AVHWDeviceType::AV_HWDEVICE_TYPE_VAAPI, path.as_ptr(), ptr::null_mut(), 0) }, "open VAAPI device")?;
    Ok(device)
}

fn frames(device: &Buffer, width: u32, height: u32, format: ffi::AVPixelFormat) -> Result<Buffer> {
    let frames = Buffer(unsafe { ffi::av_hwframe_ctx_alloc(device.0) });
    ensure!(!frames.0.is_null(), "allocate VAAPI frame context");
    unsafe {
        let context = &mut *(*frames.0).data.cast::<ffi::AVHWFramesContext>();
        context.format = ffi::AVPixelFormat::AV_PIX_FMT_VAAPI;
        context.sw_format = format;
        context.width = width.try_into().context("source width exceeds encoder limits")?;
        context.height = height.try_into().context("source height exceeds encoder limits")?;
        checked(ffi::av_hwframe_ctx_init(frames.0), "initialize VAAPI frame context")?;
    }
    Ok(frames)
}

fn pixel_format(fourcc: u32) -> Result<ffi::AVPixelFormat> {
    match fourcc.to_le_bytes() {
        [b'A', b'R', b'2', b'4'] => Ok(ffi::AVPixelFormat::AV_PIX_FMT_BGRA),
        [b'X', b'R', b'2', b'4'] => Ok(ffi::AVPixelFormat::AV_PIX_FMT_BGR0),
        _ => anyhow::bail!("unsupported compositor fourcc {fourcc:#x}"),
    }
}

fn validate_layout(width: u32, height: u32, stride: u32, offset: u32, size: u64) -> Result<()> {
    ensure!(width > 0 && height > 0 && width <= i32::MAX as u32 && height <= i32::MAX as u32, "invalid DMA-buf dimensions");
    let row = u64::from(width) * 4;
    ensure!(u64::from(stride) >= row, "DMA-buf pitch is smaller than a pixel row");
    let end = u64::from(offset) + u64::from(height - 1) * u64::from(stride) + row;
    // libva's PRIME descriptors represent allocation sizes with uint32_t.
    ensure!(end <= size && size <= u32::MAX as u64, "DMA-buf plane exceeds its allocation");
    Ok(())
}

struct Input {
    descriptor: ffi::AVDRMFrameDescriptor,
    fd: OwnedFd,
    _lease: Box<dyn Any + Send + Sync>,
    needs_sync: bool,
}

unsafe extern "C" fn release_input(opaque: *mut libc::c_void, _data: *mut u8) {
    // The reference owns both the descriptor allocation and its FD/lease. No frame property
    // points to this lease, so converted frames cannot keep a compositor slot occupied.
    let input = unsafe { Box::from_raw(opaque.cast::<Input>()) };
    if input.needs_sync {
        // A failed VPP submission can have queued GPU reads without yielding an output surface
        // to synchronize. Wait on the DMA-buf's readers before the swapchain can reuse it.
        // DMA_BUF_IOCTL_SYNC and WRITE/END are the Linux dma-buf.h ioctl and flag values.
        for mut flags in [2u64, 6u64] {
            loop {
                if unsafe { libc::ioctl(input.fd.as_raw_fd(), 0x4008_6200 as libc::c_ulong, &mut flags) } == 0 { break; }
                let error = std::io::Error::last_os_error();
                if error.kind() == std::io::ErrorKind::Interrupted { continue; }
                tracing::warn!("synchronize failed VAAPI input: {error}");
                break;
            }
        }
    }
}

fn import_frame(frame: Frame) -> Result<(Video, *mut Input)> {
    let FrameBuffer::Dmabuf { fd, modifier, stride, offset, lease, .. } = frame.buffer else {
        anyhow::bail!("VAAPI conversion requires a DMA-buf");
    };
    pixel_format(frame.fourcc)?;
    let size = std::fs::File::from(fd.try_clone()?).seek(SeekFrom::End(0)).context("read DMA-buf allocation size")?;
    validate_layout(frame.width, frame.height, stride, offset, size)?;
    let mut input = Box::new(Input { descriptor: unsafe { std::mem::zeroed() }, fd, _lease: lease, needs_sync: false });
    input.descriptor.nb_objects = 1;
    input.descriptor.objects[0] = ffi::AVDRMObjectDescriptor { fd: input.fd.as_raw_fd(), size: size as usize, format_modifier: modifier };
    input.descriptor.nb_layers = 1;
    input.descriptor.layers[0].format = frame.fourcc;
    input.descriptor.layers[0].nb_planes = 1;
    input.descriptor.layers[0].planes[0] = ffi::AVDRMPlaneDescriptor { object_index: 0, offset: offset as isize, pitch: stride as isize };
    let mut drm = video()?;
    let opaque;
    unsafe {
        let data = (&mut input.descriptor as *mut ffi::AVDRMFrameDescriptor).cast();
        opaque = Box::into_raw(input);
        let buffer = ffi::av_buffer_create(data, std::mem::size_of::<ffi::AVDRMFrameDescriptor>(), Some(release_input), opaque.cast(), ffi::AV_BUFFER_FLAG_READONLY);
        if buffer.is_null() {
            drop(Box::from_raw(opaque));
            anyhow::bail!("allocate DMA-buf reference");
        }
        let drm = &mut *drm.as_mut_ptr();
        drm.format = ffi::AVPixelFormat::AV_PIX_FMT_DRM_PRIME as i32;
        drm.width = frame.width as i32;
        drm.height = frame.height as i32;
        drm.data[0] = data;
        drm.buf[0] = buffer;
    }
    Ok((drm, opaque))
}

/// Converts one source layout into the viewer's NV12 hardware surfaces. Use only on its worker.
pub struct Converter {
    _graph: ffmpeg::filter::Graph,
    source: *mut ffi::AVFilterContext,
    sink: *mut ffi::AVFilterContext,
    input_frames: Buffer,
    device: Buffer,
    layout: (u32, u32, u32, u64),
    /// A failed VPP submission may still reference the input. Teardown drops the graph first.
    failed_input: Option<Video>,
}

impl Converter {
    pub fn new(node: &Path, width: u32, height: u32, fourcc: u32, modifier: u64, target: (u32, u32)) -> Result<Self> {
        ensure!(width > 0 && height > 0 && target.0 > 0 && target.1 > 0 && target.0 <= i32::MAX as u32 && target.1 <= i32::MAX as u32, "invalid VAAPI conversion dimensions");
        let device = device(node)?;
        let input_frames = frames(&device, width, height, pixel_format(fourcc)?)?;
        let mut graph = ffmpeg::filter::Graph::new();
        let source;
        unsafe {
            let filter = ffi::avfilter_get_by_name(c"buffer".as_ptr());
            ensure!(!filter.is_null(), "FFmpeg buffer filter is unavailable");
            source = ffi::avfilter_graph_alloc_filter(graph.as_mut_ptr(), filter, c"source".as_ptr());
            ensure!(!source.is_null(), "allocate VAAPI buffer source");
            let params = ffi::av_buffersrc_parameters_alloc();
            ensure!(!params.is_null(), "allocate VAAPI buffer parameters");
            (*params).format = ffi::AVPixelFormat::AV_PIX_FMT_VAAPI as i32;
            (*params).width = width as i32;
            (*params).height = height as i32;
            (*params).time_base = ffi::AVRational { num: 1, den: 1_000_000 };
            (*params).hw_frames_ctx = input_frames.0;
            let result = ffi::av_buffersrc_parameters_set(source, params);
            ffi::av_free(params.cast());
            checked(result, "set VAAPI buffer parameters")?;
            for (name, value) in [(c"colorspace", ffi::AVColorSpace::AVCOL_SPC_RGB as i64), (c"range", ffi::AVColorRange::AVCOL_RANGE_JPEG as i64)] {
                let result = ffi::av_opt_set_int(source.cast(), name.as_ptr(), value, ffi::AV_OPT_SEARCH_CHILDREN);
                // Older buffer filters get these properties from the individual input frames.
                if result < 0 && ffmpeg::Error::from(result) != ffmpeg::Error::OptionNotFound {
                    checked(result, "set VAAPI source color properties")?;
                }
            }
            checked(ffi::avfilter_init_str(source, ptr::null()), "initialize VAAPI buffer source")?;
        }
        let filter = ffmpeg::filter::find("scale_vaapi").context("FFmpeg VAAPI scale filter is unavailable")?;
        let args = format!("w={}:h={}:format=nv12:out_color_matrix=bt709:out_color_primaries=bt709:out_color_transfer=bt709:out_range=limited", target.0, target.1);
        let mut scale = graph.add(&filter, "scale", &args).context("create VAAPI scale filter")?;
        let mut sink = graph.add(&ffmpeg::filter::find("buffersink").context("FFmpeg buffer sink is unavailable")?, "sink", "")?;
        unsafe {
            checked(ffi::avfilter_link(source, 0, scale.as_mut_ptr(), 0), "link VAAPI input")?;
            checked(ffi::avfilter_link(scale.as_mut_ptr(), 0, sink.as_mut_ptr(), 0), "link VAAPI output")?;
        }
        graph.validate().context("configure VAAPI conversion")?;
        let sink = unsafe { sink.as_mut_ptr() };
        Ok(Self { _graph: graph, source, sink, input_frames, device, layout: (width, height, fourcc, modifier), failed_input: None })
    }

    /// Borrowed reference; attach `av_buffer_ref` of it to the encoder's `hw_frames_ctx`.
    pub fn hw_frames_ctx(&self) -> *mut ffi::AVBufferRef {
        unsafe { ffi::av_buffersink_get_hw_frames_ctx(self.sink) }
    }

    pub fn convert(&mut self, frame: Frame) -> Result<Video> {
        ensure!(self.failed_input.is_none(), "VAAPI converter has failed");
        let modifier = match &frame.buffer { FrameBuffer::Dmabuf { modifier, .. } => *modifier, _ => anyhow::bail!("VAAPI conversion requires a DMA-buf") };
        ensure!((frame.width, frame.height, frame.fourcc, modifier) == self.layout, "frame does not match VAAPI source layout");
        let pts = frame.pts.as_micros().try_into().context("capture timestamp exceeds encoder limits")?;
        let (drm, input) = import_frame(frame)?;
        let mut mapped = video()?;
        let mut output = video()?;
        unsafe {
            (*mapped.as_mut_ptr()).format = ffi::AVPixelFormat::AV_PIX_FMT_VAAPI as i32;
            (*mapped.as_mut_ptr()).hw_frames_ctx = ffi::av_buffer_ref(self.input_frames.0);
            ensure!(!(*mapped.as_ptr()).hw_frames_ctx.is_null(), "reference VAAPI input context");
            checked(ffi::av_hwframe_map(mapped.as_mut_ptr(), drm.as_ptr(), ffi::AV_HWFRAME_MAP_READ as i32 | ffi::AV_HWFRAME_MAP_DIRECT as i32), "import compositor DMA-buf")?;
            (*mapped.as_mut_ptr()).pts = pts;
            (*mapped.as_mut_ptr()).color_range = ffi::AVColorRange::AVCOL_RANGE_JPEG;
            (*mapped.as_mut_ptr()).colorspace = ffi::AVColorSpace::AVCOL_SPC_RGB;
            (*mapped.as_mut_ptr()).color_primaries = ffi::AVColorPrimaries::AVCOL_PRI_BT709;
            (*mapped.as_mut_ptr()).color_trc = ffi::AVColorTransferCharacteristic::AVCOL_TRC_IEC61966_2_1;
        }
        drop(drm);
        // KEEP_REF preserves the imported frame while VPP submits asynchronous work.
        self.failed_input = Some(mapped);
        let mapped = self.failed_input.as_mut().unwrap();
        unsafe {
            // The retained mapped frame owns `input` through its DRM source reference.
            (*input).needs_sync = true;
            checked(ffi::av_buffersrc_add_frame_flags(self.source, mapped.as_mut_ptr(), ffi::AV_BUFFERSRC_FLAG_KEEP_REF as i32), "submit VAAPI conversion")?;
            checked(ffi::av_buffersink_get_frame(self.sink, output.as_mut_ptr()), "receive VAAPI conversion")?;
            let display = &*(*(*self.device.0).data.cast::<ffi::AVHWDeviceContext>()).hwctx.cast::<ffi::AVVAAPIDeviceContext>();
            let status = vaSyncSurface(display.display, (*output.as_ptr()).data[3] as usize as ffi::VASurfaceID);
            ensure!(status == 0, "synchronize VAAPI conversion: {status:#x}");
            (*input).needs_sync = false;
        }
        self.failed_input = None;
        Ok(output)
    }
}

/// Exercise the actual renderer allocation with a fresh import/VPP context.
pub fn probe(node: &Path, frame: Frame) -> Result<()> {
    let modifier = match &frame.buffer { FrameBuffer::Dmabuf { modifier, .. } => *modifier, _ => anyhow::bail!("GPU probe requires a DMA-buf") };
    Converter::new(node, frame.width, frame.height, frame.fourcc, modifier, (frame.width, frame.height))?.convert(frame)?;
    Ok(())
}

/// The driver's supported quality levels for the encoder's selected profile and entrypoint.
///
/// # Safety
/// `hw_frames_ctx` must be a live VAAPI `AVHWFramesContext` reference for the duration of the call.
pub unsafe fn quality_range(hw_frames_ctx: *mut ffi::AVBufferRef, codec: Codec, low_power: bool) -> Option<u32> {
    if hw_frames_ctx.is_null() { return None; }
    // Profile, entrypoint and attribute values are the public libva va.h enum values.
    let profile = match codec { Codec::H264 => 6, Codec::Hevc => 17, Codec::Vp9 => 19, Codec::Av1 => 32, Codec::Vp8 => return None };
    unsafe {
        let frames = &*(*hw_frames_ctx).data.cast::<ffi::AVHWFramesContext>();
        let display = &*(*frames.device_ctx).hwctx.cast::<ffi::AVVAAPIDeviceContext>();
        let mut attribute = ConfigAttribute { kind: 21, value: u32::MAX };
        let status = vaGetConfigAttributes(display.display, profile, if low_power { 8 } else { 6 }, &mut attribute, 1);
        (status == 0 && attribute.value > 0 && attribute.value <= i32::MAX as u32).then_some(attribute.value)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{os::fd::{BorrowedFd, FromRawFd}, sync::{Arc, atomic::{AtomicUsize, Ordering}}, time::Duration};

    struct Lease(Arc<AtomicUsize>);
    impl Drop for Lease {
        fn drop(&mut self) { self.0.fetch_add(1, Ordering::Relaxed); }
    }

    fn memory_fd() -> OwnedFd {
        let raw = unsafe { libc::memfd_create(c"frame-test".as_ptr(), libc::MFD_CLOEXEC) };
        assert!(raw >= 0);
        let fd = unsafe { OwnedFd::from_raw_fd(raw) };
        assert_eq!(unsafe { libc::ftruncate(fd.as_raw_fd(), 64 * 32 * 4) }, 0);
        fd
    }

    fn test_frame(fd: OwnedFd, modifier: u64, stride: u32, offset: u32, lease: Box<dyn Any + Send + Sync>) -> Frame {
        Frame { width: 64, height: 32, fourcc: u32::from_le_bytes(*b"AR24"), pts: Duration::from_micros(1_234_567), seq: 1, refine: false,
            buffer: FrameBuffer::Dmabuf { fd, modifier, stride, offset, slot_id: 1, lease } }
    }

    #[test]
    fn validates_allocation_bounds() {
        assert!(validate_layout(64, 32, 256, 0, 8192).is_ok());
        assert!(validate_layout(64, 32, 512, 128, 16384).is_ok());
        assert!(validate_layout(64, 32, 252, 0, 8192).is_err());
        assert!(validate_layout(64, 32, 256, 1, 8192).is_err());
        assert!(validate_layout(u32::MAX, u32::MAX, u32::MAX, u32::MAX, u64::MAX).is_err());
        assert!(validate_layout(0, 1, 0, 0, 0).is_err());
        assert!(validate_layout(1, 0, 4, 0, 0).is_err());
    }

    #[test]
    fn descriptor_references_own_the_lease() {
        let dropped = Arc::new(AtomicUsize::new(0));
        let frame = test_frame(memory_fd(), 0, 256, 0, Box::new(Lease(dropped.clone())));
        let (drm, _) = import_frame(frame).unwrap();
        let mut copy = video().unwrap();
        checked(unsafe { ffi::av_frame_ref(copy.as_mut_ptr(), drm.as_ptr()) }, "reference test frame").unwrap();
        drop(drm);
        assert_eq!(dropped.load(Ordering::Relaxed), 0);
        drop(copy);
        assert_eq!(dropped.load(Ordering::Relaxed), 1);

        let invalid = test_frame(memory_fd(), 0, 252, 0, Box::new(Lease(dropped.clone())));
        assert!(import_frame(invalid).is_err());
        assert_eq!(dropped.load(Ordering::Relaxed), 2);
    }

    #[test]
    #[ignore = "requires a VAAPI render node; run in the GPU Docker rig"]
    fn converts_gpu_frames_and_releases_source_before_encoding() {
        let node = std::env::var_os("ELSEWHERE_TEST_RENDER_NODE").map(std::path::PathBuf::from).unwrap_or_else(|| "/dev/dri/renderD128".into());
        let device = device(&node).unwrap();
        let source_frames = frames(&device, 64, 32, ffi::AVPixelFormat::AV_PIX_FMT_BGRA).unwrap();
        let mut converter = None;
        let dropped = Arc::new(AtomicUsize::new(0));
        for i in 0..8 {
            let mut cpu = video().unwrap();
            cpu.set_format(ffmpeg::format::Pixel::BGRA);
            cpu.set_width(64);
            cpu.set_height(32);
            checked(unsafe { ffi::av_frame_get_buffer(cpu.as_mut_ptr(), 32) }, "allocate test pixels").unwrap();
            let stride = cpu.stride(0);
            for row in cpu.data_mut(0).chunks_mut(stride).take(32) {
                for pixel in row[..64 * 4].chunks_mut(4) { pixel.copy_from_slice(if i % 2 == 0 { &[0, 0, 255, 255] } else { &[0, 255, 0, 255] }); }
            }
            let mut gpu = video().unwrap();
            checked(unsafe { ffi::av_hwframe_get_buffer(source_frames.0, gpu.as_mut_ptr(), 0) }, "allocate GPU test frame").unwrap();
            checked(unsafe { ffi::av_hwframe_transfer_data(gpu.as_mut_ptr(), cpu.as_ptr(), 0) }, "upload GPU test pixels").unwrap();
            let mut drm = video().unwrap();
            drm.set_format(ffmpeg::format::Pixel::DRM_PRIME);
            checked(unsafe { ffi::av_hwframe_map(drm.as_mut_ptr(), gpu.as_ptr(), ffi::AV_HWFRAME_MAP_READ as i32) }, "export GPU test frame").unwrap();
            let descriptor = unsafe { &*(*drm.as_ptr()).data[0].cast::<ffi::AVDRMFrameDescriptor>() };
            assert_eq!((descriptor.nb_objects, descriptor.nb_layers, descriptor.layers[0].nb_planes), (1, 1, 1));
            let object = descriptor.objects[0];
            let plane = descriptor.layers[0].planes[0];
            let fd = unsafe { BorrowedFd::borrow_raw(object.fd) }.try_clone_to_owned().unwrap();
            let frame = test_frame(fd, object.format_modifier, plane.pitch as u32, plane.offset as u32, Box::new((drm, Lease(dropped.clone()))));
            let converter = converter.get_or_insert_with(|| Converter::new(&node, 64, 32, frame.fourcc, object.format_modifier, (32, 16)).unwrap());
            if i == 0 { eprintln!("H.264 quality levels: {:?}", unsafe { quality_range(converter.hw_frames_ctx(), Codec::H264, false) }); }
            if i == 7 {
                checked(unsafe { ffi::av_buffersrc_close(converter.source, 1_234_567, 0) }, "close test source").unwrap();
                assert!(converter.convert(frame).is_err());
                assert_eq!(dropped.load(Ordering::Relaxed), i);
                break;
            }
            let output = converter.convert(frame).unwrap();
            assert_eq!(dropped.load(Ordering::Relaxed), i + 1);
            assert_eq!(output.pts(), Some(1_234_567));
            assert_eq!((output.width(), output.height()), (32, 16));
            assert!(unsafe { (*output.as_ptr()).opaque_ref }.is_null());
            let mut pixels = video().unwrap();
            checked(unsafe { ffi::av_hwframe_transfer_data(pixels.as_mut_ptr(), output.as_ptr(), 0) }, "read converted test pixels").unwrap();
            assert_eq!(pixels.format(), ffmpeg::format::Pixel::NV12);
            let (y, u, v) = if i % 2 == 0 { (63i16, 102i16, 240i16) } else { (173, 42, 26) };
            for row in pixels.data(0).chunks(pixels.stride(0)).take(16) {
                assert!(row[..32].iter().all(|&value| (i16::from(value) - y).abs() <= 2));
            }
            for row in pixels.data(1).chunks(pixels.stride(1)).take(8) {
                assert!(row[..32].chunks(2).all(|pair| (i16::from(pair[0]) - u).abs() <= 2 && (i16::from(pair[1]) - v).abs() <= 2));
            }
        }
        drop(converter);
        assert_eq!(dropped.load(Ordering::Relaxed), 8);
    }
}
