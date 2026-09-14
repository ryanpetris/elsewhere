//! A live token owns requests and connections; cancellation ends its authority and streams.
use std::sync::{Arc, RwLock};
use axum::{Extension, Json, extract::{Path, State}, http::{HeaderMap, StatusCode, header}, response::{IntoResponse, Response}};
use tokio_util::sync::CancellationToken;
use crate::{App, Key, api::ApiError, tokens::{self, Permission as P}};

pub struct Access {
    pub metadata: tokens::Token,
    cancelled: CancellationToken,
    gate: RwLock<()>,
    dispatch: tokio::sync::RwLock<()>,
    cleanup: tokio::sync::OnceCell<()>,
}
impl Access {
    pub(crate) fn new(metadata: tokens::Token) -> Self { Self { metadata, cancelled: CancellationToken::new(), gate: RwLock::new(()), dispatch: tokio::sync::RwLock::new(()), cleanup: tokio::sync::OnceCell::new() } }
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
    pub(crate) async fn admit_dispatch(&self) -> Result<tokio::sync::RwLockReadGuard<'_, ()>, ApiError> {
        let guard = self.dispatch.read().await;
        self.require(P::DesktopControl)?;
        Ok(guard)
    }
    fn cancel(&self) {
        {
            let _guard = self.gate.write().unwrap();
            self.cancelled.cancel();
        }
    }
    async fn drained(&self) { let _dispatch = self.dispatch.write().await; }
    async fn finish(&self, app: &App) {
        self.cleanup.get_or_init(|| async {
            self.drained().await;
            app.cancel_token(self.metadata.id).await;
        }).await;
    }
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
            Some(CLIPBOARD) => self.has(P::ClipboardRead),
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
            let controlled = viewers.active_session().is_some_and(|s| removed.contains(&s));
            self.remove_viewers(&mut viewers, &removed);
            for session in removed {
                let _ = self.commands.send(Command::ViewerStream { key: session, sink: None });
                rtc_keys.push(session);
            }
            if controlled {
                let _ = self.commands.send(Command::Drag(elsewhere_core::Drag::Cancel));
            }
            self.mixer_audience(&viewers);
            viewers.publish_roster();
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
        self.mcp_sessions.revoke(id).await;
        if let Some(hub) = &self.rtc { for session in rtc_keys { hub.close(session).await; } }
    }
    pub(crate) async fn key_for(&self, secret: &str) -> Result<Option<Key>, ApiError> {
        let _serial = self.auth_serial.lock().await;
        let Some(metadata) = self.tokens.authenticate(secret).await.map_err(internal)? else { return Ok(None); };
        Ok(Some(self.access_for(metadata)))
    }
    fn access_for(&self, metadata: tokens::Token) -> Key {
        let mut active = self.active_tokens.lock().unwrap();
        active.retain(|_, key| key.strong_count() > 0);
        // Keep the dispatch barrier when authentication completes across token expiry.
        match active.get(&metadata.id).and_then(std::sync::Weak::upgrade) {
            Some(key) => key,
            _ => {
                let key = Arc::new(Access::new(metadata));
                active.insert(key.metadata.id, Arc::downgrade(&key));
                key
            }
        }
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
        let access = app.active_tokens.lock().unwrap().remove(&id).and_then(|k| k.upgrade());
        if let Some(access) = &access { access.cancel(); }
        drop(_serial);
        if let Some(access) = access { access.finish(&app).await; } else { app.cancel_token(id).await; }
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
        let expired: Vec<_> = app.active_tokens.lock().unwrap().values().filter_map(std::sync::Weak::upgrade)
            .filter(|k| !k.metadata.live() && !k.cancelled.is_cancelled()).collect();
        for key in &expired { key.cancel(); }
        for key in expired {
            let app = app.clone();
            tokio::spawn(async move {
                key.finish(&app).await;
                app.active_tokens.lock().unwrap().remove(&key.metadata.id);
            });
        }
        app.viewers.lock().unwrap().expire_requests();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;
    use crate::test_rig::Rig;
    use rmcp::transport::streamable_http_server::session::SessionManager;

    async fn until(check: impl Fn() -> bool) {
        tokio::time::timeout(Duration::from_secs(3), async {
            while !check() { tokio::time::sleep(Duration::from_millis(10)).await; }
        }).await.unwrap();
    }

    #[tokio::test]
    async fn expiry_continues_during_dispatch_and_revocation_waits_for_drain() {
        let rig = Rig::new().await;
        let admin = rig.key(&[P::TokensManage, P::DesktopView, P::DesktopControl]).await;
        let expiry = tokens::now_ms() + 1000;
        let mut keys = Vec::new();
        for deadline in [expiry, expiry, expiry + 500] {
            let created = rig.app.tokens.create(tokens::Create { label: "Expiry check".into(), permissions: [P::DesktopControl].into(), expires_at_ms: Some(deadline) }).await.unwrap();
            keys.push(rig.app.key_for(&created.token).await.unwrap().unwrap());
        }
        let first = keys[0].admit_dispatch().await.unwrap();
        let second = keys[1].admit_dispatch().await.unwrap();
        let authenticated = keys[0].metadata.clone();
        rig.app.batches.lock().unwrap().insert("revoke".into(), keys[0].clone());
        rig.app.batches.lock().unwrap().insert("expiry".into(), keys[1].clone());
        let (session, _transport) = rig.app.mcp_sessions.manager.create_session().await.unwrap();
        rig.app.mcp_sessions.own_session(&session, keys[0].clone());
        let (expiry_session, _expiry_transport) = rig.app.mcp_sessions.manager.create_session().await.unwrap();
        rig.app.mcp_sessions.own_session(&expiry_session, keys[1].clone());
        let task = tokio::spawn(sweep(Arc::downgrade(&rig.app)));
        until(|| keys[0].cancelled.is_cancelled() && keys[1].cancelled.is_cancelled()).await;
        assert!(rig.app.active_tokens.lock().unwrap().contains_key(&keys[0].metadata.id));
        assert!(rig.app.active_tokens.lock().unwrap().contains_key(&keys[1].metadata.id));
        // A database authentication result can reach the cache after the token has expired.
        let cached = rig.app.access_for(authenticated);
        assert!(Arc::ptr_eq(&cached, &keys[0]), "expiry must not replace an access record with admitted dispatches");
        assert!(!cached.live());
        {
            let mut viewers = rig.app.viewers.lock().unwrap();
            viewers.sessions.insert(0, crate::ws::tests::viewer(admin.clone()));
            let mut second = crate::ws::tests::viewer(admin.clone());
            second.participant = 1;
            viewers.sessions.insert(1, second);
            viewers.participants.insert(0, crate::participants::Participant::new(0, &admin));
            viewers.participants.insert(1, crate::participants::Participant::new(1, &admin));
            viewers.controller = Some(0);
            rig.app.request_control(&mut viewers, 1);
            viewers.participants.get_mut(&1).unwrap().request.as_mut().unwrap().elapse();
        }
        until(|| rig.app.viewers.lock().unwrap().participants[&1].request_result == Some("expired")).await;
        until(|| !rig.app.active_tokens.lock().unwrap().contains_key(&keys[2].metadata.id)).await;
        assert!(keys[2].cancelled.is_cancelled());

        let app = rig.app.clone();
        let id = keys[0].metadata.id;
        let revoker = admin.clone();
        let mut revoke = tokio::spawn(async move { super::revoke(Extension(revoker), State(app), Path(id.to_string())).await });
        until(|| !rig.app.active_tokens.lock().unwrap().contains_key(&id)).await;
        assert!(!revoke.is_finished(), "explicit revocation must retain the dispatch drain barrier");
        assert!(rig.app.batches.lock().unwrap().contains_key("revoke"));
        let sessions = rig.app.mcp_sessions.manager.sessions.write().await;
        drop(first);
        until(|| !rig.app.batches.lock().unwrap().contains_key("revoke")).await;
        assert!(tokio::time::timeout(Duration::from_millis(50), &mut revoke).await.is_err(), "revocation must await the expiry task's MCP cleanup");
        drop(sessions);
        assert_eq!(tokio::time::timeout(Duration::from_secs(3), revoke).await.unwrap().unwrap().unwrap(), StatusCode::NO_CONTENT);
        assert!(!rig.app.mcp_sessions.manager.has_session(&session).await.unwrap());
        assert!(rig.app.active_tokens.lock().unwrap().contains_key(&keys[1].metadata.id), "another expired dispatch is still held");
        assert!(rig.app.batches.lock().unwrap().contains_key("expiry"), "expiry cleanup follows the dispatch drain");
        let sessions = rig.app.mcp_sessions.manager.sessions.write().await;
        drop(second);
        until(|| !rig.app.batches.lock().unwrap().contains_key("expiry")).await;
        let id = keys[1].metadata.id;
        assert!(rig.app.active_tokens.lock().unwrap().contains_key(&id), "the access record survives until cleanup completes");
        let app = rig.app.clone();
        let mut revoke = tokio::spawn(async move { super::revoke(Extension(admin), State(app), Path(id.to_string())).await });
        until(|| !rig.app.active_tokens.lock().unwrap().contains_key(&id)).await;
        assert!(tokio::time::timeout(Duration::from_millis(50), &mut revoke).await.is_err(), "revocation arriving during cleanup must await its completion");
        drop(sessions);
        assert_eq!(tokio::time::timeout(Duration::from_secs(3), revoke).await.unwrap().unwrap().unwrap(), StatusCode::NO_CONTENT);
        assert!(!rig.app.mcp_sessions.manager.has_session(&expiry_session).await.unwrap());
        until(|| !rig.app.active_tokens.lock().unwrap().contains_key(&keys[1].metadata.id)).await;
        task.abort();
        let _ = task.await;
    }
}
