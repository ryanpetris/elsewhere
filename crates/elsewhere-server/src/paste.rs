//! A socket's clipboard installation and paste share compositor-thread authorization.
use std::sync::{Arc, Weak};
use elsewhere_core::{ClipboardPaste, Command};
use crate::{App, Key, api, protocol::{self, PasteFiles, PasteMsg, PasteSelection}, tokens::Permission as P};

struct Admission { app: Weak<App>, key: Key, session: u64, epoch: u64, paste: bool, files: Option<PasteFiles> }
impl std::fmt::Debug for Admission {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result { f.write_str("Clipboard paste admission") }
}

impl ClipboardPaste for Admission {
    fn execute(self: Box<Self>, apply: Box<dyn FnOnce(bool) -> bool + '_>) {
        let Some(app) = self.app.upgrade() else { return; };
        let result = self.key.with(&[P::ClipboardWrite], || {
            if let Some(files) = &self.files {
                self.key.require(P::FilesUpload)?;
                app.clipboard_file_list(&self.key, &files.names, Some(&files.batch))?;
            }
            let viewers = app.viewers.lock().unwrap();
            let windows = app.window_viewers.lock().unwrap();
            let window = self.session & (1 << 63) != 0;
            let live = if window { windows.get(&(self.session & !(1 << 63))).map(|s| &s.key) }
                else { viewers.sessions.get(&self.session).map(|s| &s.key) };
            if !live.is_some_and(|key| Arc::ptr_eq(key, &self.key)) { return Ok(()); }
            let input = self.paste && self.key.has(P::DesktopControl)
                && (window || viewers.controller == Some(self.session) && viewers.control_epoch == self.epoch);
            // Keep input ownership ordered with other inputs and control changes through the actual tap.
            let _owner = app.input_owner.lock().unwrap();
            self.key.require(P::ClipboardWrite)?;
            let pasted = apply(input);
            let events = if window { &windows[&(self.session & !(1 << 63))].events } else { &viewers.sessions[&self.session].events };
            if !window && (self.epoch != viewers.control_epoch || self.paste && !pasted) {
                let _ = events.try_send(protocol::role(viewers.role_of(self.session), app.features(&self.key), viewers.control_epoch));
            }
            if self.paste && !pasted {
                let _ = events.try_send(protocol::notice("Clipboard updated; paste skipped because control or window focus changed."));
            }
            Ok(())
        });
        if let Err(error) = result { app.paste_notice(&self.key, self.session, error); }
    }
}

impl App {
    pub(crate) fn paste_clipboard(self: &Arc<Self>, key: &Key, session: u64, msg: PasteMsg) {
        let result = key.with(&[P::ClipboardWrite], || {
            let (mime, data, files) = match msg.selection {
                PasteSelection::Png(data) => (api::PNG, data, None),
                PasteSelection::Files(files) => {
                    key.require(P::FilesUpload)?;
                    let data = self.clipboard_file_list(key, &files.names, Some(&files.batch))?;
                    (api::URI_LIST, data, Some(files))
                }
            };
            if data.len() > api::clipboard_limit(mime) { return Err(api::ApiError::TooLarge); }
            let window = if session & (1 << 63) != 0 {
                let windows = self.window_viewers.lock().unwrap();
                let Some(viewer) = windows.get(&(session & !(1 << 63))) else { return Ok(()); };
                Some(viewer.window)
            } else { None };
            self.send(Command::PasteClipboard { mime: mime.into(), data, shift_insert: msg.shift_insert, window,
                admission: Box::new(Admission { app: Arc::downgrade(self), key: key.clone(), session, epoch: msg.epoch, paste: msg.paste, files }) })
        });
        if let Err(error) = result { self.paste_notice(key, session, error); }
    }

