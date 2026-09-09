//! HTTPS + WebSocket front end: serves the viewer page, authenticates the WebSocket in-band and the
//! HTTP API with a bearer token (never a cookie), streams encoded video out (one encoder per viewer)
//! and turns permitted input into `Command`s. Each token carries explicit grants.

mod api;
mod auth;
mod apps;
mod elements;
mod mcp;
pub mod broadcast;
mod mixer;
pub use mixer::{Mixer, MixerAudience};
pub mod files;
mod notify;
pub mod rtc;
mod protocol;
#[cfg(test)]
mod reference;
mod ws;
mod terminal;
pub mod tokens;

use std::{
    collections::HashMap,
    fs, io,
    net::SocketAddr,
    os::unix::fs::OpenOptionsExt,
    path::{Path, PathBuf},
    sync::{Arc, Mutex, Weak},
};

use anyhow::{Context, Result};
use api::ApiError;
use axum::{
    Extension, Json, Router,
    extract::{OriginalUri, Path as UrlPath, Query, Request, State, ws::WebSocketUpgrade},
    http::{HeaderMap, StatusCode, header},
    middleware::{self, Next},
    response::{Html, IntoResponse, Redirect, Response},
    routing::{get, post, put},
};
use elsewhere_core::{Bytes, Codec, Command, ControlMsg, Event, FrameSink, InputMsg, OutputGeometry, StreamControl, StreamMsg, WindowInfo};
use rmcp::transport::streamable_http_server::{StreamableHttpServerConfig, StreamableHttpService, session::local::LocalSessionManager};
use tokio::sync::mpsc;

/// Makes an encoder for one viewer or window stream: the sink the compositor feeds and a control
/// handle that must not keep the encoder worker alive (the stream ends when the compositor drops the sink).
pub type SinkFactory = Box<dyn Fn(mpsc::Sender<StreamMsg>) -> Result<(Box<dyn FrameSink>, Box<dyn StreamControl>)> + Send + Sync>;

pub type Key = Arc<auth::Access>;
use tokens::Permission as P;

pub struct Config {
    pub listen: SocketAddr,
    pub tls: bool,
    /// Public path validated by the CLI: empty for root, otherwise literal ASCII segments,
    /// a leading slash and no trailing slash, escapes, dot segments or route parameters.
    pub url_prefix: String,
    /// Accept root routes because the proxy strips the public prefix before forwarding.
    pub proxy_strips_prefix: bool,
    /// Startup-probed codecs allowed by the configuration, and whether encoding uses the CPU.
    pub codecs: Vec<Codec>,
    pub software: bool,
    /// `--bitrate`: the Medium quality level's bitrate ceiling.
    pub bitrate_kbps: u32,
    /// The compositor's initial output geometry.
    pub initial: elsewhere_core::OutputGeometry,
    /// Keep the initial resolution when viewers resize or take control.
    pub fixed_size: bool,
    /// Where the state database and TLS certificate/key live.
    pub data_dir: PathBuf,
    /// Serve /api/windows/{id}/elements (see `elements.rs`).
    pub elements: bool,
    /// Where dropped files land and downloads come from (`files.rs`).
    pub files_dir: PathBuf,
    /// Reported to MCP clients.
    pub version: &'static str,
    /// One encoder per viewer and per window stream.
    pub sinks: SinkFactory,
    pub broadcast: broadcast::Backend,
    /// Whether session playback initialized successfully, independently of microphone capture.
    pub audio_available: bool,
    pub mixer: Option<Mixer>,
    /// Where browser microphone packets go; `None` without a microphone.
    pub mic: Option<mpsc::Sender<Bytes>>,
    /// Where the browser's webcam frames (VP8) go to be played into the loopback camera; `None` without
    /// `--webcam`, or when its device couldn't be opened.
    pub cam: Option<mpsc::Sender<Bytes>>,
    /// The WebRTC data-channel transport for the video (`rtc.rs`); `None` with `--no-rtc`.
    pub rtc: Option<rtc::Config>,
}

impl Config {
    pub fn default_data_dir() -> Result<PathBuf> {
        let base = match std::env::var_os("XDG_CONFIG_HOME") {
            Some(d) => PathBuf::from(d),
            None => PathBuf::from(std::env::var_os("HOME").context("neither XDG_CONFIG_HOME nor HOME is set")?).join(".config"),
        };
        Ok(base.join("elsewhere"))
    }
}

