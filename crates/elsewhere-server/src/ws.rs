//! WebSocket sessions: the viewers of the desktop (any number, each with its own encoder; one of them,
//! the controller, drives the pointer and keyboard and sizes the output) and the per-window streams.

use std::{
    sync::{Arc, atomic::{AtomicU64, Ordering}},
    time::{Duration, Instant},
};

use axum::extract::ws::{CloseFrame, Message, WebSocket};
use elsewhere_core::{AxisSource, Bytes, Codec, Command, ControlMsg, ControlOp, EncodingEffort, Event, InputMsg, OutputGeometry, StreamControl, StreamMsg, TouchKind};
use tokio::sync::mpsc;

use crate::{apps, auth, tokens::Permission as P, App, Key, ViewerSession, Viewers, api, protocol::{self, ClientMsg, Preset, Role}};

/// Close codes the page understands.
const UNAUTHORIZED: u16 = 4001;
/// An authenticated token without the grant required to view the desktop.
const FORBIDDEN: u16 = 4004;
/// A stream that can't (re)start: no such window, the window closed, no encoder could be made.
const GONE: u16 = 4003;

/// One viewer's ordered candidates. Failures survive encoder reopens until an attempt has
/// produced 120 frames over at least two seconds; an explicit preference list starts over.
pub(crate) struct CodecSelection {
    candidates: Vec<Codec>,
    index: usize,
    failures: u8,
    frames: u32,
    since: Option<Instant>,
    frame_epoch: Option<u64>,
    status: &'static str,
}
impl CodecSelection {
    fn new(preferences: &[Codec], supported: &[Codec], control: &dyn StreamControl) -> Self {
        let mut candidates = Vec::new();
        for &codec in preferences {
            if supported.contains(&codec) && !candidates.contains(&codec) { candidates.push(codec); }
        }
        let selection = Self { candidates, index: 0, failures: 0, frames: 0, since: None, frame_epoch: None, status: "starting" };
        if let Some(codec) = selection.codec() { control.set_codec(codec); } else { control.pause(); }
        selection
    }
    fn codec(&self) -> Option<Codec> { self.candidates.get(self.index).copied() }
    fn accepts(&self, epoch: u64, control: &dyn StreamControl) -> bool {
        self.codec().is_some() && epoch == control.epoch()
    }
    fn failed(&mut self, control: &dyn StreamControl) {
        self.failures += 1;
        self.frames = 0;
        self.since = None;
        self.frame_epoch = None;
        self.status = "retrying";
        if self.failures >= 2 {
            self.index += 1;
            self.failures = 0;
            self.status = "switching";
        }
        if let Some(codec) = self.codec() { control.set_codec(codec); } else { control.pause(); }
    }
    fn frame(&mut self, epoch: u64, now: Instant) {
        if self.frame_epoch != Some(epoch) {
            self.frame_epoch = Some(epoch);
            self.frames = 0;
            self.since = Some(now);
        }
        self.frames = self.frames.saturating_add(1);
        if self.frames >= 120 && self.since.is_some_and(|since| now.duration_since(since) >= Duration::from_secs(2)) {
            self.failures = 0;
        }
    }
    fn state(&self, app: &App, quality: elsewhere_core::Quality, preset: Preset, control: &dyn StreamControl) -> Bytes {
        protocol::stream_state(self.codec(), &app.codecs, !app.software,
            if self.codec().is_none() { "failed" } else { self.status }, control.epoch(), quality, preset, app.bitrate_kbps, control.effort())
    }
}

/// The clients' Opus packets to every viewer; a dropped packet is a 20 ms glitch.
pub async fn distribute_audio(app: Arc<App>, mut rx: mpsc::Receiver<StreamMsg>) {
    while let Some(msg) = rx.recv().await {
        if let StreamMsg::Audio { pts_us, data } = msg {
            for s in app.viewers.lock().unwrap().sessions.values_mut().filter(|s| s.key.has(P::AudioListen)) {
                let seq = s.audio_seq;
                s.audio_seq = seq.wrapping_add(1);
                let _ = s.audio.try_send(protocol::audio(pts_us, &data, seq));
            }
        }
    }
    app.audio_available.store(false, Ordering::Relaxed);
    let targets: Vec<_> = app.viewers.lock().unwrap().sessions.iter().map(|(&id, s)| (id, s.events.clone())).collect();
    for (id, events) in targets {
        let app = app.clone();
        tokio::spawn(async move {
            if let Ok(permit) = events.reserve().await {
                let viewers = app.viewers.lock().unwrap();
                if viewers.sessions.contains_key(&id) {
                    permit.send(protocol::role(viewers.role_of(id), app.features(&viewers.sessions[&id].key), viewers.control_epoch));
                }
            }
        });
    }
}

/// Compositor events (cursor, pointer lock, window list, clipboard) to every viewer and window session.
pub async fn forward_events(app: Arc<App>, mut rx: mpsc::UnboundedReceiver<Event>) {
    let mut pending = None;
    loop {
        let Some(mut ev) = (match pending.take() { Some(ev) => Some(ev), None => rx.recv().await }) else { break };
        // Window lists supersede each other: a slow viewer gets the newest one, not the whole history.
        while let Event::Windows(_) = ev {
            match rx.try_recv() {
                Ok(next @ Event::Windows(_)) => ev = next,
                Ok(next) => { pending = Some(next); break; }
                Err(_) => break,
            }
        }
        let mut v = app.viewers.lock().unwrap();
        let msg = match ev {
            Event::Cursor(img) => {
                let msg = protocol::cursor(img.as_ref());
                v.cursor = Some(msg.clone());
                msg
            }
            Event::PointerLock(locked) => {
                v.locked = locked;
                Bytes::from(vec![protocol::POINTER_LOCK, locked as u8])
            }
            Event::Windows(list) => {
                let msg = protocol::windows(&list);
                v.windows = Some(msg.clone());
                v.window_list = list;
                msg
            }
            Event::Clipboard { mime, data, operation } => {
                let data = if api::text_mime(&mime) {
                    Bytes::from(String::from_utf8_lossy(&data).into_owned())
                } else { data };
                v.clipboard = crate::Clipboard { mime: Some(mime), data: Some(data), loading: false, observation: v.clipboard.observation + 1, operation };
                app.broadcast_clipboard(&v);
                continue;
            }
            Event::ClipboardOffer { mime, loading } => {
                v.clipboard = crate::Clipboard { mime, loading, observation: v.clipboard.observation + 1, ..Default::default() };
                app.broadcast_clipboard(&v);
                continue;
            }
            Event::DragEnded { taken, target, batch } => {
                // Only the token that staged the batch receives its result.
                let owner = app.batches.lock().unwrap().get(&batch).cloned();
                let events: Vec<_> = v.sessions.values().filter(|s| owner.as_ref().is_some_and(|key| key.live() && key.metadata.id == s.key.metadata.id)).map(|s| s.events.clone()).collect();
                let app = app.clone();
                tokio::spawn(async move {
                    if !taken { if let Some(task) = app.rescue(&batch) { let _ = task.await; } return; }
                    let word = protocol::success(&format!("Copied to {}", target.map_or("the desktop".to_string(), |id| apps::display_name(&id))));
                    if owner.as_ref().is_some_and(|key| key.live()) { for events in events { let _ = events.try_send(word.clone()); } }
                });
                continue;
            }
        };
        drop(v);
        app.broadcast(msg);
    }
}

