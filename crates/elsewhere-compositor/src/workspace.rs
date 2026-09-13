//! Four numbered desktops, shared by viewers and ext-workspace panel clients.

use smithay::reexports::{
    wayland_protocols::ext::workspace::v1::server::{
        ext_workspace_group_handle_v1::{self as group, ExtWorkspaceGroupHandleV1},
        ext_workspace_handle_v1::{self as handle, ExtWorkspaceHandleV1},
        ext_workspace_manager_v1::{self as manager, ExtWorkspaceManagerV1},
    },
    wayland_server::{Client, DataInit, Dispatch, DisplayHandle, GlobalDispatch, New, Resource, backend::ClientId, protocol::wl_output::WlOutput},
};
use std::cell::Cell;
use smithay::{desktop::{Window, PopupManager, layer_map_for_output, space::SpaceElement}, utils::{SERIAL_COUNTER, Point, Logical}, wayland::seat::WaylandFocus};
use crate::State;
pub const VERSION: u32 = 1;

struct Binding {
    manager: ExtWorkspaceManagerV1,
    group: ExtWorkspaceGroupHandleV1,
    handles: Vec<(u32, ExtWorkspaceHandleV1)>,
    pending: Option<u32>,
}

pub struct Workspaces {
    pub active: u32,
    focus: [Option<Window>; COUNT as usize],
    bindings: Vec<Binding>,
}

impl Default for Workspaces {
    fn default() -> Self { Self { active: 1, focus: Default::default(), bindings: Vec::new() } }
}

impl Workspaces {
    pub fn output_bound(&mut self, output: &WlOutput) {
        for b in &self.bindings {
            if b.group.is_alive() && b.manager.client().is_some_and(|c| Some(c) == output.client()) {
                b.group.output_enter(output);
                b.manager.done();
            }
        }
    }

    fn publish(&self) {
        for b in &self.bindings {
            for (number, ws) in &b.handles {
                if ws.is_alive() { ws.state(if *number == self.active { handle::State::Active } else { handle::State::empty() }); }
            }
            b.manager.done();
        }
    }

    pub fn forget(&mut self, window: &Window) {
        for focus in &mut self.focus { if focus.as_ref() == Some(window) { *focus = None; } }
    }
}

impl GlobalDispatch<ExtWorkspaceManagerV1, ()> for State {
    fn bind(state: &mut Self, dh: &DisplayHandle, client: &Client, resource: New<ExtWorkspaceManagerV1>, _: &(), data_init: &mut DataInit<'_, Self>) {
        let manager = data_init.init(resource, ());
        let Ok(group) = client.create_resource::<ExtWorkspaceGroupHandleV1, (), State>(dh, manager.version(), ()) else { return; };
        manager.workspace_group(&group);
        group.capabilities(group::GroupCapabilities::empty());
        for output in state.output.client_outputs(client) { group.output_enter(&output); }
        let mut handles = Vec::new();
        for number in 1..=COUNT {
            let Ok(ws) = client.create_resource::<ExtWorkspaceHandleV1, (ExtWorkspaceManagerV1, u32), State>(dh, manager.version(), (manager.clone(), number)) else { return; };
            manager.workspace(&ws);
            ws.id(number.to_string());
            ws.name(number.to_string());
            ws.coordinates((number - 1).to_ne_bytes().to_vec());
            ws.state(if number == state.workspaces.active { handle::State::Active } else { handle::State::empty() });
            ws.capabilities(handle::WorkspaceCapabilities::Activate);
            group.workspace_enter(&ws);
            handles.push((number, ws));
        }
        manager.done();
        state.workspaces.bindings.push(Binding { manager, group, handles, pending: None });
    }
}

impl Dispatch<ExtWorkspaceManagerV1, ()> for State {
    fn request(state: &mut Self, _: &Client, manager: &ExtWorkspaceManagerV1, request: manager::Request, _: &(), _: &DisplayHandle, _: &mut DataInit<'_, Self>) {
        match request {
            manager::Request::Commit => {
                let pending = state.workspaces.bindings.iter_mut().find(|b| b.manager == *manager).and_then(|b| b.pending.take());
                if let Some(number) = pending { state.switch_workspace(number); }
            }
            manager::Request::Stop => {
                state.workspaces.bindings.retain(|b| b.manager != *manager);
                manager.finished();
            }
            _ => {}
        }
    }
    fn destroyed(state: &mut Self, _: ClientId, manager: &ExtWorkspaceManagerV1, _: &()) {
        state.workspaces.bindings.retain(|b| b.manager != *manager);
    }
}