pub struct App {
    tokens: tokens::Store,
    auth_serial: tokio::sync::Mutex<()>,
    active_tokens: Mutex<HashMap<uuid::Uuid, Weak<auth::Access>>>,
    input_owner: Mutex<Option<(uuid::Uuid, u64)>>,
    batches: Mutex<HashMap<String, Key>>,
    mcp_sessions: Arc<mcp::sessions::Sessions>,
    commands: calloop::channel::Sender<Command>,
    codecs: Vec<Codec>,
    software: bool,
    bitrate_kbps: u32,
    fixed_size: bool,
    viewers: Mutex<Viewers>,
    sinks: SinkFactory,
    broadcast_backend: broadcast::Backend,
    broadcasts: Mutex<broadcast::Registry>,
    audio_available: std::sync::atomic::AtomicBool,
    mixer: Option<Mixer>,
    mic: Option<mpsc::Sender<Bytes>>,
    cam: Option<mpsc::Sender<Bytes>>,
    rtc: Option<rtc::Hub>,
    /// The webcam worker failed; withdraw the feature.
    cam_dead: std::sync::atomic::AtomicBool,
    /// Event senders of the window-stream sessions (cursor, clipboard, window list go to them too).
    window_viewers: Mutex<HashMap<u64, WindowViewer>>,
    snapshot_lock: Arc<tokio::sync::Semaphore>,
    /// Open desktop notifications by id (`notify.rs`), the next id, and the bus we serve them on.
    notifications: Mutex<HashMap<u32, notify::Open>>,
    next_notification: std::sync::atomic::AtomicU32,
    notify_bus: std::sync::OnceLock<zbus::Connection>,
    files_dir: PathBuf,
    /// Where a drag's or a paste's files wait for the application that takes them (`files.rs`).
    drops_dir: PathBuf,
    elements: bool,
    version: &'static str,
    tls: bool,
    port: u16,
    url_prefix: String,
    proxy_strips_prefix: bool,
}

/// The connected viewers and what they all see. One of them, the controller, drives the pointer and
/// keyboard and sizes the output; the others watch the same desktop scaled to their own window.
pub(crate) struct Viewers {
    sessions: HashMap<u64, ViewerSession>,
    controller: Option<u64>,
    control_epoch: u64,
    /// The output as the controller last sized it.
    output: OutputGeometry,
    /// Last cursor message, replayed to a new viewer.
    cursor: Option<Bytes>,
    /// Whether a client currently holds a pointer lock, replayed to a new viewer.
    locked: bool,
    /// Last WINDOWS message, replayed to a new viewer, and the list it encodes (the API's view).
    windows: Option<Bytes>,
    window_list: Vec<WindowInfo>,
    /// The current clipboard observation, served on the API without replaying a browser copy event.
    clipboard: Clipboard,
    clipboard_scope: String,
    next_clipboard_write: u64,
    next_id: u64,
}

impl Default for Viewers {
    fn default() -> Self {
        Viewers { sessions: HashMap::new(), controller: None, control_epoch: 0, output: elsewhere_core::INITIAL_OUTPUT, cursor: None, locked: false, windows: None, window_list: Vec::new(), clipboard: Clipboard::default(), clipboard_scope: random_hex(16), next_clipboard_write: 1, next_id: 1 }
    }
}

#[derive(Clone, Default)]
struct Clipboard {
    mime: Option<String>,
    data: Option<Bytes>,
    loading: bool,
    observation: u64,
    operation: Option<u64>,
}

impl Clipboard {
    fn present(&self) -> bool {
        self.mime.is_some() && !(self.mime.as_deref().is_some_and(api::text_mime) && self.data.as_ref().is_some_and(Bytes::is_empty))
    }

    fn metadata(&self, key: &Key, scope: &str) -> serde_json::Value {
        let restricted = self.mime.as_deref() == Some(api::URI_LIST) && !key.has(P::FilesDownload);
        serde_json::json!({
            "observation": format!("{scope}:{}", self.observation), "operation": self.operation.map(|id| format!("{scope}:{id}")),
            "present": self.present(), "mime": self.mime, "size": self.data.as_ref().filter(|_| !restricted).map(Bytes::len),
            "preview": if !self.present() { "empty" } else if restricted { "restricted" } else if self.loading { "loading" }
                else if self.data.is_some() { "available" } else { "unavailable" },
        })
    }
}

pub(crate) struct WindowViewer { window: u64, key: Key, events: mpsc::Sender<Bytes> }

pub(crate) struct ViewerSession {
    key: Key,
    /// State messages (cursor, windows, clipboard, role) and audio, each with a small queue of its own.
    events: mpsc::Sender<Bytes>,
    audio: mpsc::Sender<Bytes>,
    audio_seq: u16,
    /// The viewer's stage in device pixels, from its last Resize.
    size: Option<OutputGeometry>,
    /// Its encoder: codec, size, quality and keyframes.
    control: Box<dyn StreamControl>,
    selection: ws::CodecSelection,
    quality: elsewhere_core::Quality,
    preset: protocol::Preset,
    /// A webcam frame of this session was dropped: the next ones are too, until a keyframe (a VP8 delta
    /// without its reference would corrupt the picture until the next one anyway).
    cam_wait_key: bool,
    mixer_subscribed: bool,
}

