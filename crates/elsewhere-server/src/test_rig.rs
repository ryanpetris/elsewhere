//! Server state and command channel for admission and lifecycle checks.
use std::{path::PathBuf, sync::{Arc, Mutex}};
use elsewhere_core::Command;
use crate::{App, Key, tokens::{self, Permission as P}};

pub(crate) struct Rig { pub app: Arc<App>, pub commands: calloop::channel::Channel<Command>, root: PathBuf }
impl Drop for Rig { fn drop(&mut self) { let _ = std::fs::remove_dir_all(&self.root); } }
impl Rig {
    pub async fn new() -> Self {
        let root = std::env::temp_dir().join(format!("elsewhere-server-check-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let (commands, receiver) = calloop::channel::channel();
        let app = Arc::new(App {
            tokens: tokens::Store::open(root.join("state.sqlite3")).await.unwrap(),
            auth_serial: tokio::sync::Mutex::new(()), active_tokens: Mutex::default(), input_owner: Mutex::default(), batches: Mutex::default(),
            mcp_sessions: Arc::new(crate::mcp::sessions::Sessions::default()), commands,
            codecs: vec![], software: true, bitrate_kbps: 1000, viewers: Mutex::default(),
            display_updates: tokio::sync::watch::channel(Default::default()).0,
            sinks: Box::new(|_| panic!("no encoder in admission checks")),
            broadcast_backend: crate::broadcast::Backend { start: Box::new(|_| panic!("no broadcast")), capabilities: Box::new(|| panic!("no broadcast")) },
            broadcasts: Mutex::default(), audio_available: false.into(), mixer: None, mic: None, cam: None, rtc: None, cam_dead: Default::default(),
            window_viewers: Mutex::default(), snapshot_lock: Arc::new(tokio::sync::Semaphore::new(1)), notifications: Mutex::default(),
            next_notification: 1.into(), notify_bus: std::sync::OnceLock::new(), files_dir: root.join("files"), drops_dir: root.join("drops"),
            element_refs: Mutex::default(), element_scheduler: Default::default(), elements: false, version: "", tls: false, port: 0, url_prefix: String::new(), proxy_strips_prefix: false,
        });
        Self { app, commands: receiver, root }
    }
    pub async fn key(&self, permissions: &[P]) -> Key {
        let created = self.app.tokens.create(tokens::Create { label: "Server check".into(), permissions: permissions.iter().copied().collect(), expires_at_ms: None }).await.unwrap();
        self.app.key_for(&created.token).await.unwrap().unwrap()
    }
}
