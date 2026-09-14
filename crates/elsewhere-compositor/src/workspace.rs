//! Dynamic desktops, shared by viewers and ext-workspace panel clients.

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
    pending: Vec<elsewhere_core::ControlOp>,
}

impl Binding {
    fn add(&mut self, dh: &DisplayHandle, entry: &elsewhere_core::Workspace, active: u32) {
        let Some(client) = self.manager.client() else { return; };
        let Ok(ws) = client.create_resource::<ExtWorkspaceHandleV1, (ExtWorkspaceManagerV1, u32), State>(dh, self.manager.version(), (self.manager.clone(), entry.id)) else { return; };
        self.manager.workspace(&ws);
        ws.id(entry.id.to_string());
        ws.name(entry.name.clone());
        ws.coordinates((entry.id - 1).to_ne_bytes().to_vec());
        ws.state(if entry.id == active { handle::State::Active } else { handle::State::empty() });
        ws.capabilities(handle::WorkspaceCapabilities::Activate | handle::WorkspaceCapabilities::Remove);
        self.group.workspace_enter(&ws);
        self.handles.push((entry.id, ws));
    }
}

pub struct Workspaces {
    pub active: u32,
    pub input: u32,
    pub entries: Vec<elsewhere_core::Workspace>,
    next_id: Option<u32>,
    pub focus: std::collections::HashMap<u32, Window>,
    bindings: Vec<Binding>,
}

impl Default for Workspaces {
    fn default() -> Self { Self { active: 1, input: 1, entries: elsewhere_core::WorkspaceState::default().workspaces, next_id: Some(2), focus: Default::default(), bindings: Vec::new() } }
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
        self.focus.retain(|_, focus| focus != window);
    }
}

impl GlobalDispatch<ExtWorkspaceManagerV1, ()> for State {
    fn bind(state: &mut Self, dh: &DisplayHandle, client: &Client, resource: New<ExtWorkspaceManagerV1>, _: &(), data_init: &mut DataInit<'_, Self>) {
        let manager = data_init.init(resource, ());
        let Ok(group) = client.create_resource::<ExtWorkspaceGroupHandleV1, (), State>(dh, manager.version(), ()) else { return; };
        manager.workspace_group(&group);
        group.capabilities(group::GroupCapabilities::CreateWorkspace);
        for output in state.output.client_outputs(client) { group.output_enter(&output); }
        let mut binding = Binding { manager, group, handles: Vec::new(), pending: Vec::new() };
        for entry in &state.workspaces.entries { binding.add(dh, entry, state.workspaces.active); }
        binding.manager.done();
        state.workspaces.bindings.push(binding);
    }
}

