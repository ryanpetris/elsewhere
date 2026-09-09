//! Pointer images are not composited; they are exported to the browser, which draws its own cursor.

use std::collections::HashMap;

use elsewhere_core::{CursorImage, Event};
use smithay::{
    wayland::{compositor::SurfaceAttributes, viewporter::ViewportCachedState},
    backend::renderer::utils::with_renderer_surface_state,
    input::pointer::{CursorIcon, CursorImageStatus, CursorImageSurfaceData},
    reexports::wayland_server::protocol::{wl_buffer::WlBuffer, wl_shm, wl_surface::WlSurface},
    wayland::{compositor::with_states, shm::with_buffer_contents},
};

use crate::State;

/// Named cursors from the user's Xcursor theme, cached per icon.
pub struct CursorTheme {
    theme: xcursor::CursorTheme,
    size: u32,
    cache: HashMap<CursorIcon, Option<xcursor::parser::Image>>,
}

impl CursorTheme {
    pub fn load() -> Self {
        let name = std::env::var("XCURSOR_THEME").unwrap_or_else(|_| "default".into());
        let size = std::env::var("XCURSOR_SIZE").ok().and_then(|s| s.parse().ok()).unwrap_or(24);
        Self { theme: xcursor::CursorTheme::load(&name), size, cache: HashMap::new() }
    }

    fn image(&mut self, icon: CursorIcon) -> CursorImage {
        self.themed_image(icon).or_else(|| self.themed_image(CursorIcon::Default)).unwrap_or_else(fallback_arrow)
    }

    // ponytail: always the 1x image; a HiDPI browser gets a slightly soft cursor. Send per-dpr sizes if it bothers anyone.
    fn themed_image(&mut self, icon: CursorIcon) -> Option<CursorImage> {
        let (theme, size) = (&self.theme, self.size);
        self.cache
            .entry(icon)
            .or_insert_with(|| {
                let names = std::iter::once(icon.name()).chain(icon.alt_names().iter().copied());
                let path = names.filter_map(|n| theme.load_icon(n)).next()?;
                let images = xcursor::parser::parse_xcursor(&std::fs::read(path).ok()?)?;
                images.into_iter().min_by_key(|i| (i.size as i32 - size as i32).abs())
            })
            .as_ref()
            .map(|img| CursorImage {
                width: img.width,
                height: img.height,
                hot_x: img.xhot as i32,
                hot_y: img.yhot as i32,
                logical_w: img.width,
                logical_h: img.height,
                rgba: unpremultiply(img.pixels_rgba.chunks_exact(4).map(|p| (p[0], p[1], p[2], p[3]))),
            })
    }
}

/// A black arrow with a white outline, available even without an installed cursor theme.
fn fallback_arrow() -> CursorImage {
    let rows = [
        "W...........", "WW..........", "WBW.........", "WBBW........",
        "WBBBW.......", "WBBBBW......", "WBBBBBW.....", "WBBBBBBW....",
        "WBBBBBBBW...", "WBBBBBBBBW..", "WBBBBBBBBBW.", "WBBBBWWWWWW.",
        "WBBWBW......", "WBW.WBW.....", "WW..WBW.....", ".....WBW....",
        ".....WBW....", "......W.....",
    ];
    CursorImage {
        width: 12, height: 18, hot_x: 0, hot_y: 0, logical_w: 12, logical_h: 18,
        rgba: rows.iter().flat_map(|row| row.bytes()).flat_map(|pixel| match pixel {
            b'W' => [255, 255, 255, 255],
            b'B' => [0, 0, 0, 255],
            _ => [0, 0, 0, 0],
        }).collect(),
    }
}

/// Straight-alpha RGBA from premultiplied (r, g, b, a) pixels.
fn unpremultiply(pixels: impl Iterator<Item = (u8, u8, u8, u8)>) -> Vec<u8> {
    let mut out = Vec::new();
    for (r, g, b, a) in pixels {
        let un = |c: u8| if a == 0 { 0 } else { (c as u32 * 255 / a as u32).min(255) as u8 };
        out.extend([un(r), un(g), un(b), a]);
    }
    out
}