/// The first message must be AUTH with a token; until then this socket is nobody. A wrong token, or
/// five seconds of silence, ends it. Returns the token the session came in with and which one it is.
pub(super) async fn authenticate(socket: &mut WebSocket, app: &App) -> Option<Key> {
    let auth = tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            match socket.recv().await {
                Some(Ok(Message::Binary(b))) => {
                    let t = std::str::from_utf8(b.get(1..).unwrap_or_default()).unwrap_or("");
                    return if b.first() == Some(&protocol::AUTH) { app.key_for(t).await.ok().flatten() } else { None };
                }
                Some(Ok(Message::Close(_))) | Some(Err(_)) | None => return None,
                _ => {}
            }
        }
    })
    .await
    .ok()
    .flatten();
    if auth.is_none() {
        let _ = socket.send(Message::Close(Some(CloseFrame { code: UNAUTHORIZED, reason: "Invalid or expired token".into() }))).await;
    }
    auth
}

/// Hello, which picks the codec, before the encoder exists; five seconds of silence ends the socket.
async fn hello(socket: &mut WebSocket, key: &Key) -> Option<(Vec<Codec>, Preset, EncodingEffort)> {
    tokio::select! { biased; _ = key.ended() => None, result = tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            match socket.recv().await? {
                Ok(Message::Binary(b)) => {
                    if let Some(ClientMsg::Hello { codecs, quality, effort }) = protocol::decode(&b) {
                        return Some((codecs, quality, effort));
                    }
                }
                Ok(Message::Close(_)) | Err(_) => return None,
                _ => {}
            }
        }
    }) => result.ok().flatten() }
}

async fn close(socket: &mut WebSocket, code: u16, reason: &str) {
    let _ = tokio::time::timeout(Duration::from_millis(200), socket.send(Message::Close(Some(CloseFrame { code, reason: reason.into() })))).await;
}

/// A send that gives up on a peer that stopped reading, so its session ends (and with it the encoder
/// waiting on it) instead of sitting on a full socket for good.
async fn send(socket: &mut WebSocket, key: &Key, msg: Bytes) -> bool {
    send_message(socket, key, Message::Binary(msg)).await
}
async fn send_message(socket: &mut WebSocket, key: &Key, msg: Message) -> bool {
    tokio::select! { biased; _ = key.ended() => false,
        result = tokio::time::timeout(Duration::from_secs(10), socket.send(msg)) => result.is_ok_and(|r| r.is_ok()) }
}

