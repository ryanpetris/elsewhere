use std::{collections::HashMap, sync::{Arc, Mutex}, time::Duration};

use axum::{Extension, body::Body, extract::{Request, State}, http::{Method, StatusCode}, middleware::Next, response::{IntoResponse, Response}};
use futures_util::StreamExt;
use rmcp::transport::streamable_http_server::session::{SessionManager, local::LocalSessionManager};
use tokio::time::Instant;

use crate::{Key, api::ApiError};

const IDLE_TIMEOUT: Duration = Duration::from_secs(15 * 60);
const INIT_TIMEOUT: Duration = Duration::from_secs(30);
const SWEEP_INTERVAL: Duration = Duration::from_secs(30);

struct Owner {
    key: Key,
    active: usize,
    idle_since: Instant,
}

pub(crate) struct Sessions {
    pub manager: Arc<LocalSessionManager>,
    owners: Mutex<HashMap<String, Owner>>,
    // A sweep cannot inspect unowned sessions until initialization has returned or been cancelled.
    initializing: tokio::sync::RwLock<()>,
}

impl Default for Sessions {
    fn default() -> Self {
        let mut manager = LocalSessionManager::default();
        // HTTP response bodies, including quiet SSE streams, determine activity here.
        manager.session_config.keep_alive = None;
        Self { manager: Arc::new(manager), owners: Mutex::default(), initializing: tokio::sync::RwLock::default() }
    }
}

impl Sessions {
    fn acquire(self: &Arc<Self>, id: &str, key: &Key) -> Result<Lease, StatusCode> {
        let mut owners = self.owners.lock().unwrap();
        let owner = owners.get_mut(id).ok_or(StatusCode::NOT_FOUND)?;
        if owner.key.metadata.id != key.metadata.id || !owner.key.live() { return Err(StatusCode::FORBIDDEN); }
        owner.active += 1;
        Ok(Lease { sessions: self.clone(), id: id.into() })
    }

    fn register(self: &Arc<Self>, id: &str, key: Key) -> Result<Lease, ApiError> {
        key.with(&[], || {
            self.owners.lock().unwrap().insert(id.into(), Owner { key: key.clone(), active: 1, idle_since: Instant::now() });
            Ok(Lease { sessions: self.clone(), id: id.into() })
        })
    }

    pub async fn revoke(&self, token: uuid::Uuid) {
        let ids = {
            let mut owners = self.owners.lock().unwrap();
            let ids: Vec<_> = owners.iter().filter(|(_, owner)| owner.key.metadata.id == token).map(|(id, _)| id.clone()).collect();
            owners.retain(|_, owner| owner.key.metadata.id != token);
            ids
        };
        for id in ids { let _ = self.manager.close_session(&id.into()).await; }
    }

    async fn reap(&self, now: Instant) {
        let handles: Vec<_> = {
            let _initializing = self.initializing.write().await;
            let mut sessions = self.manager.sessions.write().await;
            let mut owners = self.owners.lock().unwrap();
            owners.retain(|id, owner| sessions.contains_key(id.as_str()) && owner.key.live()
                && (owner.active > 0 || now.saturating_duration_since(owner.idle_since) < IDLE_TIMEOUT));
            sessions.extract_if(|id, _| !owners.contains_key(id.as_ref())).map(|(_, handle)| handle).collect()
        };
        // Normal expiry closes gracefully. If a worker stalls, dropping its handle closes the event channel.
        let _ = tokio::time::timeout(Duration::from_secs(1), async {
            for handle in &handles { let _ = handle.close().await; }
        }).await;
    }
}

struct Lease {
    sessions: Arc<Sessions>,
    id: String,
}

impl Drop for Lease {
    fn drop(&mut self) {
        if let Some(owner) = self.sessions.owners.lock().unwrap().get_mut(&self.id) {
            owner.active -= 1;
            if owner.active == 0 { owner.idle_since = Instant::now(); }
        }
    }
}