/// `audio_rx` carries the clients' Opus packets, for every viewer.
pub async fn run(cfg: Config, commands: calloop::channel::Sender<Command>, audio_rx: mpsc::Receiver<StreamMsg>, events_rx: mpsc::UnboundedReceiver<Event>) -> Result<()> {
    fs::create_dir_all(&cfg.data_dir)?;
    let tokens = tokens::Store::open(cfg.data_dir.join("state.sqlite3")).await?;
    let rtc = match cfg.rtc {
        Some(c) => rtc::Hub::start(c).await.map_err(|e| tracing::warn!("WebRTC disabled: {e:#}")).ok(),
        None => None,
    };
    let mut mixer = cfg.mixer;
    let mixer_errors = mixer.as_mut().and_then(|mixer| mixer.errors.take());
    let app = Arc::new(App {
        tokens,
        auth_serial: tokio::sync::Mutex::new(()),
        active_tokens: Mutex::default(),
        input_owner: Mutex::default(),
        batches: Mutex::default(),
        // No event store: rmcp's session-less Last-Event-ID replay must stay unavailable.
        // Enabling one requires authorization for replay requests without a session ID.
        mcp_sessions: Arc::new(mcp::sessions::Sessions::default()),
        commands,
        codecs: cfg.codecs,
        software: cfg.software,
        bitrate_kbps: cfg.bitrate_kbps,
        fixed_size: cfg.fixed_size,
        viewers: Mutex::new(Viewers { output: cfg.initial, ..Default::default() }),
        sinks: cfg.sinks,
        broadcast_backend: cfg.broadcast,
        broadcasts: Mutex::default(),
        audio_available: cfg.audio_available.into(),
        mixer,
        mic: cfg.mic,
        cam: cfg.cam,
        rtc,
        cam_dead: Default::default(),
        window_viewers: Mutex::default(),
        snapshot_lock: Arc::new(tokio::sync::Semaphore::new(1)),
        notifications: Mutex::default(),
        next_notification: std::sync::atomic::AtomicU32::new(1),
        notify_bus: std::sync::OnceLock::new(),
        files_dir: cfg.files_dir,
        drops_dir: files::drops_dir(),
        elements: cfg.elements,
        version: cfg.version,
        tls: cfg.tls,
        port: cfg.listen.port(),
        url_prefix: cfg.url_prefix.clone(),
        proxy_strips_prefix: cfg.proxy_strips_prefix,
    });
    if let Some(errors) = mixer_errors { tokio::spawn(mixer::errors(app.clone(), errors)); }
    tokio::spawn(ws::distribute_audio(app.clone(), audio_rx));
    tokio::spawn(ws::forward_events(app.clone(), events_rx));
    tokio::spawn(notify::serve(app.clone()));
    tokio::spawn(files::sweep(app.clone()));
    tokio::spawn(broadcast::sweep(Arc::downgrade(&app)));
    tokio::spawn(auth::sweep(Arc::downgrade(&app)));
    tokio::spawn(mcp::sessions::sweep(Arc::downgrade(&app.mcp_sessions)));

    let router = Router::new()
        .route("/", get(index))
        .route("/app.js", get(|| async { asset("text/javascript", include_str!("../../../web/dist/app.js")) }))
        .route("/app.css", get(|| async { asset("text/css", include_str!("../../../web/dist/app.css")) }))
        .route("/assets/{*path}", get(web_asset))
        .route("/ws", get(websocket))
        .route("/ws/window/{id}", get(window_websocket))
        .route("/ws/terminal", get(terminal::upgrade))
        .merge(
            Router::new()
                .route("/api/windows", get(api_windows))
                .route("/api/codecs", get(api_codecs))
                .route("/api/applications", get(api_applications))
                .route("/api/applications/{id}/icon", get(api_application_icon))
                .route("/api/control", post(api_control))
                .route("/api/broadcasts", get(broadcast::list))
                .route("/api/broadcasts/capabilities", get(broadcast::capabilities))
                .route("/api/broadcasts/start", post(broadcast::start))
                .route("/api/broadcasts/{id}", get(broadcast::get))
                .route("/api/broadcasts/{id}/stop", post(broadcast::stop))
                .route("/api/input", post(api_input))
                .route("/api/windows/{id}/snapshot.png", get(api_window_snapshot))
                .route("/api/screenshot.png", get(api_screenshot))
                .route("/api/windows/{id}/elements", get(api_window_elements))
                .route("/api/windows/{id}/icon", get(api_window_icon))
                .route("/api/files", get(api_files).post(api_manage_file))
                .route("/api/files/{name}", get(api_file).put(api_put_file).delete(api_delete_file))
                .route("/api/drop/{batch}/{name}", put(api_stage_file))
                .route("/api/notifications", get(api_notifications))
                .route("/api/notifications/{id}", post(api_notification_action))
                .route("/api/notifications/{id}/icon", get(api_notification_icon))
                .route("/api/tokens", get(auth::list).post(auth::create))
                .route("/api/tokens/{id}", axum::routing::delete(auth::revoke))
                .route("/api/me", get(auth::me))
                .route("/api/clipboard", get(api_clipboard).put(api_set_clipboard))
                .route("/api/clipboard/state", get(api_clipboard_state))
                .route("/api/clipboard/files", post(api_clipboard_files))
                .route("/api/clipboard/files/{index}", get(api_clipboard_file))
                .nest("/mcp", Router::new().fallback_service(mcp_service(app.clone())).layer(middleware::from_fn_with_state(app.mcp_sessions.clone(), mcp::sessions::bind)))
                .layer(middleware::from_fn_with_state(app.clone(), bearer)),
        )
        .route("/skill/SKILL.md", get(|| async { markdown(mcp::SKILL) }))
        .route("/skill/reference.md", get(|| async { markdown(mcp::REFERENCE) }))
        .with_state(app.clone());

    let router = if cfg.url_prefix.is_empty() || cfg.proxy_strips_prefix {
        router
    } else {
        // Keep the router intact, including the nested MCP fallback service.
        Router::new().nest_service(&cfg.url_prefix, router)
    };

    let tls_pem = if cfg.tls { Some(load_or_create_cert(&cfg.data_dir)?) } else { None };
    if let Some((cert, _)) = &tls_pem {
        // Compare this with the browser's certificate viewer before accepting the warning.
        println!("certificate SHA-256: {}", fingerprint(cert)?);
    }
    app.print_access();

    if let Some((cert, key)) = tls_pem {
        let tls = axum_server::tls_rustls::RustlsConfig::from_pem(cert, key).await?;
        // WebSocket upgrades need HTTP/1.1; keep browsers off h2.
        let mut sc = (*tls.get_inner()).clone();
        sc.alpn_protocols = vec![b"http/1.1".to_vec()];
        let tls = axum_server::tls_rustls::RustlsConfig::from_config(Arc::new(sc));
        axum_server::bind_rustls(cfg.listen, tls).serve(router.into_make_service()).await?;
    } else {
        axum_server::bind(cfg.listen).serve(router.into_make_service()).await?;
    }
    Ok(())
}