/// A viewer of the desktop. The first one with a token with desktop.control controls; the rest watch the same
/// desktop scaled to their own window, and one with a token with desktop.control may take control.
pub async fn session(mut socket: WebSocket, app: Arc<App>) {
    let Some(key) = authenticate(&mut socket, &app).await else { return };
    if !key.live() { return close(&mut socket, UNAUTHORIZED, "token revoked or expired").await; }
    if !key.metadata.permissions.contains(&P::DesktopView) { return close(&mut socket, FORBIDDEN, "This token does not allow desktop viewing").await; }
    if !send(&mut socket, &key, protocol::permissions(&key.metadata.permissions)).await { return; }
    let Some((preferences, preset, effort)) = hello(&mut socket, &key).await else { return };
    let (tx, mut rx) = mpsc::channel::<StreamMsg>(2);
    let (sink, control) = match (app.sinks)(tx) {
        Ok(x) => x,
        Err(e) => {
            tracing::warn!("viewer stream: {e:#}");
            return close(&mut socket, GONE, "no encoder").await;
        }
    };
    let selection = CodecSelection::new(&preferences, &app.codecs, control.as_ref());
    control.set_effort(effort);
    let quality = preset.quality(app.bitrate_kbps);
    control.set_quality(quality);
    let mut auto = AutoRate::new(quality.bitrate_kbps);
    let (etx, mut erx) = mpsc::channel::<Bytes>(32);
    let (atx, mut arx) = mpsc::channel::<Bytes>(4);
    let notifications = protocol::notifications(&app.notifications()); // its own lock: never inside the viewers'
    let (id, replay) = {
        // registered under the lock a revocation clears, so a session that came in with an old token is
        // either cleared by it or refused here
        let mut v = app.viewers.lock().unwrap();
        if !key.live() {
            drop(v);
            return close(&mut socket, UNAUTHORIZED, "token revoked or expired").await;
        }
        let id = v.next_id;
        v.next_id += 1;
        v.sessions.insert(id, ViewerSession { key: key.clone(), events: etx.clone(), audio: atx, audio_seq: 0, size: None, control, selection, quality, preset, cam_wait_key: false, mixer_subscribed: false });
        if key.has(P::DesktopControl) && v.controller.is_none() {
            v.controller = Some(id);
            v.control_epoch = v.control_epoch.wrapping_add(1);
        }
        app.mixer_audience(&v);
        let replay: Vec<Bytes> = [Some(protocol::session(id)), key.has(P::AudioListen).then(|| protocol::mixer_state(&app.mixer_state())), v.cursor.clone(), v.windows.clone(), v.locked.then(|| Bytes::from(vec![protocol::POINTER_LOCK, 1])), Some(protocol::role(v.role_of(id), app.features(&key), v.control_epoch)), Some(notifications.clone())].into_iter().flatten().collect();
        (id, replay)
    };
    for msg in replay {
        let _ = send(&mut socket, &key, msg).await;
    }
    if let Some(hub) = &app.rtc {
        let _ = send(&mut socket, &key, protocol::rtc(&hub.config)).await; // the page may offer now
    }
    if let Some(state) = app.stream_state(id) { let _ = send(&mut socket, &key, state).await; }
    let _ = key.with(&[P::DesktopView], || { let _ = app.commands.send(Command::ViewerStream { key: id, sink: Some(sink) }); Ok(()) });

    let mut mixer_state = app.mixer.as_ref().filter(|_| key.has(P::AudioListen)).map(|m| m.state.clone());
    let mut mixer_levels = app.mixer.as_ref().filter(|_| key.has(P::AudioListen)).map(|m| m.levels.clone());
    let mut mixer_subscribed = false;
    let (mut info, mut config, mut ws_config, mut seq) = (None::<elsewhere_core::StreamInfo>, Bytes::new(), None, 0u16);
    let mut ping = tokio::time::interval(Duration::from_secs(1));
    let (mut unanswered, started) = (0, Instant::now());
    let mut display_updates = app.display_updates.subscribe();
    display_updates.mark_changed();
    let ended = loop {
        tokio::select! {
            biased;
            _ = key.ended() => break Some((UNAUTHORIZED, "token revoked or expired")),
            changed = display_updates.changed() => {
                if changed.is_err() { break None; }
                let message = display_updates.borrow_and_update().message();
                if !send(&mut socket, &key, message).await { break None; }
            },
            changed = async { match &mut mixer_state { Some(state) => state.changed().await, None => std::future::pending().await } } => {
                if !key.live() { break Some((UNAUTHORIZED, "token revoked or expired")); }
                if changed.is_err() { mixer_state = None; }
                if !send(&mut socket, &key, protocol::mixer_state(&app.mixer_state())).await { break None }
            },
            changed = async { match &mut mixer_levels { Some(levels) => levels.changed().await, None => std::future::pending().await } }, if mixer_subscribed => {
                if !key.live() { break Some((UNAUTHORIZED, "token revoked or expired")); }
                if changed.is_err() { mixer_levels = None; }
                let levels = app.mixer.as_ref().map(|m| m.levels.borrow().clone()).unwrap_or_default();
                if !send(&mut socket, &key, protocol::mixer_levels(&levels)).await { break None }
            },
            msg = rx.recv() => match msg {
                Some(StreamMsg::Info(epoch, i)) => {
                    if !app.accepts_video(id, epoch) { continue; }
                    if let Some(s) = app.viewers.lock().unwrap().sessions.get_mut(&id) { s.selection.status = "streaming"; }
                    seq = 0;
                    config = protocol::config(&i, epoch);
                    info = Some(i);
                    let Some(state) = app.stream_state(id) else { break Some((UNAUTHORIZED, "token revoked or expired")) };
                    if !send(&mut socket, &key, state).await { break None }
                }
                Some(StreamMsg::Frame(epoch, f)) => {
                    if !app.accepts_video(id, epoch) { continue; }
                    if let Some(s) = app.viewers.lock().unwrap().sessions.get_mut(&id) { s.selection.frame(epoch, Instant::now()); }
                    if info.as_ref().is_some_and(|i| i.stream_id == f.stream_id) {
                        // Sent in reference order; the worker refuses raw input while output is blocked.
                        let (backlog, pressure) = (rx.len(), app.rtc.as_ref().and_then(|hub| hub.pressure(id))); // native send blockage and drops are congestion too
                        let t = Instant::now();
                        match (&app.rtc, pressure) {
                            // the data channel, while the page has one open
                            (Some(hub), Some(_)) => hub.frame(id, config.clone(), protocol::video(&f, seq), auto.quality.bitrate_kbps),
                            _ => {
                                if ws_config != Some(f.stream_id) {
                                    if !send(&mut socket, &key, config.clone()).await { break None }
                                    ws_config = Some(f.stream_id);
                                }
                                if !send(&mut socket, &key, protocol::video(&f, seq)).await { break None }
                            },
                        }
                        seq = seq.wrapping_add(1);
                        let (dropped, blocked) = pressure.unwrap_or((0, false));
                        if let Some(q) = auto.frame(backlog > 0 || blocked, dropped, t.elapsed()) {
                            app.set_quality(id, q);
                            let Some(state) = app.stream_state(id) else { break Some((UNAUTHORIZED, "token revoked or expired")) };
                            if !send(&mut socket, &key, state).await { break None }
                        }
                    }
                }
                Some(StreamMsg::Failed(epoch)) => {
                    if !app.accepts_video(id, epoch) { continue; }
                    if let Some(s) = app.viewers.lock().unwrap().sessions.get_mut(&id) { s.selection.failed(s.control.as_ref()); }
                    info = None;
                    let Some(state) = app.stream_state(id) else { break None };
                    if !send(&mut socket, &key, state).await { break None }
                    let _ = app.commands.send(Command::RequestFullFrame);
                }
                None => break None,
                Some(StreamMsg::Audio { .. }) => {}
            },
            ev = erx.recv() => match ev {
                Some(b) => if !send(&mut socket, &key, b).await { break None },
                None => break Some((UNAUTHORIZED, "token revoked or expired")), // revocation dropped every session
            },
            Some(b) = arx.recv() => if !send(&mut socket, &key, b).await { break None },
            msg = socket.recv() => match msg {
                Some(Ok(Message::Binary(b))) => {
                    if !key.live() {
                        break Some((UNAUTHORIZED, "token revoked or expired")); // a queued command must not get through after a revocation
                    }
                    let decoded = protocol::decode(&b);
                    if let Some(ClientMsg::Mixer(Ok(elsewhere_core::audio::Command::Subscribe { enabled }))) = &decoded { mixer_subscribed = *enabled && key.has(P::AudioListen); }
                    match decoded {
                        Some(ClientMsg::Notify(n)) if key.has(P::DesktopControl) => app.spawn_notification_action(key.clone(), n),
                        Some(ClientMsg::Stream(choice)) => {
                            let (restart, preset) = app.apply_choice(id, &choice);
                            if let Some(preset) = preset {
                                auto = AutoRate::new(preset.quality(app.bitrate_kbps).bitrate_kbps);
                            }
                            if restart {
                                let _ = app.commands.send(Command::RequestFullFrame); // supply a full frame for the new encoder
                            }
                            let Some(state) = app.stream_state(id) else { break Some((UNAUTHORIZED, "token revoked or expired")) };
                            if !send(&mut socket, &key, state).await { break None }
                        }
                        Some(ClientMsg::Rtc { g, message: v }) => match (&app.rtc, v.get("offer").and_then(|o| o.as_str())) {
                            (Some(hub), Some(sdp)) => tokio::select! { biased; _ = key.ended() => {}, _ = hub.offer(id, sdp.to_string(), g, etx.clone()) => {} },
                            (Some(hub), None) if v.get("close").and_then(|b| b.as_bool()) == Some(true) => {
                                if hub.close_attempt(id, g).await {
                                    if !send(&mut socket, &key, protocol::rtc(&serde_json::json!({ "keyframe": true, "g": g }))).await { break None; }
                                    app.viewer_message(id, &key, ClientMsg::RequestKeyframe);
                                }
                            }
                            _ => {}
                        },
                        Some(ClientMsg::Report { delay_ms, dropped }) => auto.report(delay_ms, dropped),
                        Some(ClientMsg::PasteClipboard(msg)) => app.paste_clipboard(&key, id, msg),
                        Some(m) => app.viewer_message(id, &key, m),
                        None => {}
                    }
                }
                Some(Ok(Message::Pong(p))) => {
                    unanswered = 0;
                    if let Some(q) = rtt_of(&p, started).and_then(|rtt| auto.rtt(rtt)) {
                        app.set_quality(id, q);
                        let Some(state) = app.stream_state(id) else { break Some((UNAUTHORIZED, "token revoked or expired")) };
                        if !send(&mut socket, &key, state).await { break None }
                    }
                }
                Some(Ok(Message::Close(_))) | Some(Err(_)) | None => break None,
                _ => {}
            },
            _ = ping.tick() => {
                if !key.live() {
                    break Some((UNAUTHORIZED, "token revoked or expired")); // an idle session, which no message would end
                }
                // the pong comes back behind whatever video is queued in the socket: its time is the backlog's
                if unanswered >= 10 || !send_message(&mut socket, &key, Message::Ping(ping_payload(started))).await {
                    break None; // dead peer
                }
                unanswered += 1;
            }
        }
    };
    {
        let mut v = app.viewers.lock().unwrap();
        v.sessions.remove(&id);
        if v.controller == Some(id) {
            // the oldest remaining control-permitted session takes over
            let next = v.sessions.iter().filter(|(_, s)| s.key.has(P::DesktopControl)).map(|(id, _)| *id).min();
            app.set_controller(&mut v, next);
        }
        app.mixer_audience(&v);
    }
    app.release_input(&key, id);
    let _ = app.commands.send(Command::ViewerStream { key: id, sink: None });
    if let Some(hub) = &app.rtc {
        hub.close(id).await;
    }
    if let Some((code, reason)) = ended {
        close(&mut socket, code, reason).await;
    }
}