/// Cached replies and resumed streams require the creating token and keep that session active.
pub(crate) async fn bind(State(sessions): State<Arc<Sessions>>, Extension(key): Extension<Key>, request: Request, next: Next) -> Response {
    let id = request.headers().get("mcp-session-id").and_then(|h| h.to_str().ok()).map(str::to_owned);
    let deleting = request.method() == Method::DELETE;
    let lease = if let Some(id) = &id {
        match sessions.acquire(id, &key) {
            Ok(lease) => Some(lease),
            Err(error) => return error.into_response(),
        }
    } else { None };
    let (request, initializing) = match super::validate_capture_body(request).await {
        Ok(validated) => validated,
        Err(response) => return response,
    };
    let (response, lease) = if let Some(id) = id {
        let response = next.run(request).await;
        if deleting && response.status().is_success() { sessions.owners.lock().unwrap().remove(&id); }
        (response, lease)
    } else if initializing {
        let _initializing = sessions.initializing.read().await;
        let response = match tokio::time::timeout(INIT_TIMEOUT, next.run(request)).await {
            Ok(response) => response,
            Err(_) => return StatusCode::REQUEST_TIMEOUT.into_response(),
        };
        let lease = if let Some(id) = response.headers().get("mcp-session-id").and_then(|h| h.to_str().ok()) {
            match sessions.register(id, key) {
                Ok(lease) => Some(lease),
                Err(error) => return error.into_response(),
            }
        } else { None };
        (response, lease)
    } else {
        return next.run(request).await;
    };
    let (parts, body) = response.into_parts();
    let stream = futures_util::stream::unfold((body.into_data_stream(), lease), |(mut body, lease)| async move {
        body.next().await.map(|item| (item, (body, lease)))
    });
    Response::from_parts(parts, Body::from_stream(stream))
}

