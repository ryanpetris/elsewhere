//! The renderer and what it renders into: a render node's GBM device with dmabuf swapchains the encoders
//! import, or textures read back into memory for NVENC and CPU encoders. Without a render node the
//! context uses surfaceless EGL.

use std::{fs::OpenOptions, os::fd::{AsFd, OwnedFd}, path::Path, time::Duration};

use anyhow::{Context, Result};
use elsewhere_core::{Frame, FrameBuffer, FrameTransport, OutputGeometry};
use smithay::{
    backend::{
        allocator::{
            Buffer as _, Fourcc, Modifier, Slot, Swapchain,
            dmabuf::{Dmabuf, DmabufAllocator},
            gbm::{GbmAllocator, GbmBufferFlags, GbmDevice},
        },
        drm::{DrmDeviceFd, DrmNode},
        egl::{EGLContext, EGLDisplay, native::EGLSurfacelessDisplay},
        renderer::{Bind, ExportMem, Frame as _, Offscreen, Renderer, TextureMapping, gles::{GlesRenderer, GlesTarget, GlesTexture}},
    },
    utils::{Buffer, Rectangle, Size, Transform},
};

pub type DmabufSwapchain = Swapchain<DmabufAllocator<GbmAllocator<DrmDeviceFd>>>;

/// The GPU's device, when there is one.
pub struct Device {
    pub node: DrmNode,
    pub drm: DrmDeviceFd,
    gbm: GbmDevice<DrmDeviceFd>,
}

pub struct Gpu {
    pub device: Option<Device>,
    pub renderer: GlesRenderer,
    /// The output's; window streams have their own (`targets()`).
    pub targets: Targets,
    pub fourcc: Fourcc,
    pub modifier: Modifier,
    /// GBM can export Invalid for an allocation requested with the LINEAR flag.
    allocation_modifier: Modifier,
    /// The first buffer of each swapchain is checked against `modifier` (see `render_frame`).
    pub modifier_verified: bool,
}

/// What frames are rendered into.
pub enum Targets {
    /// Dmabufs the encoders import zero-copy, in the negotiated format.
    Dmabuf(DmabufSwapchain),
    /// One texture, read back into memory after each frame (made on first use, again after a resize).
    Texture { texture: Option<GlesTexture>, size: Size<i32, Buffer> },
}

/// One of the targets, acquired for a frame.
pub enum Target {
    Slot { slot: Slot<Dmabuf>, dmabuf: Dmabuf },
    Texture,
}