/// One window as its own stream (`/ws/window/{id}`): the same messages as `/ws`, except that pointer
/// positions are relative to the window's geometry, a Resize resizes the window rather than the
/// output, there is no audio, and a token with desktop.control drives regardless of who controls the desktop. Any
/// number of these can run; each has its own encoder, which the compositor stops when the session ends
/// or the window goes away.
pub async fn window_session(mut socket: WebSocket, app: Arc<App>, id: u64) {
    let Some(key) = authenticate(&mut socket, &app).await else { return };
    if !key.live() { return close(&mut socket, UNAUTHORIZED, "token revoked or expired").await; }
    if !key.metadata.permissions.contains(&P::DesktopView) { return close(&mut socket, FORBIDDEN, "This token does not allow desktop viewing").await; }
    if !send(&mut socket, &key, protocol::permissions(&key.metadata.permissions)).await { return; }
    if !app.viewers.lock().unwrap().window_list.iter().any(|w| w.id == id) {
        return close(&mut socket, GONE, "no such window").await;
    }
    let Some((preferences, mut preset, effort)) = hello(&mut socket, &key).await else { return };
    let (tx, mut rx) = mpsc::channel::<StreamMsg>(2);
    let (sink, control) = match (app.sinks)(tx) {
        Ok(x) => x,
        Err(e) => {
            tracing::warn!("window stream: {e:#}");
            return close(&mut socket, GONE, "no encoder").await;
        }
    };
    let mut selection = CodecSelection::new(&preferences, &app.codecs, control.as_ref());
    let mut quality = preset.quality(app.bitrate_kbps);
    control.set_quality(quality);
    let mut auto = AutoRate::new(quality.bitrate_kbps);
    control.set_effort(effort);
    let state = |selection: &CodecSelection, quality, preset| selection.state(&app, quality, preset, control.as_ref());
    static KEY: AtomicU64 = AtomicU64::new(1);
    let stream = KEY.fetch_add(1, Ordering::Relaxed);
    let (etx, mut erx) = mpsc::channel::<Bytes>(32);
    {
        let mut viewers = app.window_viewers.lock().unwrap();
        if !key.live() {
            drop(viewers);
            return close(&mut socket, UNAUTHORIZED, "token revoked or expired").await;
        }
        viewers.insert(stream, crate::WindowViewer { window: id, key: key.clone(), events: etx.clone() });
    }
    let replay: Vec<Bytes> = {
        let v = app.viewers.lock().unwrap();
        let role = if key.has(P::DesktopControl) { Role::Controller } else { Role::Viewer };
        [Some(protocol::session(stream | 1 << 63)), v.cursor.clone(), v.windows.clone(), v.locked.then(|| Bytes::from(vec![protocol::POINTER_LOCK, 1])), Some(protocol::role(role, 0, 0))].into_iter().flatten().collect()
    };
    for msg in replay {
        let _ = send(&mut socket, &key, msg).await;
    }
    let rtc_key = stream | 1 << 63; // the hub's sessions: desktop ids below, window streams above
    if let Some(hub) = &app.rtc {
        let _ = send(&mut socket, &key, protocol::rtc(&hub.config)).await;
    }
    let _ = send(&mut socket, &key, state(&selection, quality, preset)).await;
    let _ = key.with(&[P::DesktopView], || { let _ = app.commands.send(Command::WindowStream { key: stream, window: id, sink: Some(sink) }); Ok(()) });

    let (mut info, mut config, mut ws_config, mut seq) = (None::<elsewhere_core::StreamInfo>, Bytes::new(), None, 0u16);
    let mut pointer = None; // the last window-relative position, for the edge notice
    let mut ping = tokio::time::interval(Duration::from_secs(1));
    let (mut unanswered, started) = (0, Instant::now());
    let mut display_updates = app.display_updates.subscribe();
    display_updates.mark_changed();
    let ended = loop {
        tokio::select! {
            biased;
            _ = key.ended() => break Some((UNAUTHORIZED, "token revoked or expired")),
            changed = display_updates.changed() => {
                if changed.is_err() { break None; }
                let message = display_updates.borrow_and_update().message();
                if !send(&mut socket, &key, message).await { break None; }
            },
            msg = rx.recv() => match msg {
                Some(StreamMsg::Info(epoch, i)) => {
                    if !selection.accepts(epoch, control.as_ref()) { continue; }
                    selection.status = "streaming";
                    seq = 0;
                    config = protocol::config(&i, epoch);
                    info = Some(i);
                    if !send(&mut socket, &key, state(&selection, quality, preset)).await { break None }
                }
                Some(StreamMsg::Frame(epoch, f)) => {
                    if !selection.accepts(epoch, control.as_ref()) { continue; }
                    selection.frame(epoch, Instant::now());
                    if info.as_ref().is_some_and(|i| i.stream_id == f.stream_id) {
                        let (backlog, pressure) = (rx.len(), app.rtc.as_ref().and_then(|hub| hub.pressure(rtc_key)));
                        let t = Instant::now();
                        match (&app.rtc, pressure) {
                            (Some(hub), Some(_)) => hub.frame(rtc_key, config.clone(), protocol::video(&f, seq), quality.bitrate_kbps),
                            _ => {
                                if ws_config != Some(f.stream_id) {
                                    if !send(&mut socket, &key, config.clone()).await { break None }
                                    ws_config = Some(f.stream_id);
                                }
                                if !send(&mut socket, &key, protocol::video(&f, seq)).await { break None }
                            },
                        }
                        seq = seq.wrapping_add(1);
                        let (dropped, blocked) = pressure.unwrap_or((0, false));
                        if let Some(q) = auto.frame(backlog > 0 || blocked, dropped, t.elapsed()) {
                            quality = q;
                            control.set_quality(q);
                            if !send(&mut socket, &key, state(&selection, quality, preset)).await { break None }
                        }
                    }
                }
                Some(StreamMsg::Failed(epoch)) => {
                    if !selection.accepts(epoch, control.as_ref()) { continue; }
                    selection.failed(control.as_ref());
                    info = None;
                    if !send(&mut socket, &key, state(&selection, quality, preset)).await { break None }
                    let _ = app.commands.send(Command::RequestFullFrame);
                }
                Some(StreamMsg::Audio { .. }) => {}
                None => break Some((GONE, "window closed")), // the compositor dropped the stream: the window is gone
            },
            ev = erx.recv() => match ev {
                Some(b) => if !send(&mut socket, &key, b).await { break None },
                None => break Some((UNAUTHORIZED, "token revoked or expired")),
            },
            msg = socket.recv() => match msg {
                Some(Ok(Message::Binary(b))) => {
                    if !key.live() {
                        break Some((UNAUTHORIZED, "token revoked or expired"));
                    }
                    let decoded = protocol::decode(&b);
                    if let Some(ClientMsg::MotionAbs { x, y }) = &decoded {
                        pointer = Some((*x as f64, *y as f64));
                    }
                    // a press on the part of an X11 window past the output's edge goes nowhere: say so,
                    // through the session's own queue so the press itself isn't held back
                    if let (Some(ClientMsg::Button { pressed: true, .. }), Some((x, y))) = (&decoded, pointer)
                        && key.has(P::DesktopControl)
                        && let Some(w) = app.x11_edge_warning(id, x, y)
                    {
                        let _ = etx.try_send(protocol::notice(w));
                    }
                    let cmd = match decoded {
                        Some(ClientMsg::RequestKeyframe) => {
                            control.request_keyframe();
                            Some(Command::RequestFullFrame)
                        }
                        Some(ClientMsg::Stream(choice)) => {
                            let mut cmd = None;
                            if let Some(preferences) = &choice.codecs {
                                selection = CodecSelection::new(preferences, &app.codecs, control.as_ref());
                                cmd = Some(Command::RequestFullFrame);
                            }
                            if let Some(p) = choice.quality.as_deref().and_then(Preset::named) {
                                preset = p;
                                quality = p.quality(app.bitrate_kbps);
                                auto = AutoRate::new(quality.bitrate_kbps);
                                control.set_quality(quality);
                            }
                            if let Some(effort) = choice.effort {
                                control.set_effort(effort);
                                cmd = Some(Command::RequestFullFrame);
                            }
                            if !send(&mut socket, &key, state(&selection, quality, preset)).await { break None }
                            cmd
                        }
                        Some(ClientMsg::Rtc { g, message: v }) => {
                            match (&app.rtc, v.get("offer").and_then(|o| o.as_str())) {
                                (Some(hub), Some(sdp)) => tokio::select! { biased; _ = key.ended() => {}, _ = hub.offer(rtc_key, sdp.to_string(), g, etx.clone()) => {} },
                                (Some(hub), None) if v.get("close").and_then(|b| b.as_bool()) == Some(true) => {
                                    if hub.close_attempt(rtc_key, g).await {
                                        if !send(&mut socket, &key, protocol::rtc(&serde_json::json!({ "keyframe": true, "g": g }))).await { break None; }
                                        control.request_keyframe();
                                        let _ = app.commands.send(Command::RequestFullFrame);
                                    }
                                }
                                _ => {}
                            }
                            None
                        }
                        Some(ClientMsg::Report { delay_ms, dropped }) => {
                            auto.report(delay_ms, dropped);
                            None
                        }
                        Some(ClientMsg::Control(m)) if key.has(auth::control_permission(&m)) => app.command_for(m).ok(),
                        Some(ClientMsg::SetClipboard(text)) if key.has(P::ClipboardWrite) => Some(Command::SetClipboard { mime: api::TEXT.into(), data: text.into(), operation: None }),
                        Some(ClientMsg::PasteClipboard(msg)) => { app.paste_clipboard(&key, rtc_key, msg); None },
                        Some(ClientMsg::Control(_) | ClientMsg::SetClipboard(_)) => None,
                        Some(_) if !key.has(P::DesktopControl) => None,
                        // window-relative, resolved against the live geometry on the compositor thread
                        Some(ClientMsg::MotionAbs { x, y }) => Some(Command::Input(InputMsg::Move { x: x as f64, y: y as f64, window: Some(id) })),
                        Some(ClientMsg::Resize { css_w, css_h, .. }) => Some(Command::Control(ControlMsg { id, op: ControlOp::Resize { w: css_w as i32, h: css_h as i32 } })),
                        Some(ClientMsg::Notify(n)) => {
                            app.spawn_notification_action(key.clone(), n);
                            None
                        }
                        Some(ClientMsg::Touch { .. }) => None, // tab coordinates aren't the desktop's; the page sends fingers as a pointer here
                        Some(m) => input_command(m),
                        None => None,
                    };
                    if let Some(cmd) = cmd {
                        // under the lock a revocation clears, so nothing slips through behind one
                        let Ok(_admission) = key.admit() else { break Some((UNAUTHORIZED, "token revoked or expired")); };
                        let live = app.window_viewers.lock().unwrap();
                        if !live.contains_key(&stream) {
                            break Some((UNAUTHORIZED, "token revoked or expired"));
                        }
                        app.session_command(&key, rtc_key, cmd);
                    }
                }
                Some(Ok(Message::Pong(p))) => {
                    unanswered = 0;
                    if let Some(q) = rtt_of(&p, started).and_then(|rtt| auto.rtt(rtt)) {
                        quality = q;
                        control.set_quality(q);
                        if !send(&mut socket, &key, state(&selection, quality, preset)).await { break None }
                    }
                }
                Some(Ok(Message::Close(_))) | Some(Err(_)) | None => break None,
                _ => {}
            },
            _ = ping.tick() => {
                if !key.live() {
                    break Some((UNAUTHORIZED, "token revoked or expired")); // an idle session, which no message would end
                }
                if unanswered >= 10 || !send_message(&mut socket, &key, Message::Ping(ping_payload(started))).await {
                    break None;
                }
                unanswered += 1;
            }
        }
    };
    app.window_viewers.lock().unwrap().remove(&stream);
    if let Some(hub) = &app.rtc {
        hub.close(rtc_key).await;
    }
    let _ = app.commands.send(Command::WindowStream { key: stream, window: id, sink: None });
    app.release_input(&key, rtc_key);
    if let Some((code, reason)) = ended {
        close(&mut socket, code, reason).await;
    }
}