impl Dispatch<ExtWorkspaceGroupHandleV1, ()> for State {
    fn request(_: &mut Self, _: &Client, _: &ExtWorkspaceGroupHandleV1, _: group::Request, _: &(), _: &DisplayHandle, _: &mut DataInit<'_, Self>) {}
}

impl Dispatch<ExtWorkspaceHandleV1, (ExtWorkspaceManagerV1, u32)> for State {
    fn request(state: &mut Self, _: &Client, _: &ExtWorkspaceHandleV1, request: handle::Request, data: &(ExtWorkspaceManagerV1, u32), _: &DisplayHandle, _: &mut DataInit<'_, Self>) {
        if matches!(request, handle::Request::Activate) {
            if let Some(b) = state.workspaces.bindings.iter_mut().find(|b| b.manager == data.0) { b.pending = Some(data.1); }
        }
    }
}


pub const COUNT: u32 = elsewhere_core::WORKSPACE_COUNT;
struct Membership(Cell<u32>);

impl State {
    pub fn active_element_under(&self, point: Point<f64, Logical>) -> Option<(&Window, Point<i32, Logical>)> {
        self.space.elements().rev().filter(|w| self.on_active_workspace(w)).find_map(|w| {
            let origin = self.space.element_location(w)? - w.geometry().loc;
            w.is_in_input_region(&(point - origin.to_f64())).then_some((w, origin))
        })
    }

    pub fn assign_workspace(&self, window: &Window, workspace: u32) {
        window.user_data().insert_if_missing(|| Membership(Cell::new(workspace)));
        window.user_data().get::<Membership>().unwrap().0.set(workspace);
    }

    pub fn window_workspace(&self, window: &Window) -> u32 {
        window.user_data().get::<Membership>().map_or(self.workspaces.active, |w| w.0.get())
    }

    pub fn on_active_workspace(&self, window: &Window) -> bool {
        self.window_workspace(window) == self.workspaces.active
    }

    pub fn parent_window(&self, window: &Window) -> Option<Window> {
        let windows = self.full_stack();
        if let Some(parent) = window.toplevel().and_then(|t| t.parent()) {
            return windows.into_iter().find(|w| w.wl_surface().is_some_and(|s| *s == parent));
        }
        let parent = window.x11_surface()?.is_transient_for()?;
        windows.into_iter().find(|w| w.x11_surface().is_some_and(|x| x.window_id() == parent))
    }

    /// Transient membership follows the current parent, including parents assigned after creation.
    pub fn sync_workspace_parents(&mut self, mut membership_changed: bool) {
        let windows = self.full_stack();
        for _ in 0..windows.len() {
            let mut changed = false;
            for window in &windows {
                if let Some(parent) = self.parent_window(window) {
                    let workspace = self.window_workspace(&parent);
                    if self.window_workspace(window) != workspace {
                        self.assign_workspace(window, workspace);
                        changed = true;
                        membership_changed = true;
                    }
                }
            }
            if !changed { break; }
        }
        let hidden_focus = self.active.as_ref().is_some_and(|w| !self.on_active_workspace(w));
        let mut hidden_surfaces = std::collections::HashSet::new();
        if membership_changed {
            for window in windows.iter().filter(|w| !self.on_active_workspace(w)) {
                window.with_surfaces(|surface, _| { hidden_surfaces.insert(surface.id()); });
            }
        }
        let pointer = self.seat.get_pointer().unwrap();
        let keyboard = self.seat.get_keyboard().unwrap();
        let touch = self.seat.get_touch().unwrap();
        let hidden_owner = focus_is_hidden(keyboard.current_focus(), &hidden_surfaces)
            || focus_is_hidden(keyboard.grab_start_data().and_then(|g| g.focus), &hidden_surfaces)
            || (self.pointer_locked && focus_is_hidden(pointer.current_focus(), &hidden_surfaces))
            || focus_is_hidden(pointer.grab_start_data().and_then(|g| g.focus.map(|(f, _)| f)), &hidden_surfaces)
            || focus_is_hidden(touch.grab_start_data().and_then(|g| g.focus.map(|(f, _)| f)), &hidden_surfaces)
            || self.touch_down.values().any(|focus| focus_is_hidden(focus.clone(), &hidden_surfaces))
            || self.pointer_grab_window.as_ref().is_some_and(|w| !self.on_active_workspace(w))
            || self.touch_grab_window.as_ref().is_some_and(|w| !self.on_active_workspace(w));
        if hidden_focus || hidden_owner {
            if hidden_owner || !self.exclusive_layer_focused() { self.end_workspace_input(); }
            let next = self.active.clone().filter(|w| self.on_active_workspace(w)).or_else(|| self.top_window());
            if self.exclusive_layer_focused() { self.active = next; }
            else { self.focus_window(next.as_ref(), SERIAL_COUNTER.next_serial()); }
        }
        if membership_changed {
            self.pointer_motion(self.pointer_location);
            self.force_full_frame = true;
            self.dirty = true;
        }
    }