impl Gpu {
    /// Trial renderer allocations through the encoder. Without a render node, software encoders
    /// take the pixels as read back (BGRx).
    pub fn new(render_node: Option<&Path>, geo: &OutputGeometry, transport: FrameTransport, validate: &dyn Fn(Frame) -> Result<()>) -> Result<Gpu> {
        let Some(render_node) = render_node else {
            // Safety: the display is only used from this thread and outlives the renderer through the context.
            let renderer = unsafe { EGLDisplay::new(EGLSurfacelessDisplay).and_then(|egl| EGLContext::new(&egl)).map_err(anyhow::Error::from).and_then(|ctx| Ok(GlesRenderer::new(ctx)?)) }
                .context("surfaceless EGL platform (no render node)")?;
            tracing::info!("rendering with surfaceless EGL, frames read back into memory");
            return Self::memory(None, renderer, geo, validate);
        };
        let node = DrmNode::from_path(render_node)?;
        let file = OpenOptions::new().read(true).write(true).open(render_node)?;
        let fd = DrmDeviceFd::new(OwnedFd::from(file).into());
        let gbm = GbmDevice::new(fd.clone())?;
        // Safety: the display is only used from this thread and outlives the renderer through the context.
        let egl = unsafe { EGLDisplay::new(gbm.clone())? };
        let mut renderer = unsafe { GlesRenderer::new(EGLContext::new(&egl)?)? };

        if transport == FrameTransport::Memory {
            return Self::memory(Some(Device { node, drm: fd, gbm }), renderer, geo, validate);
        }
        let renderable = Bind::<Dmabuf>::supported_formats(&renderer).unwrap_or_default();
        let mut candidates: Vec<_> = renderable
            .iter()
            .filter(|format| matches!(format.code, Fourcc::Argb8888 | Fourcc::Xrgb8888) && (transport != FrameTransport::LinearDmabuf || format.modifier == Modifier::Linear))
            .map(|format| (format.code, format.modifier))
            .collect();
        candidates.sort_by_key(|&(fourcc, modifier)| {
            (modifier != Modifier::Linear && modifier != Modifier::Invalid, fourcc == Fourcc::Argb8888, u64::from(modifier))
        });
        let mut selected = None;
        for (fourcc, modifier) in candidates.into_iter().rev() {
            let attempt = (|| -> Result<_> {
                let mut targets = swapchain(&gbm, fourcc, modifier, geo.width_px, geo.height_px);
                let slot = targets.acquire()?.context("no initial render target")?;
                let mut dmabuf = (*slot).clone();
                ensure_single_plane(&dmabuf)?;
                let actual = dmabuf.format().modifier;
                let sync = {
                    let mut target = renderer.bind(&mut dmabuf)?;
                    let size = (geo.width_px as i32, geo.height_px as i32).into();
                    let mut frame = renderer.render(&mut target, size, Transform::Normal)?;
                    frame.clear([0.12, 0.12, 0.14, 1.0].into(), &[Rectangle::from_size(size)])?;
                    frame.finish()?
                };
                while sync.wait().is_err() {}
                let fd = dmabuf.handles().next().context("DMA-buf has no plane")?.as_fd().try_clone_to_owned()?;
                validate(Frame {
                    width: geo.width_px, height: geo.height_px, fourcc: fourcc as u32,
                    pts: Duration::ZERO, seq: 0, refine: false,
                    buffer: FrameBuffer::Dmabuf {
                        fd, modifier: u64::from(actual), stride: dmabuf.strides().next().unwrap(), offset: dmabuf.offsets().next().unwrap(),
                        slot_id: 0, lease: Box::new(slot),
                    },
                })?;
                Ok((Targets::Dmabuf(targets), fourcc, actual, modifier))
            })();
            match attempt {
                Ok(candidate) => { selected = Some(candidate); break; }
                Err(error) => tracing::debug!(?fourcc, ?modifier, "render target trial: {error:#}"),
            }
        }
        let (targets, fourcc, modifier, allocation_modifier) = selected
            .context("no packed RGB DMA-buf layout shared by the renderer and encoder")?;
        tracing::info!(?fourcc, ?modifier, "verified render target format");
        Ok(Gpu { device: Some(Device { node, drm: fd, gbm }), renderer, targets, fourcc, modifier, allocation_modifier, modifier_verified: false })
    }

    fn memory(device: Option<Device>, mut renderer: GlesRenderer, geo: &OutputGeometry, validate: &dyn Fn(Frame) -> Result<()>) -> Result<Gpu> {
        let size = (geo.width_px as i32, geo.height_px as i32).into();
        let fourcc = Fourcc::Xrgb8888;
        let mut targets = Targets::Texture { texture: None, size };
        let (mut target, _) = targets.acquire(&mut renderer, fourcc)?.context("allocate texture probe")?;
        let pixels = {
            let mut fb = targets.bind(&mut renderer, &mut target)?;
            let physical = (geo.width_px as i32, geo.height_px as i32).into();
            let mut frame = renderer.render(&mut fb, physical, Transform::Normal)?;
            frame.clear([0.12, 0.12, 0.14, 1.0].into(), &[Rectangle::from_size(physical)])?;
            let sync = frame.finish()?;
            while sync.wait().is_err() {}
            read_pixels(&mut renderer, &fb, size, fourcc)?
        };
        validate(Frame { width: geo.width_px, height: geo.height_px, fourcc: fourcc as u32,
            pts: Duration::ZERO, seq: 0, refine: false,
            buffer: FrameBuffer::Memory { data: pixels.into(), stride: geo.width_px * 4 } })?;
        tracing::info!(?fourcc, "verified texture render target and framebuffer readback");
        Ok(Gpu { device, renderer, targets, fourcc, modifier: Modifier::Linear, allocation_modifier: Modifier::Linear, modifier_verified: false })
    }