/// The client's cursor surface (a wl_shm buffer) as straight RGBA.
fn surface_cursor(surface: &WlSurface) -> Option<CursorImage> {
    // GTK 3 scales a HiDPI cursor with wl_surface.set_buffer_scale, GTK 4 with a viewport destination
    let (hotspot, scale, viewport) = with_states(surface, |s| {
        let hotspot = s.data_map.get::<CursorImageSurfaceData>().map(|d| d.lock().unwrap().hotspot)?;
        let scale = s.cached_state.get::<SurfaceAttributes>().current().buffer_scale.max(1) as u32;
        Some((hotspot, scale, s.cached_state.get::<ViewportCachedState>().current().size()))
    })?;
    let buffer = with_renderer_surface_state(surface, |s| s.buffer().cloned())??;
    let (w, h, rgba) = shm_rgba(&buffer)?;
    let (logical_w, logical_h) = viewport.map_or((w / scale, h / scale), |v| (v.w.max(1) as u32, v.h.max(1) as u32));
    tracing::debug!(w, h, logical_w, logical_h, ?hotspot, "client cursor");
    Some(CursorImage { width: w, height: h, hot_x: hotspot.x, hot_y: hotspot.y, logical_w, logical_h, rgba })
}

/// A wl_shm [AX]RGB8888 buffer as straight RGBA, top row first: `(width, height, pixels)`.
pub fn shm_rgba(buffer: &WlBuffer) -> Option<(u32, u32, Vec<u8>)> {
    with_buffer_contents(buffer, |ptr, len, data| {
        let opaque = match data.format {
            wl_shm::Format::Argb8888 => false,
            wl_shm::Format::Xrgb8888 => true,
            _ => return None,
        };
        let (w, h, stride, off) = (data.width as usize, data.height as usize, data.stride as usize, data.offset as usize);
        if w == 0 || h == 0 || off + (h - 1) * stride + w * 4 > len {
            return None;
        }
        // The client may write this memory at any time, so read through the raw pointer, never a slice.
        // wl_shm [AX]RGB8888 is little-endian: bytes are B, G, R, A.
        let pixels = (0..h).flat_map(|y| (0..w).map(move |x| off + y * stride + x * 4)).map(|i| unsafe {
            let p = ptr.add(i);
            (p.add(2).read_volatile(), p.add(1).read_volatile(), p.read_volatile(), if opaque { 255 } else { p.add(3).read_volatile() })
        });
        Some((w as u32, h as u32, unpremultiply(pixels)))
    })
    .ok()
    .flatten()
}

impl State {
    /// Send the current pointer image to the viewer.
    pub fn export_cursor(&mut self) {
        let image = self.cursor_image();
        let _ = self.events.send(Event::Cursor(image));
    }

    pub fn cursor_image(&mut self) -> Option<CursorImage> {
        match &self.cursor_status {
            CursorImageStatus::Hidden => None,
            CursorImageStatus::Named(icon) => Some(self.cursor.image(*icon)),
            CursorImageStatus::Surface(surface) => surface_cursor(surface),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn missing_theme_images_use_visible_arrow() {
        let mut theme = CursorTheme::load();
        // Cached misses exercise the same path regardless of the machine's installed themes.
        theme.cache.insert(CursorIcon::Default, None);
        theme.cache.insert(CursorIcon::Text, None);
        for icon in [CursorIcon::Default, CursorIcon::Text] {
            let image = theme.image(icon);
            assert_eq!(image.rgba.len(), (image.width * image.height * 4) as usize);
            assert!(image.rgba.chunks_exact(4).any(|p| p == [0, 0, 0, 255]));
            assert!(image.rgba.chunks_exact(4).any(|p| p == [255, 255, 255, 255]));
            assert!(image.rgba.chunks_exact(4).any(|p| p[3] == 0));
            assert!(image.hot_x >= 0 && image.hot_x < image.width as i32);
            assert!(image.hot_y >= 0 && image.hot_y < image.height as i32);
        }
    }
}