/// The page is public; it authenticates its WebSocket with the token from its URL fragment (or sessionStorage).
/// The viewer is built from `web/` into `web/dist` (`npm run build`), and embedded here.
async fn index(State(app): State<Arc<App>>, OriginalUri(uri): OriginalUri) -> Response {
    if !app.url_prefix.is_empty() && uri.path() == app.url_prefix {
        let query = uri.query().map(|q| format!("?{q}")).unwrap_or_default();
        return Redirect::permanent(&format!("{}/{query}", app.url_prefix)).into_response();
    }
    Html(include_str!("../../../web/dist/index.html").replace("<base href=\"/\">", &format!("<base href=\"{}/\">", app.url_prefix))).into_response()
}

const WEB_ASSETS: &[(&str, &str, &[u8])] = include!(concat!(env!("OUT_DIR"), "/web_assets.rs"));

async fn web_asset(axum::extract::Path(path): axum::extract::Path<String>) -> Response {
    let name = format!("assets/{path}");
    match WEB_ASSETS.iter().find(|(key, _, _)| *key == name) {
        Some((_, mime, src)) => ([(header::CONTENT_TYPE, *mime), (header::CACHE_CONTROL, "no-cache")], *src).into_response(),
        None => axum::http::StatusCode::NOT_FOUND.into_response(),
    }
}

#[cfg(test)]
mod web_asset_tests {
    use super::*;

    #[tokio::test]
    async fn emitted_assets_are_served_and_unknown_paths_are_not() {
        for (name, mime, bytes) in WEB_ASSETS.iter().filter(|(name, _, _)| name.starts_with("assets/")) {
            let response = web_asset(axum::extract::Path(name[7..].to_owned())).await;
            assert_eq!(response.status(), axum::http::StatusCode::OK);
            assert_eq!(response.headers()[header::CONTENT_TYPE], *mime);
            let body = axum::body::to_bytes(response.into_body(), usize::MAX).await.unwrap();
            assert_eq!(body.as_ref(), *bytes);
        }
        for name in ["missing.js", "../app.js"] {
            assert_eq!(web_asset(axum::extract::Path(name.into())).await.status(), axum::http::StatusCode::NOT_FOUND);
        }
    }
}

/// Revalidated on every load, so an upgraded server never runs a stale page.
fn asset(mime: &'static str, src: &'static str) -> Response {
    ([(header::CONTENT_TYPE, mime), (header::CACHE_CONTROL, "no-cache")], src).into_response()
}