    /// Targets for a window stream of `width`×`height`.
    pub fn targets(&self, width: u32, height: u32) -> Targets {
        match (&self.targets, &self.device) {
            (Targets::Dmabuf(_), Some(d)) => Targets::Dmabuf(swapchain(&d.gbm, self.fourcc, self.allocation_modifier, width, height)),
            _ => Targets::Texture { texture: None, size: (width as i32, height as i32).into() },
        }
    }
}

impl Targets {
    pub fn resize(&mut self, width: u32, height: u32) {
        match self {
            Targets::Dmabuf(s) => s.resize(width, height),
            Targets::Texture { texture, size } => {
                *texture = None;
                *size = (width as i32, height as i32).into();
            }
        }
    }

    /// A target to render into and its buffer age, or `None` while the encoders hold every dmabuf.
    pub fn acquire(&mut self, renderer: &mut GlesRenderer, fourcc: Fourcc) -> Result<Option<(Target, usize)>> {
        Ok(match self {
            Targets::Dmabuf(s) => s.acquire()?.map(|slot| {
                let (age, dmabuf) = (slot.age() as usize, (*slot).clone());
                (Target::Slot { slot, dmabuf }, age)
            }),
            Targets::Texture { texture, size } => {
                let age = if texture.is_some() { 1 } else { 0 };
                if texture.is_none() {
                    *texture = Some(renderer.create_buffer(fourcc, *size).context("create texture")?);
                }
                Some((Target::Texture, age))
            }
        })
    }

    /// The framebuffer of an acquired target (it borrows the target, not the renderer).
    pub fn bind<'a>(&'a mut self, renderer: &mut GlesRenderer, target: &'a mut Target) -> Result<GlesTarget<'a>> {
        Ok(match (self, target) {
            (_, Target::Slot { dmabuf, .. }) => renderer.bind(dmabuf)?,
            (Targets::Texture { texture: Some(t), .. }, Target::Texture) => renderer.bind(t)?,
            _ => unreachable!("a texture target comes from texture targets"),
        })
    }
}

/// The framebuffer's pixels, 4 bytes each in `fourcc`'s order, rows top first (GL may give them bottom first).
pub fn read_pixels(renderer: &mut GlesRenderer, fb: &GlesTarget<'_>, size: Size<i32, Buffer>, fourcc: Fourcc) -> Result<Vec<u8>> {
    let started = std::time::Instant::now();
    let mapping = renderer.copy_framebuffer(fb, Rectangle::from_size(size), fourcc).context("copy framebuffer")?;
    let data = renderer.map_texture(&mapping).context("map texture")?;
    let (w, h) = (size.w as usize, size.h as usize);
    let stride = w * 4;
    let mut out = vec![0u8; stride * h];
    for y in 0..h {
        let src = if mapping.flipped() { y } else { h - 1 - y };
        out[y * stride..(y + 1) * stride].copy_from_slice(&data[src * stride..(src + 1) * stride]);
    }
    tracing::debug!(width = size.w, height = size.h, bytes = out.len(), readback_us = started.elapsed().as_micros() as u64, "framebuffer readback");
    Ok(out)
}

/// The core frame handoff describes exactly one packed RGB plane.
pub(crate) fn ensure_single_plane(dmabuf: &Dmabuf) -> Result<()> {
    anyhow::ensure!(dmabuf.handles().count() == 1 && dmabuf.strides().count() == 1 && dmabuf.offsets().count() == 1, "encoder requires a single-plane DMA-buf");
    Ok(())
}

fn swapchain(gbm: &GbmDevice<DrmDeviceFd>, fourcc: Fourcc, modifier: Modifier, width: u32, height: u32) -> DmabufSwapchain {
    // asked for as linear too, so GBM can't fall back to a tiled layout the CPU would misread
    let flags = if modifier == Modifier::Linear { GbmBufferFlags::RENDERING | GbmBufferFlags::LINEAR } else { GbmBufferFlags::RENDERING };
    let allocator = DmabufAllocator(GbmAllocator::new(gbm.clone(), flags));
    Swapchain::new(allocator, width, height, fourcc, vec![modifier])
}