    fn end_workspace_input(&mut self) {
        self.pending_initial_focus = None;
        self.release_pointer_lock();
        let serial = SERIAL_COUNTER.next_serial();
        // Cancel native drag-and-drop before button releases could commit a drop.
        self.seat.get_pointer().unwrap().unset_grab(self, serial, self.now());
        if let Some(touch) = self.seat.get_touch() { touch.unset_grab(self); }
        self.release_all();
        self.seat.get_keyboard().unwrap().unset_grab(self);
        let surfaces: Vec<_> = self.full_stack().iter().filter_map(|w| w.wl_surface().map(|s| s.into_owned()))
            .chain(layer_map_for_output(&self.output).layers().map(|l| l.wl_surface().clone())).collect();
        for surface in surfaces {
            for (popup, _) in PopupManager::popups_for_surface(&surface).collect::<Vec<_>>() {
                let _ = PopupManager::dismiss_popup(&surface, &popup);
            }
        }
        self.decor_press = None;
        self.bar_click = None;
    }

    pub fn switch_workspace(&mut self, workspace: u32) {
        if !(1..=COUNT).contains(&workspace) || workspace == self.workspaces.active { return; }
        self.workspaces.focus[(self.workspaces.active - 1) as usize] = self.active.clone();
        self.end_workspace_input();
        self.workspaces.active = workspace;
        self.workspaces.publish();
        let _ = self.events.send(elsewhere_core::Event::Workspaces(elsewhere_core::WorkspaceState { active: workspace, count: COUNT }));
        let next = self.workspaces.focus[(workspace - 1) as usize].clone()
            .filter(|w| self.on_active_workspace(w) && self.space.element_location(w).is_some())
            .or_else(|| self.top_window());
        if self.exclusive_layer_focused() { self.active = next; }
        else { self.focus_window(next.as_ref(), SERIAL_COUNTER.next_serial()); }
        self.pointer_motion(self.pointer_location);
        self.force_full_frame = true;
        self.dirty = true;
    }

    pub fn activate_window(&mut self, window: &Window) {
        self.switch_workspace(self.window_workspace(window));
        self.unminimize(window);
        self.focus_window(Some(window), SERIAL_COUNTER.next_serial());
    }

    pub fn move_to_workspace(&mut self, window: &Window, workspace: u32) {
        if !(1..=COUNT).contains(&workspace) { return; }
        let mut root = window.clone();
        let mut seen = vec![root.clone()];
        while let Some(parent) = self.parent_window(&root) {
            if seen.contains(&parent) { break; }
            seen.push(parent.clone());
            root = parent;
        }
        if self.window_workspace(&root) == workspace { return; }
        self.assign_workspace(&root, workspace);
        self.sync_workspace_parents(true);
        self.pointer_motion(self.pointer_location);
        self.force_full_frame = true;
        self.dirty = true;
    }
}

fn focus_is_hidden(focus: Option<impl WaylandFocus>, hidden: &std::collections::HashSet<smithay::reexports::wayland_server::backend::ObjectId>) -> bool {
    focus.is_some_and(|f| f.wl_surface().is_some_and(|s| hidden.contains(&s.id())))
}
