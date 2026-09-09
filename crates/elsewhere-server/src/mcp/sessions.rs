use std::{collections::HashMap, sync::{Arc, Mutex}, time::{Duration, Instant}};

use axum::{Extension, body::Body, extract::{Request, State}, http::{Method, StatusCode}, middleware::Next, response::{IntoResponse, Response}};
use futures_util::StreamExt;
use rmcp::transport::streamable_http_server::session::{SessionManager, local::LocalSessionManager};

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
    fn acquire(self: &Arc<Self>, id: &str, key: &Key) -> Result<Lease, ApiError> {
        let mut owners = self.owners.lock().unwrap();
        let owner = owners.get_mut(id).ok_or(ApiError::Forbidden)?;
        if owner.key.metadata.id != key.metadata.id || !owner.key.live() { return Err(ApiError::Forbidden); }
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
        let _initializing = self.initializing.write().await;
        let mut sessions = self.manager.sessions.write().await;
        let mut owners = self.owners.lock().unwrap();
        owners.retain(|id, owner| sessions.contains_key(id.as_str()) && owner.key.live()
            && (owner.active > 0 || now.saturating_duration_since(owner.idle_since) < IDLE_TIMEOUT));
        // Dropping the last handle closes the worker's event channel, releasing its transport and caches.
        sessions.retain(|id, _| owners.contains_key(id.as_ref()));
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
    let (response, lease) = if let Some(id) = id {
        let lease = match sessions.acquire(&id, &key) {
            Ok(lease) => lease,
            Err(error) => return error.into_response(),
        };
        let response = next.run(request).await;
        if deleting && response.status().is_success() { sessions.owners.lock().unwrap().remove(&id); }
        (response, Some(lease))
    } else {
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
}