impl Viewers {
    pub(crate) fn role_of(&self, id: u64) -> Role {
        if self.controller == Some(id) {
            Role::Controller
        } else if self.sessions.get(&id).is_some_and(|s| s.key.has(P::DesktopControl)) {
            Role::Participant
        } else {
            Role::Viewer
        }
    }
}

impl App {
    /// A viewer's click on a notification, answered on the bus in the background.
    fn spawn_notification_action(self: &Arc<Self>, key: Key, n: protocol::NotifyMsg) {
        let app = self.clone();
        tokio::spawn(async move {
            if !key.has(P::DesktopControl) { return; }
            let _ = app.notification_action(n.id, n.action.as_deref()).await;
        });
    }

    /// What the desktop takes from the browser (`Role`'s second byte).
    pub(crate) fn features(&self, key: &Key) -> u8 {
        let cam = key.has(P::CameraSend) && self.cam.is_some() && !self.cam_dead.load(std::sync::atomic::Ordering::Relaxed);
        let audio = key.has(P::AudioListen) && self.audio_available.load(Ordering::Relaxed);
        (key.has(P::MicrophoneSend) && self.mic.as_ref().is_some_and(|tx| !tx.is_closed())) as u8 * protocol::FEATURE_MIC
            | (cam as u8) * protocol::FEATURE_CAM | (audio as u8) * protocol::FEATURE_AUDIO
    }

    /// A state message to every viewer and window session.
    /// ponytail: a session that can't keep up misses a state change (it is dropped after ten seconds anyway)
    fn broadcast_clipboard(&self, viewers: &crate::Viewers) {
        let mut metadata = viewers.clipboard.metadata(true, &viewers.clipboard_scope);
        if viewers.clipboard.mime.as_deref().is_some_and(api::text_mime) {
            if let Some(data) = viewers.clipboard.data.as_ref().filter(|data| data.len() <= api::clipboard_limit(api::TEXT)) {
                metadata["text"] = String::from_utf8_lossy(data).as_ref().into();
            }
        }
        let full = protocol::clipboard(&metadata);
        let restricted = (viewers.clipboard.mime.as_deref() == Some(api::URI_LIST))
            .then(|| protocol::clipboard(&viewers.clipboard.metadata(false, &viewers.clipboard_scope)));
        let send = |key: &Key, events: &mpsc::Sender<Bytes>| {
            if key.event_allowed(&full) {
                let packet = if key.has(P::FilesDownload) { &full } else { restricted.as_ref().unwrap_or(&full) };
                let _ = events.try_send(packet.clone());
            }
        };
        for session in viewers.sessions.values() { send(&session.key, &session.events); }
        for session in self.window_viewers.lock().unwrap().values() { send(&session.key, &session.events); }
    }

    pub(crate) fn broadcast(&self, msg: Bytes) {
        for s in self.viewers.lock().unwrap().sessions.values() {
            if s.key.event_allowed(&msg) { let _ = s.events.try_send(msg.clone()); }
        }
        for s in self.window_viewers.lock().unwrap().values() {
            if s.key.event_allowed(&msg) { let _ = s.events.try_send(msg.clone()); }
        }
    }