fn markdown(src: &'static str) -> Response {
    ([(header::CONTENT_TYPE, "text/markdown; charset=utf-8")], src).into_response()
}

/// MCP over Streamable HTTP; the bearer middleware in front of it replaces rmcp's host allow-list.
fn mcp_service(app: Arc<App>) -> StreamableHttpService<mcp::Mcp, LocalSessionManager> {
    let sessions = app.mcp_sessions.manager.clone();
    StreamableHttpService::new(move || Ok(mcp::Mcp::new(app.clone())), sessions, StreamableHttpServerConfig::default().disable_allowed_hosts())
}

/// Unauthenticated until the first message (see `ws::session`).
async fn websocket(ws: WebSocketUpgrade, State(app): State<Arc<App>>) -> Response {
    ws.max_message_size(1 + (1 << 20)).on_upgrade(move |socket| ws::session(socket, app)) // a pasted clipboard can be 1 MiB
}

/// One window as its own stream (see `ws::window_session`).
async fn window_websocket(ws: WebSocketUpgrade, UrlPath(id): UrlPath<u64>, State(app): State<Arc<App>>) -> Response {
    ws.max_message_size(1 + (1 << 20)).on_upgrade(move |socket| ws::window_session(socket, app, id))
}

/// Bearer authentication creates one live token context for the request and its response body.
async fn bearer(State(app): State<Arc<App>>, mut req: Request, next: Next) -> Response {
    let key = match app.key_of(req.headers()).await {
        Ok(Some(key)) => key,
        Ok(None) => return ApiError::Unauthorized.into_response(),
        Err(error) => return error.into_response(),
    };
    req.extensions_mut().insert(key.clone());
    let self_revoke = req.method() == axum::http::Method::DELETE
        && req.uri().path().ends_with(&format!("/api/tokens/{}", key.metadata.id));
    let response = if self_revoke { next.run(req).await } else { tokio::select! {
        biased;
        response = next.run(req) => response,
        _ = key.ended() => return ApiError::Unauthorized.into_response(),
    } };
    let (parts, body) = response.into_parts();
    use futures_util::StreamExt;
    let stream = futures_util::stream::unfold((body.into_data_stream(), key), |(mut body, key)| async move {
        let item = tokio::select! { biased; _ = key.ended() => None, item = body.next() => item };
        item.map(|item| (item, (body, key)))
    });
    Response::from_parts(parts, axum::body::Body::from_stream(stream))
}

const NO_STORE: [(header::HeaderName, &str); 1] = [(header::CACHE_CONTROL, "no-store")];

/// The codecs this server encodes, and whether on the GPU.
async fn api_codecs(Extension(key): Extension<Key>, State(app): State<Arc<App>>) -> Response {
    if let Err(e) = key.require(P::DesktopView) { return e.into_response(); }
    let list: Vec<serde_json::Value> = app.codecs.iter().map(|&c| serde_json::json!({ "codec": protocol::codec_name(c), "hardware": !app.software })).collect();
    (NO_STORE, Json(list)).into_response()
}

async fn api_windows(Extension(key): Extension<Key>, State(app): State<Arc<App>>) -> Response {
    if let Err(e) = key.require(P::DesktopView) { return e.into_response(); }
    (NO_STORE, Json(app.windows())).into_response()
}

fn png(result: Result<Vec<u8>, ApiError>) -> Response {
    match result {
        Ok(bytes) => ([(header::CONTENT_TYPE, "image/png"), (header::CACHE_CONTROL, "no-store")], bytes).into_response(),
        Err(e) => e.into_response(),
    }
}

async fn api_window_snapshot(Extension(key): Extension<Key>, UrlPath(id): UrlPath<u64>, Query(sizing): Query<elsewhere_core::SnapshotSizing>, State(app): State<Arc<App>>) -> Response {
    if let Err(e) = key.require(P::DesktopView) { return e.into_response(); }
    png(app.snapshot(Some(id), sizing).await)
}

async fn api_screenshot(Extension(key): Extension<Key>, Query(sizing): Query<elsewhere_core::SnapshotSizing>, State(app): State<Arc<App>>) -> Response {
    if let Err(e) = key.require(P::DesktopView) { return e.into_response(); }
    png(app.snapshot(None, sizing).await)
}

async fn api_applications(Extension(key): Extension<Key>, State(app): State<Arc<App>>) -> Response {
    if let Err(e) = key.require(P::DesktopView) { return e.into_response(); }
    (NO_STORE, Json(app.applications().await)).into_response()
}

async fn api_application_icon(Extension(key): Extension<Key>, UrlPath(id): UrlPath<String>, State(app): State<Arc<App>>) -> Response {
    if let Err(e) = key.require(P::DesktopView) { return e.into_response(); }
    match app.application_icon(id).await {
        Ok((bytes, mime)) => ([(header::CONTENT_TYPE, mime), (header::CACHE_CONTROL, "private, max-age=86400")], bytes).into_response(),
        Err(e) => e.into_response(),
    }
}

