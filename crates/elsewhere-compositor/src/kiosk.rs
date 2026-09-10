//! Fullscreen windows while retaining their layout for the return to desktop mode.
use std::cell::RefCell;

use smithay::{
    desktop::WindowSurface,
    reexports::wayland_protocols::xdg::shell::server::xdg_toplevel::{State as XdgState, WmCapabilities},
    utils::{Logical, Rectangle, SERIAL_COUNTER},
};

use crate::{State, handlers::RestoreLocation};

struct Layout {
    fullscreen: bool,
    maximized: bool,
    geometry: Rectangle<i32, Logical>,
}
type BeforeKiosk = RefCell<Option<Layout>>;

impl State {
    pub(crate) fn set_kiosk(&mut self, kiosk: bool) {
        if self.kiosk == kiosk { return; }
        let windows = self.full_stack();
        let minimized: Vec<_> = self.minimized.iter().map(|(window, ..)| window.clone()).collect();
        let active = self.active.clone();
        self.kiosk = kiosk;
        for window in &windows {
            if window.x11_surface().is_some_and(|x| x.is_override_redirect()) { continue; }
            self.unminimize(window);
            let committed_size = window.geometry().size;
            let (fullscreen, maximized, size) = match window.underlying_surface() {
                WindowSurface::Wayland(t) => t.with_pending_state(|s| {
                    if kiosk { s.capabilities.unset(WmCapabilities::Minimize); }
                    else { s.capabilities.set(WmCapabilities::Minimize); }
                    (s.states.contains(XdgState::Fullscreen), s.states.contains(XdgState::Maximized), s.size.unwrap_or(committed_size))
                }),
                WindowSurface::X11(x) => (x.is_fullscreen(), x.is_maximized(), x.geometry().size),
            };
            window.user_data().insert_if_missing(BeforeKiosk::default);
            let before = window.user_data().get::<BeforeKiosk>().unwrap();
            if kiosk {
                *before.borrow_mut() = Some(Layout {
                    fullscreen, maximized,
                    geometry: Rectangle::new(self.space.element_location(window).unwrap_or_default(), size),
                });
                self.fill(window, XdgState::Fullscreen, true);
            } else {
                let layout = before.borrow_mut().take();
                // A window opened in kiosk has no desktop layout; maximize it in the work area.
                let maximized = layout.as_ref().is_none_or(|s| s.maximized);
                let fullscreen = layout.as_ref().is_some_and(|s| s.fullscreen);
                self.fill(window, XdgState::Maximized, maximized);
                self.fill(window, XdgState::Fullscreen, fullscreen);
                if layout.is_none() {
                    // Without a floating layout, unmaximize also uses the decorated work area.
                    *window.user_data().get::<RestoreLocation>().unwrap().borrow_mut() = Some(self.fill_rect(window, false));
                }
                if let Some(layout) = layout.filter(|s| !s.fullscreen && !s.maximized) {
                    let location = self.clamp_to_output(window, layout.geometry.loc);
                    self.space.map_element(window.clone(), location, false);
                    match window.underlying_surface() {
                        WindowSurface::Wayland(t) => {
                            t.with_pending_state(|s| s.size = Some(layout.geometry.size));
                            t.send_pending_configure();
                        }
                        WindowSurface::X11(x) => { let _ = x.configure(Rectangle::new(location, layout.geometry.size)); }
                    }
                }
            }
        }
        // Reapply stacking and hidden state after the shared fill paths have mapped the windows.
        for window in windows {
            if let Some(location) = self.space.element_location(&window) {
                self.space.map_element(window, location, false);
            }
        }
        for window in minimized { self.minimize(&window); }
        self.focus_window(active.as_ref(), SERIAL_COUNTER.next_serial());
        self.dirty = true;
    }
}
