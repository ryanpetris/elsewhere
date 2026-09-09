//! A live token owns requests and connections; cancellation ends its authority and streams.
use std::sync::{Arc, RwLock};
use axum::{Extension, Json, extract::{Path, State}, http::{HeaderMap, StatusCode, header}, response::{IntoResponse, Response}};
use tokio_util::sync::CancellationToken;
use crate::{App, Key, api::ApiError, tokens::{self, Permission as P}};

pub struct Access {
    pub metadata: tokens::Token,
    cancelled: CancellationToken,
    gate: RwLock<()>,
}
impl Access {
    pub(crate) fn new(metadata: tokens::Token) -> Self { Self { metadata, cancelled: CancellationToken::new(), gate: RwLock::new(()) } }
    pub fn live(&self) -> bool { !self.cancelled.is_cancelled() && self.metadata.live() }
    pub fn admit(&self) -> Result<std::sync::RwLockReadGuard<'_, ()>, ApiError> {
        let guard = self.gate.read().unwrap();
        if !self.live() { return Err(ApiError::Unauthorized); }
        Ok(guard)
    }
    pub fn has(&self, permission: P) -> bool { self.live() && self.metadata.permissions.contains(&permission) }
    pub fn require(&self, permission: P) -> Result<(), ApiError> {
        if !self.live() { Err(ApiError::Unauthorized) } else if self.has(permission) { Ok(()) } else { Err(ApiError::Forbidden) }
    }
    /// Admit a synchronous side effect while revocation waits for that admission to finish.
    pub fn with<T>(&self, permissions: &[P], action: impl FnOnce() -> Result<T, ApiError>) -> Result<T, ApiError> {
        let _guard = self.gate.read().unwrap();
        if !self.live() { return Err(ApiError::Unauthorized); }
        for &permission in permissions { self.require(permission)?; }
        action()
    }
    fn cancel(&self) { let _guard = self.gate.write().unwrap(); self.cancelled.cancel(); }
    pub async fn ended(&self) {
        let expiry = async {
            match self.metadata.expires_at_ms {
                Some(expiry) => loop {
                    let remaining = expiry.saturating_sub(tokens::now_ms());
                    if remaining <= 0 { break; }
                    tokio::time::sleep(std::time::Duration::from_millis(remaining.min(1000) as u64)).await;
                },
                None => std::future::pending::<()>().await,
            }
        };
        tokio::select! { _ = self.cancelled.cancelled() => {}, _ = expiry => {} }
    }
    pub fn event_allowed(&self, packet: &[u8]) -> bool {
        use crate::protocol::*;
        match packet.first().copied() {
            Some(CLIPBOARD | CLIPBOARD_DATA) => self.has(P::ClipboardRead)
                && (packet.get(1..) != Some(crate::api::URI_LIST.as_bytes()) || self.has(P::FilesDownload)),
            Some(AUDIO | MIXER_STATE | MIXER_LEVELS) => self.has(P::AudioListen),
            _ => self.has(P::DesktopView),
        }
    }
}