async fn api_window_icon(Extension(key): Extension<Key>, UrlPath(id): UrlPath<u64>, State(app): State<Arc<App>>) -> Response {
    if let Err(e) = key.require(P::DesktopView) { return e.into_response(); }
    match app.window_icon(id).await {
        Ok((bytes, mime)) => ([(header::CONTENT_TYPE, mime), (header::CACHE_CONTROL, "private, max-age=300")], bytes).into_response(),
        Err(e) => e.into_response(),
    }
}

async fn api_files(Extension(key): Extension<Key>, State(app): State<Arc<App>>, Query(query): Query<files::FileQuery>) -> Response {
    if let Err(e) = key.require(P::FilesBrowse) { return e.into_response(); }
    match app.browse_files(query).await { Ok(list) => (NO_STORE, Json(list)).into_response(), Err(e) => e.into_response() }
}

async fn api_manage_file(Extension(key): Extension<Key>, State(app): State<Arc<App>>, Json(action): Json<files::FileAction>) -> Response {
    if let Err(e) = key.require(P::FilesManage) { return e.into_response(); }
    match app.manage_file(&key, action).await { Ok(saved) => (StatusCode::CREATED, NO_STORE, Json(saved)).into_response(), Err(e) => e.into_response() }
}

async fn api_put_file(Extension(key): Extension<Key>, UrlPath(name): UrlPath<String>, State(app): State<Arc<App>>, Query(query): Query<files::FileQuery>, req: Request) -> Response {
    if let Err(e) = key.require(P::FilesUpload) { return e.into_response(); }
    match app.upload_file(&key, &query.path, &name, req.into_body()).await {
        Ok(saved) => (StatusCode::CREATED, NO_STORE, Json(saved)).into_response(), Err(e) => e.into_response()
    }
}

/// A file of a drag or a paste, staged in its batch for the application that will take it.
async fn api_stage_file(Extension(key): Extension<Key>, UrlPath((batch, name)): UrlPath<(String, String)>, State(app): State<Arc<App>>, req: Request) -> Response {
    if let Err(e) = key.require(P::FilesUpload) {
        return e.into_response();
    }
    if !key.has(P::DragdropUpload) && !key.has(P::ClipboardWrite) { return ApiError::Forbidden.into_response(); }
    stored(app.stage_file(&key, &batch, &name, req.into_body()).await)
}

fn stored(result: Result<String, api::ApiError>) -> Response {
    match result {
        Ok(name) => (StatusCode::CREATED, NO_STORE, Json(serde_json::json!({ "name": name }))).into_response(),
        Err(e) => e.into_response(),
    }
}

/// A file for the browser to save under `name`, streamed.
fn attachment(name: &str, len: Option<u64>, body: axum::body::Body) -> Response {
    let mut response = (
        NO_STORE,
        [
            (header::CONTENT_TYPE, "application/octet-stream".to_string()),
            (header::CONTENT_DISPOSITION, format!("attachment; filename=\"{}\"; filename*=UTF-8''{}", name.chars().map(|c| if c.is_ascii_graphic() && c != '"' && c != '\\' || c == ' ' { c } else { '_' }).collect::<String>(), files::percent(name))),
        ],
        body,
    )
        .into_response();
    if let Some(len) = len { response.headers_mut().insert(header::CONTENT_LENGTH, len.into()); }
    response
}

async fn api_file(Extension(key): Extension<Key>, UrlPath(name): UrlPath<String>, State(app): State<Arc<App>>, Query(query): Query<files::FileQuery>) -> Response {
    if let Err(e) = key.require(P::FilesDownload) { return e.into_response(); }
    match app.download_file(&query.path, &name).await {
        Ok((len, body)) => attachment(&name, len, body),
        Err(e) => e.into_response(),
    }
}

async fn api_delete_file(Extension(key): Extension<Key>, UrlPath(name): UrlPath<String>, State(app): State<Arc<App>>, Query(query): Query<files::FileQuery>) -> Response {
    match key.require(P::FilesManage) {
        Ok(()) => match app.remove_file(&key, &query.path, &name).await {
            Ok(()) => StatusCode::NO_CONTENT.into_response(),
            Err(e) => e.into_response(),
        },
        Err(e) => e.into_response(),
    }
}

async fn api_notifications(Extension(key): Extension<Key>, State(app): State<Arc<App>>) -> Response {
    if let Err(e) = key.require(P::DesktopView) { return e.into_response(); }
    (NO_STORE, Json(app.notifications())).into_response()
}

