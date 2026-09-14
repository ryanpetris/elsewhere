//! The operations behind the HTTP API and the MCP tools, implemented once. Routes and tools only
//! translate requests in and results or errors out.

use std::time::Duration;

use anyhow::Result;
use axum::{
    Json,
    http::{StatusCode, header},
    response::{IntoResponse, Response},
};
use elsewhere_core::{Bytes, Command, ControlMsg, ControlOp, InputMsg, Snapshot, SnapshotError, SnapshotReply, WindowInfo};

/// The clipboard mimes the bridge carries: text (offered to clients under every text mime), PNG and file lists.
pub const TEXT: &str = "text/plain;charset=utf-8";
pub const PNG: &str = "image/png";
/// A list of `file://` URIs, one per line: files copied in a file manager, or files the browser pasted.
pub const URI_LIST: &str = "text/uri-list";

pub fn text_mime(mime: &str) -> bool {
    matches!(mime, "text/plain;charset=utf-8" | "text/plain" | "UTF8_STRING" | "TEXT" | "STRING")
}

pub fn clipboard_limit(mime: &str) -> usize {
    if mime == PNG { 16 << 20 } else { 1 << 20 }
}

use crate::{App, apps, elements::Page};

#[derive(Debug)]
pub enum ApiError {
    Element { code: &'static str, message: String },
    Broadcast { code: &'static str, message: String },
    File { code: &'static str, message: String },
    InvalidSize(&'static str),
    InvalidInput(String),
    /// The feature is switched off (`--elements`).
    Disabled(&'static str),
    /// No live token authorized the request.
    Unauthorized,
    /// A required permission is absent.
    Forbidden,
    /// No such window.
    NotFound,
    /// No such application (`launch`, icons).
    NoSuchApp,
    /// No such file in the transfer folder (or a name that can't be one).
    NoSuchFile,
    /// Another snapshot is in flight.
    Busy,
    /// The compositor or the accessibility bus didn't answer.
    Unavailable(String),
    /// The request body is over the limit.
    TooLarge,
    /// Something on our side broke (a GL step of a snapshot, PNG encoding).
    Internal(String),
}

impl std::error::Error for ApiError {}

impl ApiError {
    pub fn status(&self) -> StatusCode {
        match self {
            ApiError::Element { code, .. } => match *code {
                "invalid" => StatusCode::BAD_REQUEST, "missing" | "stale" | "window_missing" => StatusCode::NOT_FOUND,
                "ambiguous" | "ambiguous_window" | "disabled" | "incomplete_tree" | "window_changed" => StatusCode::CONFLICT,
                "unsupported" | "state_unavailable" | "rejected" => StatusCode::UNPROCESSABLE_ENTITY,
                "busy" => StatusCode::TOO_MANY_REQUESTS, "cancelled" => StatusCode::REQUEST_TIMEOUT,
                _ => StatusCode::SERVICE_UNAVAILABLE,
            },
            ApiError::Broadcast { code, .. } => match *code { "invalid" => StatusCode::BAD_REQUEST, "missing" => StatusCode::NOT_FOUND, "conflict" => StatusCode::CONFLICT, "busy" => StatusCode::TOO_MANY_REQUESTS, _ => StatusCode::SERVICE_UNAVAILABLE },
            ApiError::File { code, .. } => match *code {
                "missing" => StatusCode::NOT_FOUND,
                "permission_denied" => StatusCode::FORBIDDEN,
                "exists" | "not_directory" | "is_directory" => StatusCode::CONFLICT,
                "invalid_path" => StatusCode::BAD_REQUEST,
                "unsupported_type" | "unsupported_operation" => StatusCode::UNPROCESSABLE_ENTITY,
                _ => StatusCode::INTERNAL_SERVER_ERROR,
            },
            ApiError::InvalidInput(_) => StatusCode::BAD_REQUEST,
            ApiError::InvalidSize(_) => StatusCode::BAD_REQUEST,
            ApiError::Disabled(_) => StatusCode::NOT_IMPLEMENTED,
            ApiError::Unauthorized => StatusCode::UNAUTHORIZED,
            ApiError::Forbidden => StatusCode::FORBIDDEN,
            ApiError::NotFound | ApiError::NoSuchApp | ApiError::NoSuchFile => StatusCode::NOT_FOUND,
            ApiError::Busy => StatusCode::TOO_MANY_REQUESTS,
            ApiError::Unavailable(_) => StatusCode::SERVICE_UNAVAILABLE,
            ApiError::TooLarge => StatusCode::PAYLOAD_TOO_LARGE,
            ApiError::Internal(_) => StatusCode::INTERNAL_SERVER_ERROR,
        }
    }
}

impl std::fmt::Display for ApiError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ApiError::Element { message, .. } | ApiError::Broadcast { message, .. } | ApiError::File { message, .. } => f.write_str(message),
            ApiError::InvalidInput(why) => f.write_str(why),
            ApiError::InvalidSize(why) => f.write_str(why),
            ApiError::Disabled(what) => f.write_str(what),
            ApiError::Unauthorized => f.write_str("invalid or expired token"),
            ApiError::Forbidden => f.write_str("permission denied"),
            ApiError::NotFound => f.write_str("no such window"),
            ApiError::NoSuchApp => f.write_str("no such application"),
            ApiError::NoSuchFile => f.write_str("no such file"),
            ApiError::Busy => f.write_str("another snapshot is in flight"),
            ApiError::TooLarge => f.write_str("over the size limit"),
            ApiError::Unavailable(why) | ApiError::Internal(why) => f.write_str(why),
        }
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let mut body = serde_json::json!({ "error": self.to_string() });
        if let Self::Element { code, .. } | Self::File { code, .. } | Self::Broadcast { code, .. } = &self { body["code"] = (*code).into(); }
        (self.status(), [(header::CACHE_CONTROL, "no-store")], Json(body)).into_response()
    }
}

pub const X11_EDGE: &str = "That part of the window is past the desktop's edge, where X11 programs can't take clicks: move or shrink the window, or enlarge the desktop.";

impl App {
    pub fn workspaces(&self) -> elsewhere_core::WorkspaceState { self.viewers.lock().unwrap().workspaces.clone() }

    /// The window list the viewers were last sent.
    pub fn windows(&self) -> Vec<WindowInfo> {
        self.viewers.lock().unwrap().window_list.clone()
    }

    /// One window and the current output scale.
    fn window(&self, id: u64) -> Result<(WindowInfo, f64), ApiError> {
        let v = self.viewers.lock().unwrap();
        let win = v.window_list.iter().find(|w| w.id == id).cloned().ok_or(ApiError::NotFound)?;
        Ok((win, v.output.scale))
    }

    fn element_windows(&self, win: &WindowInfo) -> Vec<(u64, String)> {
        let mut windows: Vec<_> = self.windows().into_iter().filter(|w| w.pid == win.pid).map(|w| (w.id, w.title)).collect();
        windows.sort_unstable();
        windows
    }

    async fn element_scan(&self, key: &crate::Key, id: u64) -> Result<(WindowInfo, Page), ApiError> {
        use crate::elements::error;
        if !self.elements { return Err(ApiError::Disabled("started without --elements")); }
        let (win, scale, windows) = {
            let viewers = self.viewers.lock().unwrap();
            let win = viewers.window_list.iter().find(|w| w.id == id).cloned().ok_or_else(|| error("window_missing", "no such desktop window"))?;
            let mut windows: Vec<_> = viewers.window_list.iter().filter(|w| w.pid == win.pid).map(|w| (w.id, w.title.clone())).collect();
            windows.sort_unstable();
            (win, viewers.output.scale, windows)
        };
        let read = async {
            let mut page = crate::elements::elements(&win, scale, windows.len() == 1).await.map_err(|e| error("bus_unavailable", format!("{e:#}")))?;
            if self.windows().iter().filter(|w| w.pid == win.pid && w.title == win.title).count() > 1 { page.level = "ambiguous"; }
            page.windows = windows.clone();
            Ok(page)
        };
        let page = tokio::select! {
            biased;
            _ = key.ended() => return Err(ApiError::Unauthorized),
            result = tokio::time::timeout(Duration::from_secs(5), read) => result.map_err(|_| error("tree_timeout", "accessibility tree read exceeded five seconds"))??,
        };
        let (live, _) = self.window(id).map_err(|_| error("window_missing", "desktop window disappeared during the read"))?;
        if live.pid != win.pid || self.element_windows(&live) != windows { return Err(error("window_changed", "application windows changed during the read")); }
        Ok((win, page))
    }

    fn element_reference(&self, win: &WindowInfo, selector: &crate::elements::Selector) -> Result<Option<crate::elements::Reference>, ApiError> {
        use crate::elements::{Selector, error};
        match selector {
            Selector::Reference { reference } if reference.len() <= 64 => {
                let r = self.element_refs.lock().unwrap().get(reference).ok_or_else(|| error("stale", "element reference expired or is unknown; read the tree again"))?;
                if r.window != win.id || r.pid != win.pid { return Err(error("stale", "element reference does not belong to this live window")); }
                Ok(Some(r))
            },
            Selector::Exact { role, name } if role.len() <= 128 && name.len() <= 4096 => Ok(None),
            _ => Err(error("invalid", "selector exceeds its size limit")),
        }
    }

    /// Current accessibility state, with bounded references scoped to this window.
    pub async fn elements(&self, key: &crate::Key, id: u64) -> Result<Page, ApiError> {
        key.require(crate::tokens::Permission::DesktopView)?;
        let _permit = self.element_slots.try_acquire().map_err(|_| crate::elements::error("busy", "sixteen accessibility operations are already active"))?;
        let (win, mut page) = self.element_scan(key, id).await?;
        let mut refs = self.element_refs.lock().unwrap();
        for element in &mut page.elements { refs.issue(&win, element); }
        Ok(page)
    }

    /// Execute one advertised semantic mutation, without coordinate fallback or retries.
    pub async fn element_mutation(&self, key: &crate::Key, id: u64, selector: crate::elements::Selector, action: Option<String>, text: Option<String>) -> Result<crate::elements::Element, ApiError> {
        use crate::elements::{self, error, Target};
        use crate::tokens::Permission::DesktopControl;
        key.require(DesktopControl)?;
        if text.as_ref().is_some_and(|t| t.len() > 65536) || action.as_ref().is_some_and(|a| a.len() > 256) { return Err(error("invalid", "text exceeds 65536 bytes or action name exceeds 256 bytes")); }
        let _permit = self.element_slots.try_acquire().map_err(|_| error("busy", "sixteen accessibility operations are already active"))?;
        let (initial, _) = self.window(id).map_err(|_| error("window_missing", "no such desktop window"))?;
        self.element_reference(&initial, &selector)?;
        let (win, page) = self.element_scan(key, id).await?;
        let reference = self.element_reference(&win, &selector)?;
        let mut element = elements::select(&page, &selector, reference.as_ref())?;
        let _admission = key.admit_dispatch().await?;
        if let Some(Target::Decoration(name)) = &element.target {
            if action.as_deref() != Some("activate") || text.is_some() { return Err(error("unsupported", "decoration buttons advertise only activate")); }
            let op = match name.as_str() { "Close" => ControlOp::Close, "Minimize" => ControlOp::Minimize, "Maximize" => ControlOp::Maximize, "Restore" => ControlOp::Unmaximize, _ => return Err(error("unsupported", "unknown decoration action")) };
            let (live, _) = self.window(id).map_err(|_| error("window_missing", "desktop window disappeared before dispatch"))?;
            if live.decoration == 0 || live.pid != win.pid || (name == "Restore" && !live.maximized) || (name == "Maximize" && live.maximized) { return Err(error("stale", "decoration changed before dispatch")); }
            key.with(&[DesktopControl], || self.control(ControlMsg { id, op }))?;
        } else {
            let conn = page.connection.as_ref().ok_or_else(|| error("bus_unavailable", "no accessibility connection"))?;
            element = tokio::select! { biased;
                _ = key.ended() => return Err(ApiError::Unauthorized),
                result = tokio::time::timeout(Duration::from_secs(5), elements::refresh(conn, &element)) => result.map_err(|_| error("tree_timeout", "target revalidation exceeded five seconds"))??,
            };
            match element.enabled { Some(true) => {}, Some(false) => return Err(error("disabled", "the target is disabled")), None => return Err(error("state_unavailable", "enabled state is unavailable")) }
            if text.is_some() && element.editable != Some(true) { return Err(error("unsupported", "the target does not advertise editable text")); }
            key.require(DesktopControl)?;
            let (live, _) = self.window(id).map_err(|_| error("window_missing", "desktop window disappeared before dispatch"))?;
            if live.pid != win.pid || self.element_windows(&live) != page.windows { return Err(error("window_changed", "application windows changed before dispatch")); }
            if let Some(Target::Node { root, frame, .. }) = &element.target {
                if root != frame && live.popups != win.popups { return Err(error("window_changed", "the popup changed before dispatch")); }
            }
            let mut dispatched = false;
            tokio::time::timeout(Duration::from_secs(10), elements::perform(conn, key, &element, action.as_deref(), text.as_deref(), &mut dispatched)).await
                .map_err(|_| if dispatched { error("uncertain", "the dispatched operation exceeded ten seconds; it may still complete; do not retry automatically") } else { error("tree_timeout", "action validation exceeded ten seconds before dispatch") })??;
        }
        self.element_refs.lock().unwrap().issue(&win, &mut element);
        Ok(element)
    }

    pub async fn element_wait(&self, key: &crate::Key, id: u64, request: crate::elements::ElementWait) -> Result<crate::elements::WaitResult, ApiError> {
        use crate::elements::{self, error, WaitResult};
        key.require(crate::tokens::Permission::DesktopView)?;
        if !self.elements { return Err(ApiError::Disabled("started without --elements")); }
        if request.timeout_ms > 300000 { return Err(error("invalid", "wait timeout must be at most 300000 milliseconds")); }
        let (window, _) = self.window(id).map_err(|_| error("window_missing", "no such desktop window"))?;
        self.element_reference(&window, &request.target)?;
        let _permit = self.element_slots.try_acquire().map_err(|_| error("busy", "sixteen accessibility operations are already active"))?;
        let started = tokio::time::Instant::now();
        let deadline = started + Duration::from_millis(request.timeout_ms);
        let mut attempts = 0;
        let mut last = None;
        let mut last_window = None;
        let mut last_error = None;
        let mut observed = false;
        while tokio::time::Instant::now() < deadline {
            attempts += 1;
            let observe = async {
                let (win, page) = self.element_scan(key, id).await?;
                let reference = self.element_reference(&win, &request.target)?;
                let mut element = match elements::select(&page, &request.target, reference.as_ref()) {
                    Ok(element) => element,
                    Err(ApiError::Element { code: "missing", .. }) => return Ok((win, None)),
                    Err(error) => return Err(error),
                };
                if reference.is_some() && matches!(element.target, Some(elements::Target::Node { .. })) {
                    let conn = page.connection.as_ref().ok_or_else(|| error("bus_unavailable", "no accessibility connection"))?;
                    element = tokio::time::timeout(Duration::from_secs(5), elements::refresh(conn, &element)).await.map_err(|_| error("tree_timeout", "target revalidation exceeded five seconds"))??;
                }
                Ok((win, Some(element)))
            };
            let observation = tokio::select! { biased;
                _ = key.ended() => return Err(ApiError::Unauthorized),
                result = tokio::time::timeout_at(deadline, observe) => match result {
                    Ok(result) => result,
                    Err(_) => { if !observed { last_error = Some(elements::WaitError { code: "tree_timeout", error: "wait deadline reached before any accessibility observation".into() }); } break; },
                },
            };
            match observation {
                Ok((win, Some(mut element))) => {
                    observed = true;
                    let matched = request.condition.matches(&element);
                    if matches!(matched, Ok(true)) {
                        self.element_refs.lock().unwrap().issue(&win, &mut element);
                        return Ok(WaitResult { matched: true, elapsed_ms: started.elapsed().as_millis() as u64, attempts, element: Some(element), last_error: None });
                    }
                    last = Some(element);
                    last_window = Some(win);
                    last_error = match matched { Ok(_) => None, Err(ApiError::Element { code, message }) => Some(elements::WaitError { code, error: message }), Err(error) => return Err(error) };
                },
                Ok((win, None)) => { observed = true; last = None; last_window = Some(win); last_error = None; },
                Err(ApiError::Element { code: code @ ("tree_timeout" | "bus_unavailable" | "window_unavailable" | "window_changed" | "incomplete_tree" | "unsupported" | "state_unavailable"), message }) => {
                    last = None;
                    last_window = None;
                    last_error = Some(elements::WaitError { code, error: message });
                },
                Err(error) => return Err(error),
            }
            tokio::select! { biased; _ = key.ended() => return Err(ApiError::Unauthorized), _ = tokio::time::sleep_until(deadline.min(tokio::time::Instant::now() + Duration::from_millis(100))) => {} }
        }
        if let (Some(win), Some(element)) = (last_window, &mut last) { self.element_refs.lock().unwrap().issue(&win, element); }
        Ok(WaitResult { matched: false, elapsed_ms: started.elapsed().as_millis() as u64, attempts, element: last, last_error })
    }

    /// PNG of one window or, with `None`, the whole output. Omitted sizing is native.
    pub async fn snapshot(&self, id: Option<u64>, sizing: elsewhere_core::SnapshotSizing) -> Result<Vec<u8>, ApiError> {
        sizing.validate().map_err(ApiError::InvalidSize)?;
        // One at a time: the compositor renders these on its own thread and a queued request can't be cancelled.
        let Ok(busy) = self.snapshot_lock.clone().try_acquire_owned() else { return Err(ApiError::Busy) };
        let (tx, rx) = tokio::sync::oneshot::channel::<(Result<Snapshot, SnapshotError>, tokio::sync::OwnedSemaphorePermit)>();
        let reply = SnapshotReply(Box::new(move |s| {
            let _ = tx.send((s, busy));
        }));
        let started = std::time::Instant::now();
        self.send(Command::Snapshot { id, sizing, reply })?;
        let (result, _busy) = match tokio::time::timeout(Duration::from_secs(2), rx).await {
            Ok(Ok(result)) => result,
            _ => return Err(ApiError::Unavailable("the compositor didn't answer".into())),
        };
        let snap = match result {
            Ok(s) => s,
            Err(SnapshotError::Unavailable(why)) => return Err(ApiError::Unavailable(why.into())),
            Err(SnapshotError::InvalidSize(why)) => return Err(ApiError::InvalidSize(why)),
            Err(SnapshotError::NoSuchWindow) => return Err(ApiError::NotFound),
            Err(SnapshotError::Render(e)) => return Err(ApiError::Internal(e)),
        };
        let capture_ms = started.elapsed().as_secs_f64() * 1000.0;
        let (width, height) = (snap.width, snap.height);
        let encoding = std::time::Instant::now();
        let png = encode_png_with_permit(snap, Some(_busy)).await?;
        tracing::debug!(?id, width, height, bytes = png.len(), capture_ms, encode_ms = encoding.elapsed().as_secs_f64() * 1000.0, "snapshot completed");
        Ok(png)
    }

    /// What was last put on the clipboard, by an application, the browser or the API: its mime and bytes.
    pub fn clipboard(&self) -> Option<(String, Bytes)> {
        let clipboard = &self.viewers.lock().unwrap().clipboard;
        clipboard.mime.clone().zip(clipboard.data.clone())
    }

    /// Text (`TEXT`), a PNG or a file list becomes the desktop clipboard; fire-and-forget like control. The compositor
    /// reports it back like any clipboard change, which is what `clipboard()` and the viewers then see.
    pub fn set_clipboard(&self, mime: &str, data: Bytes) -> Result<(), ApiError> {
        self.queue_clipboard(mime, data).map(|_| ())
    }

    /// The operation is echoed only after the compositor has installed this selection.
    pub fn queue_clipboard(&self, mime: &str, data: Bytes) -> Result<u64, ApiError> {
        if data.len() > clipboard_limit(mime) {
            return Err(ApiError::TooLarge);
        }
        let mut viewers = self.viewers.lock().unwrap();
        let operation = viewers.next_clipboard_write;
        viewers.next_clipboard_write += 1;
        self.send(Command::SetClipboard { mime: mime.to_string(), data: data.to_vec(), operation: Some(elsewhere_core::ClipboardOperation { id: operation, source: None }) })?;
        Ok(operation)
    }

    /// A window action, spawn, launch or quit. Fire-and-forget: the compositor ignores unknown ids and
    /// impossible requests.
    pub fn control(&self, msg: ControlMsg) -> Result<(), ApiError> {
        if let ControlOp::SwitchWorkspace { workspace } | ControlOp::MoveToWorkspace { workspace } | ControlOp::DeleteWorkspace { workspace } = &msg.op {
            if !self.workspaces().workspaces.iter().any(|entry| entry.id == *workspace) {
                return Err(ApiError::InvalidInput("unknown workspace".into()));
            }
        }
        if let ControlOp::DeleteWorkspace { .. } = &msg.op {
            if self.workspaces().workspaces.len() == 1 { return Err(ApiError::InvalidInput("the last workspace cannot be deleted".into())); }
        }
        if let ControlOp::CreateWorkspace { name: Some(name) } = &msg.op {
            if name.len() > 256 || name.chars().any(char::is_control) { return Err(ApiError::InvalidInput("invalid workspace name".into())); }
        }
        let cmd = self.command_for(msg)?;
        self.send(cmd)
    }

    /// The compositor's command for a control request: a launcher becomes its Exec line, quit ends the
    /// desktop, the rest is the window action itself.
    pub fn command_for(&self, msg: ControlMsg) -> Result<Command, ApiError> {
        Ok(match msg.op {
            ControlOp::Launch { app } => Command::Control(ControlMsg { id: 0, op: ControlOp::Spawn { cmd: apps::exec(&app).ok_or(ApiError::NoSuchApp)? } }),
            ControlOp::Quit => Command::Quit,
            _ => Command::Control(msg),
        })
    }

    /// Xwayland's screen is the output, and the X server pins its pointer to it: a click on the part of an
    /// X11 window that hangs past the output's edge lands on the edge instead. Says so for such a click
    /// (one inside the client's own area; the title bar and resize band around it are ours).
    pub fn x11_edge_warning(&self, window: u64, x: f64, y: f64) -> Option<&'static str> {
        let v = self.viewers.lock().unwrap();
        let w = v.window_list.iter().find(|w| w.id == window).filter(|w| w.x11)?;
        let inside = (0.0..w.w as f64).contains(&x) && (0.0..w.h as f64).contains(&y);
        let (ax, ay) = (w.x as f64 + x, w.y as f64 + y);
        let (ow, oh) = (v.output.width_px as f64 / v.output.scale, v.output.height_px as f64 / v.output.scale);
        (inside && (ax < 0.0 || ay < 0.0 || ax >= ow || ay >= oh)).then_some(X11_EDGE)
    }

    /// The installed applications, by name. A few hundred small files: read off the async workers.
    pub async fn applications(&self) -> Vec<apps::AppInfo> {
        tokio::task::spawn_blocking(apps::list).await.unwrap_or_default()
    }

    /// An application's icon as bytes and media type.
    pub async fn application_icon(&self, id: String) -> Result<(Vec<u8>, &'static str), ApiError> {
        tokio::task::spawn_blocking(move || {
            let (path, mime) = apps::icon(&id).ok_or(ApiError::NoSuchApp)?;
            Ok((std::fs::read(path).map_err(|e| ApiError::Internal(e.to_string()))?, mime))
        })
        .await
        .map_err(|e| ApiError::Internal(e.to_string()))?
    }

    /// A window's icon as bytes and media type: the name its client set, else the pixels it set, else
    /// its launcher's icon.
    pub async fn window_icon(&self, id: u64) -> Result<(Vec<u8>, &'static str), ApiError> {
        let (WindowInfo { icon, app_id, .. }, _) = self.window(id)?;
        if let Some(name) = icon
            && let Some(found) = read_icon(move || apps::named_icon(&name)).await?
        {
            return Ok(found);
        }
        let (tx, rx) = tokio::sync::oneshot::channel::<Result<Snapshot, SnapshotError>>();
        let reply = SnapshotReply(Box::new(move |s| {
            let _ = tx.send(s);
        }));
        self.send(Command::WindowIcon { id, reply })?;
        match tokio::time::timeout(Duration::from_secs(2), rx).await {
            Ok(Ok(Ok(snap))) => Ok((encode_png(snap).await?, "image/png")),
            Ok(Ok(Err(SnapshotError::Unavailable(why)))) => Err(ApiError::Unavailable(why.into())),
            Ok(Ok(Err(SnapshotError::InvalidSize(why)))) => Err(ApiError::InvalidSize(why)),
            Ok(Ok(Err(SnapshotError::NoSuchWindow))) => read_icon(move || apps::launcher_icon(&app_id)).await?.ok_or(ApiError::NotFound),
            Ok(Ok(Err(SnapshotError::Render(e)))) => Err(ApiError::Internal(e)),
            _ => Err(ApiError::Unavailable("the compositor didn't answer".into())),
        }
    }

    /// Pointer and keyboard input. `window` makes coordinates relative to that window's geometry; the
    /// compositor resolves it against the live geometry, this only answers 404 for an unknown id.
    pub(crate) fn authorized_input(&self, key: &crate::Key, msg: InputMsg) -> Result<(), ApiError> {
        if let InputMsg::Move { window: Some(id), .. } | InputMsg::Click { window: Some(id), .. } = &msg {
            self.window(*id)?;
        }
        let desktop = matches!(msg, InputMsg::Move { window: None, .. } | InputMsg::Click { window: None, .. });
        let command = Command::Input(msg);
        self.send_input(key, u64::MAX, if desktop { Command::DesktopInput(Box::new(command)) } else { command })
    }

    pub(crate) fn send(&self, cmd: Command) -> Result<(), ApiError> {
        self.commands.send(cmd).map_err(|_| ApiError::Unavailable("the compositor is gone".into()))
    }
}

/// An icon file found by `find`, read on the blocking pool.
async fn read_icon(find: impl FnOnce() -> Option<(std::path::PathBuf, &'static str)> + Send + 'static) -> Result<Option<(Vec<u8>, &'static str)>, ApiError> {
    tokio::task::spawn_blocking(move || {
        let Some((path, mime)) = find() else { return Ok(None) };
        Ok(Some((std::fs::read(path).map_err(|e| ApiError::Internal(e.to_string()))?, mime)))
    })
    .await
    .map_err(|e| ApiError::Internal(e.to_string()))?
}

/// Straight-alpha RGBA rows to PNG, on the blocking pool.
pub(crate) async fn encode_png(snap: Snapshot) -> Result<Vec<u8>, ApiError> {
    encode_png_with_permit(snap, None).await
}

async fn encode_png_with_permit(snap: Snapshot, busy: Option<tokio::sync::OwnedSemaphorePermit>) -> Result<Vec<u8>, ApiError> {
    let png = tokio::task::spawn_blocking(move || -> Result<Vec<u8>> {
        let _busy = busy;
        let mut out = Vec::new();
        let mut enc = png::Encoder::new(&mut out, snap.width, snap.height);
        enc.set_color(png::ColorType::Rgba);
        enc.set_depth(png::BitDepth::Eight);
        enc.write_header()?.write_image_data(&snap.rgba)?;
        Ok(out)
    })
    .await;
    match png {
        Ok(Ok(bytes)) => Ok(bytes),
        Ok(Err(e)) => Err(ApiError::Internal(format!("png: {e}"))),
        Err(e) => Err(ApiError::Internal(format!("png: {e}"))),
    }
}

#[cfg(test)]
mod capture_tests {
    use super::*;

    #[test]
    fn cancelled_encoding_keeps_capture_slot_until_blocking_work_finishes() {
        tokio::runtime::Builder::new_current_thread().enable_all().max_blocking_threads(1).build().unwrap().block_on(async {
            let semaphore = std::sync::Arc::new(tokio::sync::Semaphore::new(1));
            let permit = semaphore.clone().acquire_owned().await.unwrap();
            let (release, blocked) = std::sync::mpsc::channel();
            let (started, ready) = tokio::sync::oneshot::channel();
            let blocker = tokio::task::spawn_blocking(move || { started.send(()).unwrap(); blocked.recv().unwrap(); });
            ready.await.unwrap();
            let encoding = encode_png_with_permit(Snapshot { width: 1, height: 1, rgba: vec![0; 4] }, Some(permit));
            assert!(tokio::time::timeout(Duration::from_millis(10), encoding).await.is_err());
            let held = semaphore.try_acquire().is_err();
            release.send(()).unwrap();
            blocker.await.unwrap();
            assert!(held, "cancelled request released its slot while PNG work was queued");
            let _released = tokio::time::timeout(Duration::from_secs(2), semaphore.acquire()).await.unwrap().unwrap();
        });
    }
}