impl Dispatch<ExtWorkspaceManagerV1, ()> for State {
    fn request(state: &mut Self, _: &Client, manager: &ExtWorkspaceManagerV1, request: manager::Request, _: &(), _: &DisplayHandle, _: &mut DataInit<'_, Self>) {
        match request {
            manager::Request::Commit => {
                let pending = state.workspaces.bindings.iter_mut().find(|b| b.manager == *manager).map(|b| std::mem::take(&mut b.pending)).unwrap_or_default();
                for op in pending { state.control(elsewhere_core::ControlMsg { id: 0, op }); }
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
    fn request(state: &mut Self, _: &Client, group: &ExtWorkspaceGroupHandleV1, request: group::Request, _: &(), _: &DisplayHandle, _: &mut DataInit<'_, Self>) {
        if let group::Request::CreateWorkspace { workspace } = request {
            if let Some(b) = state.workspaces.bindings.iter_mut().find(|b| b.group == *group) {
                b.pending.push(elsewhere_core::ControlOp::CreateWorkspace { name: Some(workspace) });
            }
        }
    }
}

impl Dispatch<ExtWorkspaceHandleV1, (ExtWorkspaceManagerV1, u32)> for State {
    fn request(state: &mut Self, _: &Client, _: &ExtWorkspaceHandleV1, request: handle::Request, data: &(ExtWorkspaceManagerV1, u32), _: &DisplayHandle, _: &mut DataInit<'_, Self>) {
        let op = match request {
            handle::Request::Activate => elsewhere_core::ControlOp::SwitchWorkspace { workspace: data.1 },
            handle::Request::Remove => elsewhere_core::ControlOp::DeleteWorkspace { workspace: data.1 },
            _ => return,
        };
        if let Some(b) = state.workspaces.bindings.iter_mut().find(|b| b.manager == data.0) { b.pending.push(op); }
    }
}


struct Membership(Cell<u32>);

impl State {
    pub fn workspace_state(&self) -> elsewhere_core::WorkspaceState {
        elsewhere_core::WorkspaceState { active: self.workspaces.active, workspaces: self.workspaces.entries.clone() }
    }

    pub fn create_workspace(&mut self, name: Option<String>) {
        let Some(id) = self.workspaces.next_id else { return; };
        let name = name.filter(|s| !s.trim().is_empty()).unwrap_or_else(|| id.to_string());
        if name.len() > 256 || name.chars().any(char::is_control) { return; }
        self.workspaces.next_id = id.checked_add(1);
        let entry = elsewhere_core::Workspace { id, name };
        for binding in &mut self.workspaces.bindings { binding.add(&self.dh, &entry, self.workspaces.active); }
        self.workspaces.entries.push(entry);
        self.workspaces.publish();
        let _ = self.events.send(elsewhere_core::Event::Workspaces(self.workspace_state()));
    }

    pub fn rename_workspace(&mut self, workspace: u32, name: String) {
        if name.trim().is_empty() || name.len() > 256 || name.chars().any(char::is_control) { return; }
        let Some(entry) = self.workspaces.entries.iter_mut().find(|entry| entry.id == workspace) else { return; };
        if entry.name == name { return; }
        entry.name = name;
        for binding in &self.workspaces.bindings {
            for (id, handle) in &binding.handles {
                if *id == workspace && handle.is_alive() { handle.name(entry.name.clone()); }
            }
            binding.manager.done();
        }
        let _ = self.events.send(elsewhere_core::Event::Workspaces(self.workspace_state()));
    }

    pub fn delete_workspace(&mut self, workspace: u32) {
        if !self.workspaces.entries.iter().any(|entry| entry.id == workspace) { return; }
        let Some(target) = self.workspaces.entries.iter().find(|entry| entry.id != workspace).map(|entry| entry.id) else { return; };
        if self.workspaces.active == workspace { self.switch_workspace(target); }
        if self.workspaces.input == workspace { self.set_input_workspace(target); }
        for window in self.full_stack() {
            if self.window_workspace(&window) == workspace { self.assign_workspace(&window, target); }
        }
        self.workspaces.entries.retain(|entry| entry.id != workspace);
        self.workspaces.focus.remove(&workspace);
        for binding in &mut self.workspaces.bindings {
            binding.handles.retain(|(id, handle)| {
                if *id != workspace { return true; }
                if handle.is_alive() { binding.group.workspace_leave(handle); handle.removed(); }
                false
            });
        }
        self.sync_workspace_parents(true);
        self.workspaces.publish();
        let _ = self.events.send(elsewhere_core::Event::Workspaces(self.workspace_state()));
    }

    pub fn active_element_under(&self, point: Point<f64, Logical>) -> Option<(&Window, Point<i32, Logical>)> {
        self.space.elements().rev().filter(|w| self.on_input_workspace(w)).find_map(|w| {
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

    pub fn on_input_workspace(&self, window: &Window) -> bool {
        self.window_workspace(window) == self.workspaces.input
    }

    pub fn set_input_workspace(&mut self, workspace: u32) {
        if workspace == self.workspaces.input { return; }
        if let Some(window) = self.active.clone().filter(|w| self.on_input_workspace(w)) {
            self.workspaces.focus.insert(self.workspaces.input, window);
        }
        let pending = self.pending_initial_focus.clone().filter(|w| self.window_workspace(w) == workspace);
        self.end_workspace_input();
        self.workspaces.input = workspace;
        let next = self.workspaces.focus.get(&workspace).cloned()
            .filter(|w| self.on_input_workspace(w) && self.space.element_location(w).is_some())
            .or_else(|| self.top_window());
        if self.focus_exclusive_layer() { self.active = next; }
        else { self.focus_window(next.as_ref(), SERIAL_COUNTER.next_serial()); }
        self.pending_initial_focus = pending;
        self.pointer_motion(self.pointer_location);
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
        let hidden_focus = self.active.as_ref().is_some_and(|w| !self.on_input_workspace(w));
        let mut hidden_surfaces = std::collections::HashSet::new();
        if membership_changed {
            for window in windows.iter().filter(|w| !self.on_input_workspace(w)) {
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
            || self.pointer_grab_window.as_ref().is_some_and(|w| !self.on_input_workspace(w))
            || self.touch_grab_window.as_ref().is_some_and(|w| !self.on_input_workspace(w));
        if hidden_focus || hidden_owner {
            if hidden_owner || !self.exclusive_layer_focused() { self.end_workspace_input(); }
            let next = self.active.clone().filter(|w| self.on_input_workspace(w)).or_else(|| self.top_window());
            if self.exclusive_layer_focused() { self.active = next; }
            else { self.focus_window(next.as_ref(), SERIAL_COUNTER.next_serial()); }
        }
        if membership_changed {
            self.pointer_motion(self.pointer_location);
            self.force_full_frame = true;
            self.dirty = true;
        }
    }

    pub(crate) fn end_workspace_input(&mut self) {
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
        if !self.workspaces.entries.iter().any(|entry| entry.id == workspace) || workspace == self.workspaces.active { return; }
        if let Some(window) = self.active.clone() { self.workspaces.focus.insert(self.workspaces.input, window); } else { self.workspaces.focus.remove(&self.workspaces.input); }
        self.end_workspace_input();
        self.workspaces.active = workspace;
        self.workspaces.input = workspace;
        self.workspaces.publish();
        let _ = self.events.send(elsewhere_core::Event::Workspaces(self.workspace_state()));
        let next = self.workspaces.focus.get(&workspace).cloned()
            .filter(|w| self.on_active_workspace(w) && self.space.element_location(w).is_some())
            .or_else(|| self.top_window());
        if self.focus_exclusive_layer() { self.active = next; }
        else { self.focus_window(next.as_ref(), SERIAL_COUNTER.next_serial()); }
        self.pointer_motion(self.pointer_location);
        self.force_full_frame = true;
        self.dirty = true;
    }

    pub fn activate_window(&mut self, window: &Window) {
        self.switch_workspace(self.window_workspace(window));
        self.set_input_workspace(self.window_workspace(window));
        self.unminimize(window);
        self.focus_window(Some(window), SERIAL_COUNTER.next_serial());
    }

    pub fn move_to_workspace(&mut self, window: &Window, workspace: u32) {
        if !self.workspaces.entries.iter().any(|entry| entry.id == workspace) { return; }
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