/// `{"action": "default" | "<key>"}`, or `{}` to dismiss; `202`, `404` unknown id.
async fn api_notification_action(Extension(key): Extension<Key>, UrlPath(id): UrlPath<u32>, State(app): State<Arc<App>>, Json(msg): Json<serde_json::Value>) -> Response {
    match key.require(P::DesktopControl) {
        Ok(()) => match app.notification_action(id, msg.get("action").and_then(|a| a.as_str())).await {
            Ok(()) => StatusCode::ACCEPTED.into_response(),
            Err(e) => e.into_response(),
        },
        Err(e) => e.into_response(),
    }
}

async fn api_notification_icon(Extension(key): Extension<Key>, UrlPath(id): UrlPath<u32>, State(app): State<Arc<App>>) -> Response {
    if let Err(e) = key.require(P::DesktopView) { return e.into_response(); }
    match app.notification_icon(id).await {
        Ok((bytes, mime)) => (NO_STORE, [(header::CONTENT_TYPE, mime)], bytes).into_response(),
        Err(e) => e.into_response(),
    }
}

async fn api_window_elements(Extension(key): Extension<Key>, UrlPath(id): UrlPath<u64>, State(app): State<Arc<App>>) -> Response {
    if let Err(e) = key.require(P::DesktopView) { return e.into_response(); }
    match app.elements(id).await {
        Ok(page) => (NO_STORE, Json(page)).into_response(),
        Err(e) => e.into_response(),
    }
}

async fn api_control(Extension(key): Extension<Key>, State(app): State<Arc<App>>, Json(msg): Json<ControlMsg>) -> Response {
    match key.with(&[auth::control_permission(&msg)], || app.control(msg)) {
        Ok(()) => StatusCode::ACCEPTED.into_response(),
        Err(e) => e.into_response(),
    }
}

async fn api_clipboard_state(Extension(key): Extension<Key>, State(app): State<Arc<App>>) -> Response {
    if let Err(e) = key.require(P::ClipboardRead) { return e.into_response(); }
    let viewers = app.viewers.lock().unwrap();
    (NO_STORE, Json(viewers.clipboard.metadata(&key, &viewers.clipboard_scope))).into_response()
}

/// Current clipboard bytes. If-Match binds a preview read to its metadata observation.
async fn api_clipboard(Extension(key): Extension<Key>, State(app): State<Arc<App>>, headers: HeaderMap) -> Response {
    if let Err(e) = key.require(P::ClipboardRead) { return e.into_response(); }
    let (clipboard, scope) = { let viewers = app.viewers.lock().unwrap(); (viewers.clipboard.clone(), viewers.clipboard_scope.clone()) };
    let etag = format!("\"{scope}:{}\"", clipboard.observation);
    if headers.get(header::IF_MATCH).is_some_and(|value| value != etag.as_str()) {
        return (StatusCode::PRECONDITION_FAILED, NO_STORE).into_response();
    }
    match (clipboard.mime, clipboard.data) {
        (Some(mime), _) if mime == api::URI_LIST && !key.has(P::FilesDownload) => ApiError::Forbidden.into_response(),
        (Some(mime), Some(data)) => (NO_STORE, [(header::CONTENT_TYPE, match mime.as_str() { api::PNG | api::URI_LIST => mime, _ => "text/plain; charset=utf-8".into() }), (header::ETAG, etag)], data).into_response(),
        (None, _) => (StatusCode::NO_CONTENT, NO_STORE).into_response(),
        _ => (StatusCode::CONFLICT, NO_STORE).into_response(),
    }
}

/// The body becomes the desktop clipboard: a PNG with `Content-Type: image/png` (up to 16 MiB), a file list
/// with `text/uri-list`, else UTF-8 text (up to 1 MiB).
/// The body is read only with clipboard write permission, up to its mime limit.
async fn api_set_clipboard(Extension(key): Extension<Key>, State(app): State<Arc<App>>, req: Request) -> Response {
    if let Err(e) = key.require(P::ClipboardWrite) {
        return e.into_response();
    }
    let content_type = req.headers().get(header::CONTENT_TYPE).and_then(|v| v.to_str().ok()).unwrap_or_default();
    let mime = if content_type.starts_with(api::PNG) { api::PNG } else if content_type.starts_with(api::URI_LIST) { api::URI_LIST } else { api::TEXT };
    if mime == api::URI_LIST && !key.has(P::FilesUpload) { return ApiError::Forbidden.into_response(); }
    let Ok(body) = axum::body::to_bytes(req.into_body(), api::clipboard_limit(mime)).await else { return ApiError::TooLarge.into_response() };
    let body = if mime == api::PNG { body } else { Bytes::from(String::from_utf8_lossy(&body).into_owned()) };
    match key.with(&[P::ClipboardWrite], || { if mime == api::URI_LIST { app.validate_clipboard_uris(&key, &body)?; } app.queue_clipboard(mime, body) }) {
        Ok(operation) => {
            let scope = &app.viewers.lock().unwrap().clipboard_scope;
            (StatusCode::ACCEPTED, NO_STORE, Json(serde_json::json!({ "operation": format!("{scope}:{operation}") }))).into_response()
        }
        Err(e) => e.into_response(),
    }
}