    fn accepts_video(&self, id: u64, epoch: u64) -> bool {
        self.viewers.lock().unwrap().sessions.get(&id).is_some_and(|s| s.selection.accepts(epoch, s.control.as_ref()))
    }

    /// The automatic controller changed a session's quality.
    fn set_quality(&self, id: u64, q: elsewhere_core::Quality) {
        if let Some(s) = self.viewers.lock().unwrap().sessions.get_mut(&id) {
            s.quality = q;
            s.control.set_quality(q);
        }
    }

    /// A desktop session's codec, quality or effort choice: whether the stream restarts, and the new preset when
    /// the quality did.
    fn apply_choice(&self, id: u64, choice: &protocol::StreamChoice) -> (bool, Option<Preset>) {
        let mut v = self.viewers.lock().unwrap();
        let Some(s) = v.sessions.get_mut(&id) else { return (false, None) };
        let mut restart = false;
        if let Some(preferences) = &choice.codecs {
            s.selection = CodecSelection::new(preferences, &self.codecs, s.control.as_ref());
            restart = true;
        }
        let preset = choice.quality.as_deref().and_then(Preset::named);
        if let Some(p) = preset {
            s.preset = p;
            s.quality = p.quality(self.bitrate_kbps);
            s.control.set_quality(s.quality);
        }
        if let Some(effort) = choice.effort {
            s.control.set_effort(effort);
            restart = true; // an effort restart also needs a fresh frame
        }
        (restart, preset)
    }

    /// What a session's encoder does right now, for the page's labels; `None` once a revocation cleared it.
    fn stream_state(&self, id: u64) -> Option<Bytes> {
        let v = self.viewers.lock().unwrap();
        let s = v.sessions.get(&id)?;
        Some(s.selection.state(self, s.quality, s.preset, s.control.as_ref()))
    }

    /// A message from a viewer session: its size always counts (the output's if it controls, its own
    /// stream's scale otherwise); input only from the controller. Window actions use their own grants;
    /// clipboard writes require clipboard.write independently of control.
    fn viewer_message(&self, id: u64, key: &Key, m: ClientMsg) {
        let Ok(_admission) = key.admit() else { return; };
        let mut v = self.viewers.lock().unwrap();
        if !v.sessions.contains_key(&id) {
            return; // a revocation cleared it under this lock; the session is about to end
        }
        let controls = v.controller == Some(id);
        let cmd = match m {
            // dpr bounds keep a bogus value from turning into a giant dmabuf allocation
            ClientMsg::Resize { css_w, css_h, dpr } if (0.5..=8.0).contains(&dpr) => {
                let geo = geometry(css_w, css_h, dpr as f64, v.output.refresh_mhz);
                if let Some(s) = v.sessions.get_mut(&id) {
                    s.size = Some(geo);
                }
                if controls && matches!(v.display.resolution, crate::display::Resolution::Auto) {
                    v.output = geo;
                    self.retarget(&v);
                    Some(Command::Resize(geo))
                } else {
                    if let Some(s) = v.sessions.get(&id) {
                        s.control.set_size((!controls).then(|| fit(&v.output, &geo)));
                    }
                    None
                }
            }
            ClientMsg::TakeControl => {
                if key.has(P::DesktopControl) {
                    self.set_controller(&mut v, Some(id));
                }
                None
            }
            ClientMsg::Handoff(target) => {
                if controls && key.has(P::DesktopControl) && v.sessions.get(&target).is_some_and(|s| s.key.has(P::DesktopControl)) {
                    self.set_controller(&mut v, Some(target));
                }
                None
            }
            ClientMsg::RequestKeyframe => {
                if let Some(s) = v.sessions.get(&id) {
                    s.control.request_keyframe();
                }
                Some(Command::RequestFullFrame)
            }
            ClientMsg::Control(m) if key.has(auth::control_permission(&m)) => self.command_for(m).ok(),
            ClientMsg::SetClipboard(text) if key.has(P::ClipboardWrite) => Some(Command::SetClipboard { mime: api::TEXT.into(), data: text.into(), operation: None }),
            ClientMsg::Drag(d) if controls && key.has(P::DragdropUpload) && key.has(P::FilesUpload) => Some(self.drag_command(key, d, &v)),
            ClientMsg::Input(m) if controls && key.has(P::DesktopControl) => Some(Command::Input(m)),
            ClientMsg::Mixer(command) if key.has(P::AudioListen) => { self.mixer_message(&mut v, id, command); None },
            ClientMsg::Mic(packet) if controls && key.has(P::MicrophoneSend) => {
                if let Some(mic) = &self.mic {
                    let _ = mic.try_send(packet); // a full queue drops the packet: the sink is behind anyway
                }
                None
            }
            ClientMsg::Cam(frame) if controls && key.has(P::CameraSend) => {
                // a VP8 frame tag's low bit is clear on a keyframe; after a drop only one of those makes sense
                let key = frame.first().is_some_and(|b| b & 1 == 0);
                if let (Some(cam), Some(s)) = (&self.cam, v.sessions.get_mut(&id))
                    && (key || !s.cam_wait_key)
                {
                    match cam.try_send(frame) {
                        Ok(()) => s.cam_wait_key = false,
                        Err(mpsc::error::TrySendError::Full(_)) => s.cam_wait_key = true,
                        Err(mpsc::error::TrySendError::Closed(_)) => {
                            // the webcam worker failed; nobody gets the button any more, this
                            // session hears why its camera does nothing
                            if !self.cam_dead.swap(true, std::sync::atomic::Ordering::Relaxed) {
                                let _ = s.events.try_send(protocol::notice("the webcam device stopped taking frames; see the server's log"));
                            }
                        }
                    }
                }
                None
            }
            m if controls && key.has(P::DesktopControl) => input_command(m),
            _ => None,
        };
        // sent under the lock: a handover's ReleaseAllInput then follows everything the old controller got in
        if let Some(cmd) = cmd {
            self.session_command(key, id, cmd);
        }
    }

    /// Hand control to `next` (none: nobody drives). Unless fixed, the desktop takes the new
    /// controller's size. Every stream is re-fitted, and the two sessions learn their roles.
    pub(crate) fn set_controller(&self, v: &mut Viewers, next: Option<u64>) {
        let old = v.controller;
        if old == next {
            return;
        }
        v.controller = next;
        v.control_epoch = v.control_epoch.wrapping_add(1);
        self.mixer_audience(v);
        // whatever the old controller held; the application asks for its pointer lock again on the new one's click
        let mut owner = self.input_owner.lock().unwrap();
        if owner.is_some_and(|(_, session)| Some(session) == old) {
            *owner = None;
            let _ = self.commands.send(Command::ReleaseAllInput);
        }
        drop(owner);
        let _ = self.commands.send(Command::ReleasePointerLock);
        // targets first, so the frame the compositor renders for the new size finds them in place
        let size = next.filter(|_| matches!(v.display.resolution, crate::display::Resolution::Auto)).and_then(|id| v.sessions.get(&id)).and_then(|s| s.size);
        if let Some(size) = size {
            v.output = size;
        }
        self.retarget(v);
        if let Some(size) = size {
            let _ = self.commands.send(Command::Resize(size));
        }
        for id in [old, next].into_iter().flatten() {
            if let Some(s) = v.sessions.get(&id) {
                let _ = s.events.try_send(protocol::role(v.role_of(id), self.features(&s.key), v.control_epoch));
            }
        }
    }

