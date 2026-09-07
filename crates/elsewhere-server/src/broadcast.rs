//! The single backend for HTTP and MCP broadcasts; only runtime state lives here.
use std::{collections::HashMap, sync::Arc, time::{Duration, Instant}};
use axum::{extract::{Path, State}, Extension, Json};
use elsewhere_core::{broadcast::{Capabilities, Control, Start, Status}, Command, FrameSink};
use sha2::{Digest, Sha256};
use crate::{api::ApiError, App, Key};

pub type Factory = Box<dyn Fn(Start) -> anyhow::Result<(Box<dyn FrameSink>, Arc<dyn Control>)> + Send + Sync>;
pub struct Backend {
    pub start: Factory,
    pub capabilities: Box<dyn Fn() -> Capabilities + Send + Sync>,
}
struct Entry { status: Status, control: Arc<dyn Control>, request_id: String, digest: [u8; 32], created: Instant, key: u64, attached: bool }
#[derive(Default)]
pub struct Registry { entries: HashMap<String, Entry>, sequence: u64 }
const RETAIN: Duration = Duration::from_secs(600);

fn error(code: &'static str, message: &str) -> ApiError { ApiError::Broadcast { code, message: message.into() } }
fn validate(s: &Start, c: &Capabilities) -> Result<(), ApiError> {
    if !c.available { return Err(error("unavailable", c.error.as_deref().unwrap_or("Broadcasting unavailable."))); }
    if s.request_id.is_empty() || s.request_id.len() > 128 || !s.request_id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_') { return Err(error("invalid", "request_id must contain 1–128 letters, digits, hyphens or underscores.")); }
    if s.label.is_empty() || s.label.encode_utf16().count() > 120 || s.label.chars().any(char::is_control) { return Err(error("invalid", "label must contain 1–120 UTF-16 code units without control characters.")); }
    let uri: axum::http::Uri = s.url.parse().map_err(|_| error("invalid", "Invalid RTMP destination URL."))?;
    if !matches!(uri.scheme_str(), Some("rtmp" | "rtmps")) || uri.host().is_none() || uri.authority().is_some_and(|a| a.as_str().contains('@')) || s.url.len() > 4096 || s.url.chars().any(char::is_whitespace) || s.url.contains('#') {
        return Err(error("invalid", "Use an RTMP or RTMPS URL without user information, fragments or whitespace."));
    }
    if s.stream_key.len() > 4096 || s.stream_key.contains('#') || s.stream_key.chars().any(|c| c.is_control() || c.is_whitespace()) || (!s.stream_key.is_empty() && uri.query().is_some()) { return Err(error("invalid", "Invalid stream key, or a query in the base URL. Put destination query parameters in the stream key.")); }
    if s.width < 64 || s.height < 64 || s.width > c.max_width || s.height > c.max_height || s.width % 2 != 0 || s.height % 2 != 0 || !matches!(s.fps, 24 | 25 | 30 | 50 | 60) || s.bitrate_kbps < c.min_bitrate_kbps || s.bitrate_kbps > c.max_bitrate_kbps { return Err(error("invalid", "Use even dimensions from 64 up to the capability limits, 24/25/30/50/60 fps, and a supported bitrate.")); }
    if s.audio == elsewhere_core::broadcast::Audio::Desktop && !c.desktop_audio { return Err(error("unavailable", "Desktop audio is unavailable. Select silence to broadcast without desktop audio.")); }
    Ok(())
}
impl App {
    pub fn broadcast_capabilities(&self) -> Capabilities {
        let mut c = (self.broadcast_backend.capabilities)();
        c.desktop_audio &= self.audio_available.load(std::sync::atomic::Ordering::Relaxed);
        c
    }
    pub fn broadcast_start(&self, key: Key, settings: Start) -> Result<Status, ApiError> {
        crate::writable(key)?;
        let caps = self.broadcast_capabilities();
        let digest: [u8; 32] = Sha256::digest(serde_json::to_vec(&settings).map_err(|_| error("invalid", "Invalid broadcast settings."))?).into();
        let mut registry = self.broadcasts.lock().unwrap();
        self.broadcast_sweep_locked(&mut registry);
        if let Some(entry) = registry.entries.values().find(|e| e.request_id == settings.request_id) {
            if entry.digest != digest { return Err(error("conflict", "This request_id already belongs to different settings.")); }
            return Ok(snapshot(entry));
        }
        validate(&settings, &caps)?;
        if registry.entries.values().filter(|e| !e.control.progress().state.terminal()).count() >= caps.max_outputs { return Err(error("busy", "The maximum number of simultaneous broadcasts is already running.")); }
        if registry.entries.len() >= 256 { return Err(error("busy", "Too many recent broadcast requests. Try again after the ten-minute retry window.")); }
        let (sink, control) = (self.broadcast_backend.start)(settings.clone()).map_err(|_| error("unavailable", "Could not start the broadcast worker."))?;
        registry.sequence += 1;
        let output_key = (1u64 << 63) | registry.sequence;
        let id = crate::random_hex(16);
        let status = Status { id: id.clone(), label: settings.label, width: settings.width, height: settings.height, fps: settings.fps, bitrate_kbps: settings.bitrate_kbps, audio: settings.audio, cursor: settings.cursor, progress: control.progress() };
        if self.commands.send(Command::ViewerStream { key: output_key, sink: Some(sink) }).is_err() { control.stop(); return Err(error("unavailable", "The desktop is unavailable.")); }
        registry.entries.insert(id, Entry { status: status.clone(), control, request_id: settings.request_id, digest, created: Instant::now(), key: output_key, attached: true });
        Ok(status)
    }
    pub fn broadcast_stop(&self, key: Key, id: &str) -> Result<Status, ApiError> {
        crate::writable(key)?;
        let mut r = self.broadcasts.lock().unwrap();
        let e = r.entries.get_mut(id).ok_or_else(|| error("missing", "No such broadcast."))?;
        e.control.stop();
        if e.attached { let _ = self.commands.send(Command::ViewerStream { key: e.key, sink: None }); e.attached = false; }
        Ok(snapshot(e))
    }
    pub fn broadcast_list(&self) -> Vec<Status> {
        let mut r = self.broadcasts.lock().unwrap(); self.broadcast_sweep_locked(&mut r);
        let mut result: Vec<_> = r.entries.values().map(snapshot).collect(); result.sort_by(|a,b| a.id.cmp(&b.id)); result
    }
    pub fn broadcast_get(&self, id: &str) -> Result<Status, ApiError> { self.broadcasts.lock().unwrap().entries.get(id).map(snapshot).ok_or_else(|| error("missing", "No such broadcast.")) }
    fn broadcast_sweep_locked(&self, r: &mut Registry) {
        for e in r.entries.values_mut() {
            if e.attached && e.control.progress().state.terminal() { let _ = self.commands.send(Command::ViewerStream { key: e.key, sink: None }); e.attached = false; }
        }
        r.entries.retain(|_, e| !e.control.progress().state.terminal() || e.created.elapsed() < RETAIN);
    }
}
fn snapshot(e: &Entry) -> Status { Status { progress: e.control.progress(), ..e.status.clone() } }
impl Drop for Registry { fn drop(&mut self) { for e in self.entries.values() { e.control.stop(); } } }

pub async fn start(Extension(key): Extension<Key>, State(app): State<Arc<App>>, Json(settings): Json<Start>) -> Result<Json<Status>, ApiError> { app.broadcast_start(key, settings).map(Json) }
pub async fn stop(Extension(key): Extension<Key>, State(app): State<Arc<App>>, Path(id): Path<String>) -> Result<Json<Status>, ApiError> { app.broadcast_stop(key, &id).map(Json) }
pub async fn list(State(app): State<Arc<App>>) -> Json<Vec<Status>> { Json(app.broadcast_list()) }
pub async fn get(State(app): State<Arc<App>>, Path(id): Path<String>) -> Result<Json<Status>, ApiError> { app.broadcast_get(&id).map(Json) }
pub async fn capabilities(State(app): State<Arc<App>>) -> Json<Capabilities> { Json(app.broadcast_capabilities()) }
pub async fn sweep(app: std::sync::Weak<App>) {
    let mut interval = tokio::time::interval(Duration::from_secs(1));
    loop { interval.tick().await; let Some(app) = app.upgrade() else { return; }; app.broadcast_list(); }
}