/// `{"names": [...]}`, with `"batch"` for a staged batch: those files become the desktop clipboard as a URI
/// list, as a file manager's copy would; `202`.
async fn api_clipboard_files(Extension(key): Extension<Key>, State(app): State<Arc<App>>, Json(msg): Json<serde_json::Value>) -> Response {
    let names: Vec<String> = msg.get("names").and_then(|n| n.as_array()).map(|a| a.iter().filter_map(|v| v.as_str().map(str::to_string)).collect()).unwrap_or_default();
    let batch = msg.get("batch").and_then(|v| v.as_str());
    match key.with(&[P::ClipboardWrite, P::FilesUpload], || app.set_clipboard_files(&key, &names, batch)) {
        Ok(()) => StatusCode::ACCEPTED.into_response(),
        Err(e) => e.into_response(),
    }
}

/// The `index`th file of the URI list on the desktop clipboard, as an attachment; `404` if the clipboard
/// holds no such list or entry.
async fn api_clipboard_file(Extension(key): Extension<Key>, UrlPath(index): UrlPath<usize>, State(app): State<Arc<App>>) -> Response {
    if let Err(e) = key.require(P::FilesDownload) { return e.into_response(); }
    if let Err(e) = key.require(P::ClipboardRead) { return e.into_response(); }
    match app.clipboard_file(index).await {
        Ok((name, len, body)) => attachment(&name, len, body),
        Err(e) => e.into_response(),
    }
}

async fn api_input(Extension(key): Extension<Key>, State(app): State<Arc<App>>, Json(msg): Json<InputMsg>) -> Response {
    let warning = match &msg {
        InputMsg::Click { window: Some(id), x, y, .. } => app.x11_edge_warning(*id, *x, *y),
        _ => None,
    };
    match key.with(&[P::DesktopControl], || app.authorized_input(&key, msg)) {
        Ok(()) => match warning {
            Some(w) => (StatusCode::ACCEPTED, NO_STORE, Json(serde_json::json!({ "warning": w }))).into_response(),
            None => StatusCode::ACCEPTED.into_response(),
        },
        Err(e) => e.into_response(),
    }
}

fn write_private(path: &Path, data: &[u8]) -> io::Result<()> {
    use io::Write;
    fs::OpenOptions::new().write(true).create_new(true).mode(0o600).open(path)?.write_all(data)
}

fn random_hex(n: usize) -> String {
    use io::Read;
    let mut buf = vec![0u8; n];
    fs::File::open("/dev/urandom").and_then(|mut f| f.read_exact(&mut buf)).expect("/dev/urandom");
    buf.iter().map(|b| format!("{b:02x}")).collect()
}

fn lan_ips() -> Vec<std::net::IpAddr> {
    if_addrs::get_if_addrs()
        .unwrap_or_default()
        .into_iter()
        .filter(|i| !i.is_loopback() && i.ip().is_ipv4())
        .map(|i| i.ip())
        .collect()
}

/// Self-signed cert with every local address as a SAN. Delete the files to regenerate.
fn load_or_create_cert(dir: &Path) -> Result<(Vec<u8>, Vec<u8>)> {
    let (cert_path, key_path) = (dir.join("cert.pem"), dir.join("key.pem"));
    if let (Ok(c), Ok(k)) = (fs::read(&cert_path), fs::read(&key_path)) {
        return Ok((c, k));
    }
    let _ = fs::remove_file(&key_path); // never leave a mismatched pair behind
    let mut sans = vec!["localhost".to_string()];
    sans.extend(if_addrs::get_if_addrs()?.iter().filter(|i| !i.is_loopback()).map(|i| i.ip().to_string()));
    let mut params = rcgen::CertificateParams::new(sans)?;
    params.distinguished_name.push(rcgen::DnType::CommonName, "elsewhere");
    let key = rcgen::KeyPair::generate()?;
    let cert = params.self_signed(&key)?;
    fs::write(&cert_path, cert.pem())?;
    write_private(&key_path, key.serialize_pem().as_bytes())?;
    Ok((cert.pem().into_bytes(), key.serialize_pem().into_bytes()))
}

/// Colon-separated SHA-256 of the certificate DER, as browsers display it.
fn fingerprint(cert_pem: &[u8]) -> Result<String> {
    use rustls::pki_types::{CertificateDer, pem::PemObject};
    use sha2::Digest;
    let der = CertificateDer::from_pem_slice(cert_pem)?;
    Ok(sha2::Sha256::digest(&der).iter().map(|b| format!("{b:02X}")).collect::<Vec<_>>().join(":"))
}