    /// Viewers' encoders scale the output to their windows. The controller receives native frames
    /// and the browser scales the canvas to fit, preserving exact logical input coordinates.
    pub(crate) fn retarget(&self, v: &Viewers) {
        for (id, s) in &v.sessions {
            if let Some(size) = s.size {
                s.control.set_size((v.controller != Some(*id)).then(|| fit(&v.output, &size)));
            }
        }
    }
}

/// Pointer, keyboard and window messages as compositor commands (the ones any driving session sends the same way).
fn input_command(m: ClientMsg) -> Option<Command> {
    Some(match m {
        ClientMsg::Input(m @ (InputMsg::Text { .. } | InputMsg::Key { .. })) => Command::Input(m),
        ClientMsg::MotionAbs { x, y } => Command::PointerMotionAbsolute { x: x as f64, y: y as f64 },
        ClientMsg::MotionRel { dx, dy } => Command::PointerMotionRelative { dx: dx as f64, dy: dy as f64 },
        ClientMsg::Button { button, pressed } => Command::PointerButton { button: button as u32, pressed },
        ClientMsg::Axis { mode: 1, dx, dy } => Command::wheel(dx as f64, dy as f64),
        // ponytail: pixel (and page) deltas go out as finger scroll with no axis_stop;
        // add a stop timer if clients need kinetic scrolling.
        ClientMsg::Axis { dx, dy, .. } => Command::PointerAxis { source: AxisSource::Finger, dx: dx as f64, dy: dy as f64, v120: None },
        ClientMsg::Key { evdev, pressed } => Command::Key { evdev: evdev as u32, pressed },
        ClientMsg::Touch { kind, id, x, y } => {
            let kind = match kind {
                0 => TouchKind::Down,
                1 => TouchKind::Motion,
                _ => TouchKind::Up,
            };
            Command::Touch { kind, slot: id as u32, x: x as f64, y: y as f64 }
        }
        ClientMsg::Blur => Command::ReleaseAllInput,
        ClientMsg::PointerLockLost => Command::ReleasePointerLock,
        ClientMsg::PointerLockGained => Command::ResumePointerLock,
        _ => return None,
    })
}

/// A ping carries when it left (ms since the session started); the pong echoes it.
fn ping_payload(started: Instant) -> Bytes {
    Bytes::copy_from_slice(&(started.elapsed().as_millis() as u64).to_le_bytes())
}

fn rtt_of(pong: &[u8], started: Instant) -> Option<Duration> {
    let sent = u64::from_le_bytes(pong.try_into().ok()?);
    Some(Duration::from_millis(started.elapsed().as_millis() as u64 - sent))
}

/// The rate controller: a viewer's quality is a ceiling, and the bitrate lives under it by what the link
/// and the browser show. A second with a third of its frames congested (encoder backlog, native SCTP write
/// refusal, channel drops or slow sends), a pong 200 ms over the link's best, or the page reporting frames
/// a hundred milliseconds later than they were or its decoder dropping some, halves the bitrate, which then
/// holds two seconds; five clean seconds raise it by a quarter. Every change is a keyframe with the VA
/// encoders (a new rate opens a new GOP), so the steps are few and large rather than many and small.
struct AutoRate {
    ceiling: u32,
    quality: elsewhere_core::Quality,
    frames: u32,
    congested: u32,
    /// Signs of a slow path this second: a late pong, the page's delay, the page's drops.
    slow: u32,
    best_rtt: Duration,
    clean_secs: u32,
    /// Seconds still to wait after a step down before the next verdict.
    hold: u32,
    window: Instant,
}

impl AutoRate {
    fn new(ceiling: u32) -> AutoRate {
        AutoRate { ceiling, quality: elsewhere_core::Quality { bitrate_kbps: ceiling, max_fps: if ceiling < 3000 { 30 } else { 0 } }, frames: 0, congested: 0, slow: 0, best_rtt: Duration::MAX, clean_secs: 0, hold: 0, window: Instant::now() }
    }

    /// One frame went out; `queued` reports encoder backlog or native SCTP write refusal, and the send took `took`.
    fn frame(&mut self, queued: bool, dropped: u32, took: Duration) -> Option<elsewhere_core::Quality> {
        self.frames += 1;
        if queued || dropped > 0 || took > Duration::from_millis(33) {
            self.congested += 1;
        }
        self.evaluate()
    }

    /// A ping was answered after `rtt`.
    fn rtt(&mut self, rtt: Duration) -> Option<elsewhere_core::Quality> {
        self.best_rtt = self.best_rtt.min(rtt);
        if rtt > self.best_rtt + Duration::from_millis(200) {
            self.slow += 1;
        }
        self.evaluate()
    }

    /// The page's second: how much later its frames arrived than at their best lately, and how many it dropped.
    fn report(&mut self, delay_ms: u16, dropped: u16) {
        if delay_ms > 100 || dropped > 0 {
            self.slow += 1;
        }
    }

    /// Once a second: step the quality by what the second showed.
    fn evaluate(&mut self) -> Option<elsewhere_core::Quality> {
        if self.window.elapsed() < Duration::from_secs(1) {
            return None;
        }
        let (frames, congested, slow) = (std::mem::take(&mut self.frames), std::mem::take(&mut self.congested), std::mem::take(&mut self.slow));
        self.window = Instant::now();
        tracing::debug!(frames, congested, slow, kbps = self.quality.bitrate_kbps, "auto quality: a second of frames");
        if self.hold > 0 {
            self.hold -= 1; // the step before is still taking effect
            return None;
        }
        let mut q = self.quality;
        if congested * 3 > frames || slow > 0 {
            self.clean_secs = 0;
            q.bitrate_kbps = (q.bitrate_kbps / 2).max(1000.min(self.ceiling));
            self.hold = 2;
        } else if frames > 0 {
            self.clean_secs += 1;
            if self.clean_secs >= 5 && q.bitrate_kbps < self.ceiling {
                q.bitrate_kbps = (u64::from(q.bitrate_kbps) * 5 / 4).min(u64::from(self.ceiling)) as u32;
                self.clean_secs = 0;
            }
        }
        q.max_fps = if q.bitrate_kbps < 3000 { 30 } else { 0 };
        (q != self.quality).then(|| {
            self.quality = q;
            q
        })
    }
}


/// CSS size × devicePixelRatio, rounded down to even (4:2:0 encoders), capped at 8K.
fn geometry(css_w: u16, css_h: u16, dpr: f64, refresh_mhz: i32) -> OutputGeometry {
    let px = |css: u16| (((css as f64 * dpr).round() as u32).min(8192) & !1).max(2);
    OutputGeometry { width_px: px(css_w), height_px: px(css_h), scale: dpr, refresh_mhz }
}