pub(crate) async fn sweep(sessions: std::sync::Weak<Sessions>) {
    let mut interval = tokio::time::interval(SWEEP_INTERVAL);
    loop {
        interval.tick().await;
        let Some(sessions) = sessions.upgrade() else { return; };
        sessions.reap(Instant::now()).await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{Router, middleware};
    use tower::ServiceExt;

    #[derive(Clone)]
    struct Handler;
    impl rmcp::ServerHandler for Handler {
        async fn ping(&self, context: rmcp::service::RequestContext<rmcp::RoleServer>) -> Result<(), rmcp::ErrorData> {
            context.peer.notify_resource_updated(rmcp::model::ResourceUpdatedNotificationParam::new("fixture://cached")).await.unwrap();
            Ok(())
        }
    }

    fn router(sessions: &Arc<Sessions>) -> Router {
        use rmcp::transport::streamable_http_server::{StreamableHttpService, StreamableHttpServerConfig};
        Router::new().fallback_service(StreamableHttpService::new(
            || Ok(Handler), sessions.manager.clone(), StreamableHttpServerConfig::default().disable_allowed_hosts(),
        )).layer(middleware::from_fn_with_state(sessions.clone(), bind))
    }

    fn request(key: &Key, id: Option<&str>, method: Method, body: &str) -> Request {
        let mut request = Request::builder().method(method).uri("/")
            .header("host", "localhost").header("content-type", "application/json").header("accept", "application/json, text/event-stream")
            .header("mcp-protocol-version", "2025-03-26");
        if let Some(id) = id { request = request.header("mcp-session-id", id); }
        let mut request = request.body(Body::from(body.to_owned())).unwrap();
        request.extensions_mut().insert(key.clone());
        request
    }

    async fn initialize(router: &Router, key: &Key) -> String {
        let response = router.clone().oneshot(request(key, None, Method::POST,
            r#"{"jsonrpc":"2.0","id":0,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"fixture","version":"1"}}}"#)).await.unwrap();
        if response.status() != StatusCode::OK { panic!("initialize: {:?}", axum::body::to_bytes(response.into_body(), usize::MAX).await.unwrap()); }
        let id = response.headers()["mcp-session-id"].to_str().unwrap().to_owned();
        axum::body::to_bytes(response.into_body(), usize::MAX).await.unwrap();
        let response = router.clone().oneshot(request(key, Some(&id), Method::POST,
            r#"{"jsonrpc":"2.0","method":"notifications/initialized"}"#)).await.unwrap();
        assert_eq!(response.status(), StatusCode::ACCEPTED);
        drop(response);
        id
    }

    fn key() -> Key {
        Arc::new(crate::auth::Access::new(crate::tokens::Token {
            id: uuid::Uuid::new_v4(), label: "MCP fixture".into(), created_at_ms: 0,
            expires_at_ms: None, permissions: Default::default(),
        }))
    }

    #[tokio::test]
    async fn disconnected_sessions_expire_and_active_sessions_keep_their_owner() {
        let sessions = Arc::new(Sessions::default());
        let owner = key();
        let mut transports = Vec::new();
        for _ in 0..64 {
            let (id, transport) = sessions.manager.create_session().await.unwrap();
            transports.push(transport);
            drop(sessions.register(&id, owner.clone()).unwrap());
        }
        let (id, transport) = sessions.manager.create_session().await.unwrap();
        transports.push(transport);
        let first = sessions.register(&id, owner.clone()).unwrap();
        let second = sessions.acquire(&id, &owner).unwrap();
        assert!(sessions.acquire(&id, &key()).is_err());
        sessions.reap(Instant::now() + IDLE_TIMEOUT).await;
        assert_eq!(sessions.manager.sessions.read().await.len(), 1);
        assert_eq!(sessions.owners.lock().unwrap().len(), 1);
        drop(first);
        sessions.reap(Instant::now() + IDLE_TIMEOUT).await;
        assert!(sessions.manager.has_session(&id).await.unwrap());
        drop(second);
        sessions.reap(Instant::now()).await;
        assert!(sessions.manager.has_session(&id).await.unwrap());
        sessions.reap(Instant::now() + IDLE_TIMEOUT).await;
        assert!(sessions.manager.sessions.read().await.is_empty());
        assert!(sessions.owners.lock().unwrap().is_empty());
        assert!(sessions.acquire(&id, &owner).is_err());
    }

    #[tokio::test]
    async fn cleanup_waits_for_initialization_and_collects_cancelled_sessions() {
        let sessions = Arc::new(Sessions::default());
        for complete in [true, false] {
            let (created, ready) = tokio::sync::oneshot::channel();
            let (finish, finishing) = tokio::sync::oneshot::channel();
            let initializing = tokio::spawn({
                let sessions = sessions.clone();
                async move {
                    let _initializing = sessions.initializing.read().await;
                    let (id, transport) = sessions.manager.create_session().await.unwrap();
                    created.send(id.clone()).unwrap();
                    finishing.await.unwrap();
                    let lease = sessions.register(&id, key()).unwrap();
                    (transport, lease)
                }
            });
            let id = ready.await.unwrap();
            let cleanup = tokio::spawn({
                let sessions = sessions.clone();
                async move { sessions.reap(Instant::now()).await; }
            });
            tokio::task::yield_now().await;
            assert!(!cleanup.is_finished());
            if complete {
                finish.send(()).unwrap();
                let (_transport, _lease) = initializing.await.unwrap();
                cleanup.await.unwrap();
                assert!(sessions.manager.has_session(&id).await.unwrap());
            } else {
                initializing.abort();
                assert!(initializing.await.is_err_and(|error| error.is_cancelled()));
                cleanup.await.unwrap();
                assert!(!sessions.manager.has_session(&id).await.unwrap());
            }
        }
    }

    #[tokio::test]
    async fn http_disconnects_quiet_streams_and_replays_obey_session_lifetime() {
        let sessions = Arc::new(Sessions::default());
        let router = router(&sessions);
        let owner = key();
        for _ in 0..32 { initialize(&router, &owner).await; }
        let id = initialize(&router, &owner).await;
        let stream = router.clone().oneshot(request(&owner, Some(&id), Method::GET, "")).await.unwrap();
        assert_eq!(stream.status(), StatusCode::OK);
        tokio::time::pause();
        tokio::time::advance(IDLE_TIMEOUT + SWEEP_INTERVAL).await;
        tokio::time::resume();
        sessions.reap(Instant::now()).await;
        assert_eq!(sessions.manager.sessions.read().await.len(), 1);
        assert_eq!(sessions.owners.lock().unwrap().len(), 1);

        let response = router.clone().oneshot(request(&owner, Some(&id), Method::POST,
            r#"{"jsonrpc":"2.0","id":1,"method":"ping"}"#)).await.unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let body = String::from_utf8(axum::body::to_bytes(response.into_body(), usize::MAX).await.unwrap().to_vec()).unwrap();
        assert!(body.contains("\"result\":{}"), "{body}");
        let resume = |key: &Key| {
            let mut request = request(key, Some(&id), Method::GET, "");
            request.headers_mut().insert("last-event-id", "0".parse().unwrap());
            request
        };
        let denied = router.clone().oneshot(resume(&key())).await.unwrap();
        assert_eq!(denied.status(), StatusCode::FORBIDDEN);
        drop(stream);
        let response = router.clone().oneshot(resume(&owner)).await.unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let mut replay = response.into_body().into_data_stream();
        let chunk = replay.next().await.unwrap().unwrap();
        assert!(String::from_utf8_lossy(&chunk).contains("fixture://cached"));
        tokio::time::pause();
        tokio::time::advance(IDLE_TIMEOUT).await;
        tokio::time::resume();
        sessions.reap(Instant::now()).await;
        assert!(sessions.manager.has_session(&id.clone().into()).await.unwrap());
        drop(replay);
        sessions.reap(Instant::now()).await;
        assert!(sessions.manager.has_session(&id.clone().into()).await.unwrap());
        tokio::time::pause();
        tokio::time::advance(IDLE_TIMEOUT).await;
        tokio::time::resume();
        sessions.reap(Instant::now()).await;
        assert!(sessions.manager.sessions.read().await.is_empty());
        assert!(sessions.owners.lock().unwrap().is_empty());
        assert_eq!(router.oneshot(resume(&owner)).await.unwrap().status(), StatusCode::NOT_FOUND);
    }

    #[tokio::test(start_paused = true)]
    async fn interrupted_http_initialization_is_reaped_and_has_a_deadline() {
        let sessions = Arc::new(Sessions::default());
        use std::sync::atomic::{AtomicUsize, Ordering};
        use rmcp::transport::streamable_http_server::{StreamableHttpService, StreamableHttpServerConfig};
        struct Counted(Arc<AtomicUsize>);
        impl rmcp::ServerHandler for Counted {}
        impl Drop for Counted {
            fn drop(&mut self) { self.0.fetch_add(1, Ordering::SeqCst); }
        }
        let dropped = Arc::new(AtomicUsize::new(0));
        let counter = dropped.clone();
        let service = StreamableHttpService::new(
            move || Ok(Counted(counter.clone())), sessions.manager.clone(),
            StreamableHttpServerConfig::default().disable_allowed_hosts(),
        );
        let (created, mut ready) = tokio::sync::mpsc::unbounded_channel();
        let router = Router::new().fallback_service(service)
            .layer(middleware::from_fn(move |request: Request, next: Next| {
                let created = created.clone();
                async move {
                    let response = next.run(request).await;
                    assert_eq!(response.status(), StatusCode::OK);
                    created.send(response.headers()["mcp-session-id"].clone()).unwrap();
                    let _response = response;
                    std::future::pending::<Response>().await
                }
            }))
            .layer(middleware::from_fn_with_state(sessions.clone(), bind));
        let initializing_request = || request(&key(), None, Method::POST,
            r#"{"jsonrpc":"2.0","id":0,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"fixture","version":"1"}}}"#);
        for _ in 0..32 {
            let task = tokio::spawn(router.clone().oneshot(initializing_request()));
            ready.recv().await.unwrap();
            task.abort();
            assert!(task.await.unwrap_err().is_cancelled());
        }
        sessions.reap(Instant::now()).await;
        assert!(sessions.manager.sessions.read().await.is_empty());
        let task = tokio::spawn(router.oneshot(initializing_request()));
        ready.recv().await.unwrap();
        let reaper = tokio::spawn({ let sessions = sessions.clone(); async move { sessions.reap(Instant::now()).await; } });
        tokio::task::yield_now().await;
        assert!(!reaper.is_finished());
        tokio::time::advance(INIT_TIMEOUT).await;
        assert_eq!(task.await.unwrap().unwrap().status(), StatusCode::REQUEST_TIMEOUT);
        reaper.await.unwrap();
        assert!(sessions.manager.sessions.read().await.is_empty());
        assert!(sessions.owners.lock().unwrap().is_empty());
        for _ in 0..100 {
            if dropped.load(Ordering::SeqCst) == 33 { break; }
            tokio::task::yield_now().await;
        }
        assert_eq!(dropped.load(Ordering::SeqCst), 33);
    }

    #[tokio::test]
    async fn delete_and_revocation_release_sessions_without_touching_other_tokens() {
        let sessions = Arc::new(Sessions::default());
        let router = router(&sessions);
        let owner = key();
        let other = key();
        let first = initialize(&router, &owner).await;
        let second = initialize(&router, &other).await;
        let denied = router.clone().oneshot(request(&other, Some(&first), Method::DELETE, "")).await.unwrap();
        assert_eq!(denied.status(), StatusCode::FORBIDDEN);
        sessions.revoke(owner.metadata.id).await;
        assert!(!sessions.manager.has_session(&first.into()).await.unwrap());
        assert_eq!(sessions.owners.lock().unwrap().len(), 1);
        let response = router.oneshot(request(&other, Some(&second), Method::DELETE, "")).await.unwrap();
        assert!(response.status().is_success());
        drop(response);
        assert!(sessions.manager.sessions.read().await.is_empty());
        assert!(sessions.owners.lock().unwrap().is_empty());
    }

    #[tokio::test(start_paused = true)]
    async fn sessionless_operations_do_not_block_cleanup_or_take_the_initialization_deadline() {
        let sessions = Arc::new(Sessions::default());
        let (started, mut ready) = tokio::sync::mpsc::unbounded_channel();
        let router = Router::new().fallback(move || {
            let started = started.clone();
            async move { started.send(()).unwrap(); std::future::pending::<Response>().await }
        }).layer(middleware::from_fn_with_state(sessions.clone(), bind));
        let task = tokio::spawn(router.oneshot(request(&key(), None, Method::POST,
            r#"{"jsonrpc":"2.0","id":1,"method":"tools/list"}"#)));
        ready.recv().await.unwrap();
        assert!(sessions.initializing.try_write().is_ok());
        sessions.reap(Instant::now()).await;
        tokio::time::advance(INIT_TIMEOUT + Duration::from_secs(1)).await;
        assert!(!task.is_finished());
        task.abort();
        assert!(task.await.unwrap_err().is_cancelled());
    }

    #[tokio::test]
    async fn a_dead_owner_cannot_pin_an_active_session() {
        let sessions = Arc::new(Sessions::default());
        let owner = key();
        let (id, _transport) = sessions.manager.create_session().await.unwrap();
        let lease = sessions.register(&id, owner.clone()).unwrap();
        let mut expired = owner.metadata.clone();
        expired.expires_at_ms = Some(0);
        sessions.owners.lock().unwrap().get_mut(id.as_ref()).unwrap().key = Arc::new(crate::auth::Access::new(expired));
        assert!(matches!(sessions.acquire(&id, &owner), Err(StatusCode::FORBIDDEN)));
        sessions.reap(Instant::now()).await;
        assert!(sessions.manager.sessions.read().await.is_empty());
        assert!(sessions.owners.lock().unwrap().is_empty());
        drop(lease);
    }
}