    fn paste_notice(&self, key: &Key, session: u64, error: api::ApiError) {
        if !key.live() { return; }
        let packet = protocol::notice(&format!("Clipboard paste failed: {error}"));
        if session & (1 << 63) != 0 {
            if let Some(s) = self.window_viewers.lock().unwrap().get(&(session & !(1 << 63))) { let _ = s.events.try_send(packet); }
        } else if let Some(s) = self.viewers.lock().unwrap().sessions.get(&session) { let _ = s.events.try_send(packet); }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{path::PathBuf, sync::Mutex};
    use tokio::sync::mpsc;
    use crate::{tokens, WindowViewer};

    struct Rig { app: Arc<App>, commands: calloop::channel::Channel<Command>, root: PathBuf }
    impl Drop for Rig { fn drop(&mut self) { let _ = std::fs::remove_dir_all(&self.root); } }
    impl Rig {
        async fn new() -> Self {
            let root = std::env::temp_dir().join(format!("elsewhere-paste-admission-{}", uuid::Uuid::new_v4()));
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
                elements: false, version: "", tls: false, port: 0, url_prefix: String::new(), proxy_strips_prefix: false,
            });
            Self { app, commands: receiver, root }
        }
        async fn key(&self, permissions: &[P]) -> Key {
            let created = self.app.tokens.create(tokens::Create { label: "Paste admission".into(), permissions: permissions.iter().copied().collect(), expires_at_ms: None }).await.unwrap();
            self.app.key_for(&created.token).await.unwrap().unwrap()
        }
        fn window(&self, key: &Key) -> mpsc::Receiver<elsewhere_core::Bytes> {
            let (events, receiver) = mpsc::channel(8);
            self.app.window_viewers.lock().unwrap().insert(1, WindowViewer { window: 99, key: key.clone(), events });
            receiver
        }
        fn queue(&self, key: &Key, selection: PasteSelection) -> Box<dyn ClipboardPaste> {
            self.app.paste_clipboard(key, (1 << 63) | 1, PasteMsg { paste: true, shift_insert: false, epoch: 0, selection });
            let Command::PasteClipboard { admission, .. } = self.commands.try_recv().unwrap() else { panic!("expected clipboard operation") };
            admission
        }
    }

    #[tokio::test]
    async fn paste_execution_preserves_later_queued_input_ownership() {
        let rig = Rig::new().await;
        let a = rig.key(&[P::DesktopView, P::DesktopControl, P::ClipboardWrite]).await;
        let b = rig.key(&[P::DesktopControl]).await;
        let _events = rig.window(&a);
        let paste = rig.queue(&a, PasteSelection::Png(vec![1]));
        b.with(&[P::DesktopControl], || rig.app.send_input(&b, 7, Command::Key { evdev: 30, pressed: true })).unwrap();
        let mut injected = false;
        paste.execute(Box::new(|input| { injected = input; input }));
        assert!(injected);
        assert_eq!(*rig.app.input_owner.lock().unwrap(), Some((b.metadata.id, 7)));
        assert!(matches!(rig.commands.try_recv().unwrap(), Command::Key { evdev: 30, pressed: true }));
        rig.app.release_input(&b, 7);
        assert!(matches!(rig.commands.try_recv().unwrap(), Command::ReleaseAllInput));
    }

    #[tokio::test]
    async fn queued_paste_rechecks_connection_revocation_and_clipboard_only_grants() {
        for state in ["write-only", "disconnected", "revoked"] {
            let rig = Rig::new().await;
            let key = rig.key(&[P::DesktopView, P::ClipboardWrite, P::TokensManage]).await;
            let _events = rig.window(&key);
            let paste = rig.queue(&key, PasteSelection::Png(vec![1]));
            if state == "disconnected" { rig.app.window_viewers.lock().unwrap().clear(); }
            if state == "revoked" {
                crate::auth::revoke(axum::Extension(key.clone()), axum::extract::State(rig.app.clone()), axum::extract::Path(key.metadata.id.to_string())).await.unwrap();
                assert!(!key.live());
            }
            let mut applied = None;
            paste.execute(Box::new(|input| { applied = Some(input); input }));
            assert_eq!(applied, (state == "write-only").then_some(false), "{state}");
        }
    }

    #[tokio::test]
    async fn queued_file_paste_revalidates_files_and_reports_failure() {
        let rig = Rig::new().await;
        let key = rig.key(&[P::DesktopView, P::DesktopControl, P::ClipboardWrite, P::FilesUpload]).await;
        let mut events = rig.window(&key);
        let saved = rig.app.stage_file(&key, "batch", "sample.txt", axum::body::Body::from("sample")).await.unwrap();
        let paste = rig.queue(&key, PasteSelection::Files(PasteFiles { names: vec![saved.clone()], batch: "batch".into() }));
        std::fs::remove_file(rig.app.drops_dir.join(key.metadata.id.to_string()).join("batch").join(saved)).unwrap();
        paste.execute(Box::new(|_| panic!("missing file must not install or paste")));
        let notice = events.try_recv().unwrap();
        assert_eq!(notice[0], protocol::NOTICE);
        assert!(std::str::from_utf8(&notice[2..]).unwrap().contains("Clipboard paste failed"));
        let other = rig.key(&[P::DesktopView, P::ClipboardWrite, P::FilesUpload]).await;
        assert!(matches!(rig.app.clipboard_file_list(&other, &["sample.txt".into()], Some("batch")), Err(api::ApiError::Forbidden)));
    }
}