/// The output scaled to fit a viewer's window (never up), even-sized for the encoders.
fn fit(output: &OutputGeometry, stage: &OutputGeometry) -> (u32, u32) {
    let k = (stage.width_px as f64 / output.width_px as f64).min(stage.height_px as f64 / output.height_px as f64).min(1.0);
    let even = |px: f64| ((px.round() as u32) & !1).max(2);
    (even(output.width_px as f64 * k), even(output.height_px as f64 * k))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(Default)]
    struct Control { epoch: AtomicU64, codec: std::sync::Mutex<Option<Codec>> }
    impl StreamControl for Control {
        fn set_codec(&self, codec: Codec) { *self.codec.lock().unwrap() = Some(codec); self.epoch.fetch_add(1, Ordering::Relaxed); }
        fn epoch(&self) -> u64 { self.epoch.load(Ordering::Relaxed) }
        fn pause(&self) { *self.codec.lock().unwrap() = None; self.epoch.fetch_add(1, Ordering::Relaxed); }
        fn request_keyframe(&self) {}
        fn set_size(&self, _: Option<(u32, u32)>) {}
        fn set_quality(&self, _: elsewhere_core::Quality) {}
        fn set_effort(&self, _: EncodingEffort) {}
        fn effort(&self) -> elsewhere_core::EffortState { elsewhere_core::EffortState::pending(EncodingEffort::Fast) }
    }

    #[test]
    fn codec_recovery_respects_order_attempts_and_stability() {
        let control = Control::default();
        let supported = [Codec::H264, Codec::Hevc];
        let mut selection = CodecSelection::new(&[Codec::Vp8, Codec::Hevc, Codec::Hevc, Codec::H264], &supported, &control);
        assert_eq!(selection.candidates, [Codec::Hevc, Codec::H264]);
        let old = control.epoch();
        selection.failed(&control);
        assert_eq!(selection.codec(), Some(Codec::Hevc));
        assert!(!selection.accepts(old, &control));
        let now = Instant::now();
        selection.frame(control.epoch(), now);
        selection.failed(&control); // a recovery keyframe did not erase the first failure
        assert_eq!(selection.codec(), Some(Codec::H264));
        selection.failed(&control);
        for _ in 0..120 { selection.frame(control.epoch(), now); }
        assert_eq!(selection.failures, 1); // enough frames but not enough time
        selection.frame(control.epoch(), now + Duration::from_secs(2));
        assert_eq!(selection.failures, 0);
        selection.failed(&control);
        assert_eq!(selection.codec(), Some(Codec::H264));
        selection.frame(control.epoch(), now);
        selection.frame(control.epoch(), now + Duration::from_secs(10));
        assert_eq!(selection.failures, 1); // a static desktop has not earned a reset
        control.epoch.fetch_add(1, Ordering::Relaxed); // quality/size reopens start a fresh stability window
        selection.frame(control.epoch(), now + Duration::from_secs(20));
        assert_eq!(selection.frames, 1);
        selection.failed(&control);
        assert_eq!(selection.codec(), None);
        assert_eq!(*control.codec.lock().unwrap(), None);
        assert!(!selection.accepts(control.epoch(), &control));
        let stale = control.epoch();
        selection = CodecSelection::new(&[Codec::Hevc, Codec::H264], &supported, &control);
        assert_eq!(selection.codec(), Some(Codec::Hevc));
        assert_eq!(selection.failures, 0);
        assert!(!selection.accepts(stale, &control));
        assert!(selection.accepts(control.epoch(), &control));
        let other = Control::default();
        let other_selection = CodecSelection::new(&[Codec::H264], &supported, &other);
        selection.failed(&control);
        assert_eq!(other_selection.failures, 0);
        assert_eq!(other_selection.codec(), Some(Codec::H264));
        assert!(CodecSelection::new(&[], &supported, &control).codec().is_none());
        assert!(CodecSelection::new(&[Codec::Vp8], &supported, &control).codec().is_none());
    }

    /// One second of `n` frames, `bad` of them congested, evaluated at its end.
    fn second(a: &mut AutoRate, n: u32, bad: u32) -> Option<elsewhere_core::Quality> {
        let mut changed = None;
        for i in 0..n {
            if i == n - 1 {
                a.window = Instant::now() - Duration::from_secs(2); // the window is over with this frame
            }
            changed = a.frame(i < bad, 0, Duration::ZERO).or(changed);
        }
        changed
    }

    #[test]
    fn every_quality_recovers_to_its_ceiling() {
        for medium in [500, 2500, 3000, 8000, 40000, u32::MAX] {
            for (preset, _) in Preset::NAMES {
                let ceiling = preset.quality(medium);
                let mut rate = AutoRate::new(ceiling.bitrate_kbps);
                assert_eq!(rate.quality, ceiling);
                for _ in 0..100 {
                    second(&mut rate, 1, 1);
                }
                assert_eq!(rate.quality.bitrate_kbps, 1000.min(ceiling.bitrate_kbps));
                for _ in 0..600 {
                    second(&mut rate, 1, 0);
                    assert!(rate.quality.bitrate_kbps <= ceiling.bitrate_kbps);
                    assert_eq!(rate.quality.max_fps, if rate.quality.bitrate_kbps < 3000 { 30 } else { 0 });
                }
                assert_eq!(rate.quality, ceiling);
            }
        }
    }

    #[test]
    fn auto_rate_backs_off_and_recovers() {
        let mut a = AutoRate::new(8000);
        assert_eq!(second(&mut a, 60, 30).unwrap().bitrate_kbps, 4000); // half the frames waited: halved
        assert!(second(&mut a, 60, 30).is_none()); // the two seconds after a step are the step's own
        assert!(second(&mut a, 60, 30).is_none());
        assert!(second(&mut a, 60, 10).is_none()); // a sixth: fine
        // five clean seconds climb a quarter; the sixth waits again
        for _ in 0..3 {
            assert!(second(&mut a, 60, 0).is_none());
        }
        assert_eq!(second(&mut a, 60, 0).unwrap().bitrate_kbps, 5000);
        assert!(second(&mut a, 60, 0).is_none());
        // the floor and the frame cap under 3 Mbit/s
        let mut a = AutoRate::new(2000);
        let q = second(&mut a, 1, 1).unwrap();
        assert_eq!((q.bitrate_kbps, q.max_fps), (1000, 30));
        // a pong slower than the link's best by 200 ms congests the second on its own; a steady slow link doesn't
        let mut a = AutoRate::new(8000);
        a.rtt(Duration::from_millis(300));
        a.window = Instant::now() - Duration::from_secs(2);
        assert!(a.rtt(Duration::from_millis(320)).is_none());
        a.window = Instant::now() - Duration::from_secs(2);
        assert_eq!(a.rtt(Duration::from_millis(600)).unwrap().bitrate_kbps, 4000);
        // the page's word counts the same: frames a hundred milliseconds later than they were, or dropped
        let mut a = AutoRate::new(8000);
        a.report(50, 0);
        assert!(second(&mut a, 60, 0).is_none());
        a.report(0, 1);
        assert_eq!(second(&mut a, 60, 0).unwrap().bitrate_kbps, 4000);
        // the floor never passes a low ceiling: nothing to step down to
        let mut a = AutoRate::new(500);
        assert!(second(&mut a, 1, 1).is_none());
        assert_eq!((a.quality.bitrate_kbps, a.quality.max_fps), (500, 30));
    }
}

fn is_input(command: &Command) -> bool {
    matches!(command, Command::Input(_) | Command::Key { .. } | Command::PointerMotionRelative { .. } | Command::PointerMotionAbsolute { .. } | Command::PointerButton { .. } | Command::PointerAxis { .. } | Command::Touch { .. })
}

impl App {
    fn session_command(&self, key: &Key, session: u64, command: Command) {
        if matches!(command, Command::ReleaseAllInput) { self.release_input(key, session); return; }
        if is_input(&command) { let _ = self.send_input(key, session, command); }
        else { let _ = self.commands.send(command); }
    }
}