impl App {
    pub(crate) fn send_input(&self, key: &Key, session: u64, command: elsewhere_core::Command) -> Result<(), ApiError> {
        // Ownership and command order share one lock across HTTP, MCP and both WebSocket routes.
        let mut owner = self.input_owner.lock().unwrap();
        let next = (key.metadata.id, session);
        if owner.is_some_and(|old| old != next) { self.send(elsewhere_core::Command::ReleaseAllInput)?; }
        self.send(command)?;
        *owner = Some(next);
        Ok(())
    }
    pub(crate) fn release_input(&self, key: &Key, session: u64) {
        let mut owner = self.input_owner.lock().unwrap();
        if *owner == Some((key.metadata.id, session)) {
            *owner = None;
            let _ = self.commands.send(elsewhere_core::Command::ReleaseAllInput);
        }
    }
    async fn cancel_token(&self, id: uuid::Uuid) {
        use elsewhere_core::Command;
        let mut rtc_keys = Vec::new();
        {
            let mut viewers = self.viewers.lock().unwrap();
            let removed: Vec<_> = viewers.sessions.iter().filter_map(|(&session, s)| (s.key.metadata.id == id).then_some(session)).collect();
            let controlled = viewers.controller.is_some_and(|s| removed.contains(&s));
            for session in removed {
                viewers.sessions.remove(&session);
                let _ = self.commands.send(Command::ViewerStream { key: session, sink: None });
                rtc_keys.push(session);
            }
            if controlled {
                let next = viewers.sessions.iter().filter(|(_, s)| s.key.has(P::DesktopControl)).map(|(&id, _)| id).min();
                self.set_controller(&mut viewers, next);
                let _ = self.commands.send(Command::Drag(elsewhere_core::Drag::Cancel));
            }
            self.mixer_audience(&viewers);
        }
        {
            let mut windows = self.window_viewers.lock().unwrap();
            windows.retain(|&session, s| { if s.key.metadata.id == id { let _ = self.commands.send(Command::WindowStream { key: session, window: s.window, sink: None }); rtc_keys.push(session | (1 << 63)); false } else { true } });
        }
        {
            let mut owner = self.input_owner.lock().unwrap();
            if owner.is_some_and(|(token, _)| token == id) { *owner = None; let _ = self.commands.send(Command::ReleaseAllInput); }
        }
        self.stop_token_broadcasts(id);
        self.batches.lock().unwrap().retain(|_, key| key.metadata.id != id);
        let sessions: Vec<_> = {
            let mut owners = self.mcp_owners.lock().unwrap();
            let sessions = owners.iter().filter(|(_, key)| key.metadata.id == id).map(|(session, _)| session.clone()).collect::<Vec<_>>();
            owners.retain(|_, key| key.metadata.id != id);
            sessions
        };
        use rmcp::transport::streamable_http_server::session::SessionManager;
        for session in sessions { let _ = self.mcp_sessions.close_session(&session.into()).await; }
        if let Some(hub) = &self.rtc { for session in rtc_keys { hub.close(session).await; } }
    }
    pub(crate) async fn key_for(&self, secret: &str) -> Result<Option<Key>, ApiError> {
        let _serial = self.auth_serial.lock().await;
        let Some(metadata) = self.tokens.authenticate(secret).await.map_err(internal)? else { return Ok(None); };
        let mut active = self.active_tokens.lock().unwrap();
        active.retain(|_, key| key.strong_count() > 0);
        let key = match active.get(&metadata.id).and_then(std::sync::Weak::upgrade) {
            Some(key) if key.live() => key,
            _ => {
                let key = Arc::new(Access::new(metadata));
                active.insert(key.metadata.id, Arc::downgrade(&key));
                key
            }
        };
        Ok(Some(key))
    }
    pub(crate) async fn key_of(&self, headers: &HeaderMap) -> Result<Option<Key>, ApiError> {
        let Some(secret) = headers.get(header::AUTHORIZATION).and_then(|h| h.to_str().ok()).and_then(|h| h.strip_prefix("Bearer ")) else { return Ok(None); };
        self.key_for(secret).await
    }
    pub(crate) fn print_access(&self) {
        let scheme = if self.tls { "https" } else { "http" };
        if self.proxy_strips_prefix && !self.url_prefix.is_empty() { println!("Open {}/ through the reverse proxy.", self.url_prefix); }
        else { for ip in crate::lan_ips() { println!("{scheme}://{ip}:{}{}/", self.port, self.url_prefix); } }
        println!("Run `elsewhere token create --admin` in the server's execution environment with the same configuration to generate a token, then paste it into the connection dialog.");
    }
}
pub(crate) fn control_permission(msg: &elsewhere_core::ControlMsg) -> P {
    use elsewhere_core::ControlOp;
    match &msg.op { ControlOp::Launch { .. } => P::AppsLaunch, ControlOp::Spawn { .. } => P::CommandsExecute, ControlOp::Quit => P::ServerManage, _ => P::DesktopControl }
}
fn internal(error: anyhow::Error) -> ApiError {
    tracing::error!(error = %error, "token database operation failed");
    ApiError::Internal("token database unavailable".into())
}
pub async fn create(Extension(key): Extension<Key>, State(app): State<Arc<App>>, Json(mut request): Json<tokens::Create>) -> Result<Response, ApiError> {
    key.require(P::TokensManage)?;
    request.validate().map_err(|e| ApiError::InvalidInput(e.to_string()))?;
    let _serial = app.auth_serial.lock().await;
    key.require(P::TokensManage)?;
    let created = app.tokens.create(request).await.map_err(|e| if e.is::<tokens::InvalidCreate>() { ApiError::InvalidInput(e.to_string()) } else { internal(e) })?;
    Ok((StatusCode::CREATED, crate::NO_STORE, Json(created)).into_response())
}
pub async fn list(Extension(key): Extension<Key>, State(app): State<Arc<App>>) -> Result<Response, ApiError> {
    key.require(P::TokensManage)?;
    Ok((crate::NO_STORE, Json(serde_json::json!({"tokens": app.tokens.list().await.map_err(internal)?}))).into_response())
}
pub async fn revoke(Extension(key): Extension<Key>, State(app): State<Arc<App>>, Path(id): Path<String>) -> Result<StatusCode, ApiError> {
    key.require(P::TokensManage)?;
    let id = tokens::parse_id(&id).map_err(|e| ApiError::InvalidInput(e.to_string()))?;
    // Once admitted, a revoke must finish committed invalidation even if its caller disconnects.
    tokio::spawn(async move {
        let _serial = app.auth_serial.lock().await;
        key.require(P::TokensManage)?;
        if !app.tokens.revoke(id).await.map_err(internal)? { return Ok(StatusCode::NOT_FOUND); }
        if let Some(access) = app.active_tokens.lock().unwrap().remove(&id).and_then(|k| k.upgrade()) { access.cancel(); }
        drop(_serial);
        app.cancel_token(id).await;
        Ok(StatusCode::NO_CONTENT)
    }).await.map_err(|e| internal(e.into()))?

}
pub async fn me(Extension(key): Extension<Key>, State(app): State<Arc<App>>) -> Response {
    (crate::NO_STORE, Json(serde_json::json!({"metadata": key.metadata, "permissions": key.metadata.permissions, "available_permissions": P::ALL,
        "features": {"audio": app.audio_available.load(std::sync::atomic::Ordering::Relaxed), "microphone": app.mic.is_some(), "camera": app.cam.is_some(), "rtc": app.rtc.is_some(), "elements": app.elements}}))).into_response()
}
pub async fn sweep(app: std::sync::Weak<App>) {
    let mut interval = tokio::time::interval(std::time::Duration::from_millis(100));
    loop {
        interval.tick().await;
        let Some(app) = app.upgrade() else { return; };
        let expired: Vec<_> = app.active_tokens.lock().unwrap().values().filter_map(std::sync::Weak::upgrade).filter(|k| !k.metadata.live()).collect();
        for key in expired { key.cancel(); app.active_tokens.lock().unwrap().remove(&key.metadata.id); app.cancel_token(key.metadata.id).await; }
    }
}
