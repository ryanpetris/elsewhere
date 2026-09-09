//! WebRTC data-channel transport for the video: the same messages the WebSocket carries, over a `video`
//! data channel the browser opens (ordered, reliable), for viewers who need UDP to reach the desktop
//! at all: through NAT, or through a TURN relay. It is a viewer's choice, not the default, because the
//! socket carries the picture better under packet loss (see `docs/stream-reliability.md`). str0m does ICE (lite,
//! host candidates), DTLS and SCTP without I/O of its own; one hub task drives every session's peer
//! connection over one UDP socket per local address (a received packet's destination must be one of the
//! candidates, so a socket per address knows it). Signalling goes over the session's WebSocket (`RTC`
//! messages: the browser's offer, our answer). The UI applies its endpoint to the answer's candidates;
//! the frame path in `ws.rs` hands frames to the hub while
//! the session's channel is open and to the socket otherwise. A frame goes as numbered fragments the page
//! reassembles, admitted one fragment at a time at a rate derived from the stream target. The SCTP
//! send buffer (128 kB, freed by the browser's acknowledgements) must also have room. A refused write
//! is congestion to the session's rate controller; waiting for the pacing timer is not. A keyframe replaces whatever waits (the page needs it
//! whatever else it gets, and a keyframe behind a queue on a lossy link is a stall of seconds; what was
//! written of the frame in flight still has to go out), and a frame arriving at a full queue is dropped
//! rather than waiting longer; either can leave a sequence gap. A delta after a gap makes the page
//! request a keyframe. Configuration
//! precedes each key on the same ordered channel, so accepted older video cannot cross a decoder change. A fragment
//! on its way is retransmitted if it is lost, so what the page misses is what was dropped here, never
//! what the network ate.

use std::{
    collections::{HashMap, VecDeque},
    net::{IpAddr, SocketAddr},
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

use anyhow::{Context, Result};
use elsewhere_core::Bytes;
use str0m::{Candidate, Event, Input, Output, Rtc, change::SdpOffer, channel::ChannelId, net::{Protocol, Receive}};
use tokio::{net::UdpSocket, sync::{mpsc, oneshot}};

use crate::protocol;

/// Fragments of this size go down the channel: every browser takes them, and a lost one is retransmitted.
const FRAGMENT: usize = 16 * 1024;

/// What the CLI decided: the UDP port, the address to advertise, and the ICE servers the browser should use.
pub struct Config {
    pub port: u16,
    /// The one address browsers reach us at, when it isn't ours (a Docker bridge maps the host's port to
    /// the container); the viewer uses this address when applying the ICE answer.
    pub addr: Option<IpAddr>,
    /// STUN and TURN servers as the page's `RTCPeerConnection` wants them (`urls`, `username`, `credential`).
    pub ice_servers: Vec<serde_json::Value>,
}

enum Msg {
    /// A session's browser offered (`g` numbers its attempt; the answer carries it back through `reply`,
    /// the session's own event queue).
    Offer { session: u64, sdp: String, g: u64, reply: mpsc::Sender<Bytes> },
    /// A frame for a session's channel.
    Frame { session: u64, config: Bytes, data: Bytes, bitrate_kbps: u32 },
    /// The session ended, or went back to its socket.
    Close { session: u64, g: Option<u64>, reply: Option<oneshot::Sender<bool>> },
}

/// A session's way to the hub; cheap to clone.
#[derive(Clone)]
pub struct Hub {
    tx: mpsc::Sender<Msg>,
    /// Channel claims and pressure. Closed claims remain until acknowledged, so even a pending
    /// browser attempt that missed its final frame can request a refresh.
    open: Arc<Open>,
    pub config: serde_json::Value,
}

impl Hub {
    /// Binds the port on every local address (or on any, advertised as `cfg.addr`) and starts the hub task.
    pub async fn start(cfg: Config) -> Result<Hub> {
        let mut sockets = HashMap::new();
        match cfg.addr {
            Some(ip) => {
                let any = if ip.is_ipv4() { IpAddr::from([0, 0, 0, 0]) } else { IpAddr::from([0u16; 8]) };
                sockets.insert(SocketAddr::new(ip, cfg.port), Arc::new(UdpSocket::bind(SocketAddr::new(any, cfg.port)).await?));
            }
            None => {
                for ip in local_ips() {
                    let addr = SocketAddr::new(ip, cfg.port);
                    match UdpSocket::bind(addr).await {
                        Ok(s) => {
                            sockets.insert(addr, Arc::new(s));
                        }
                        Err(e) => tracing::warn!("WebRTC: can't listen on {addr}: {e}"),
                    }
                }
            }
        }
        anyhow::ensure!(!sockets.is_empty(), "no local address to listen on");
        let (tx, rx) = mpsc::channel(256);
        let mut config = serde_json::json!({ "ice_servers": cfg.ice_servers, "port": cfg.port });
        if let Some(addr) = cfg.addr { config["host"] = serde_json::json!(addr); }
        let hub = Hub { tx, open: Default::default(), config };
        tokio::spawn(run(sockets, rx, hub.open.clone()));
        tracing::info!(port = cfg.port, "WebRTC: data channels on UDP");
        Ok(hub)
    }

    /// Frames rejected by full queues since the last call and whether the native send buffer refused a write.
    pub fn pressure(&self, session: u64) -> Option<(u32, bool)> {
        self.open.lock().unwrap().get_mut(&session).filter(|c| c.active).map(|c| (std::mem::take(&mut c.dropped), c.blocked))
    }

    /// Signalling waits for room in the queue: an offer without an answer, or a close that never arrives,
    /// would be a stuck viewer or a lingering peer.
    pub async fn offer(&self, session: u64, sdp: String, g: u64, reply: mpsc::Sender<Bytes>) {
        let _ = self.tx.send(Msg::Offer { session, sdp, g, reply }).await;
    }

    /// A frame for the session's channel; one that doesn't fit the hub's mailbox is dropped (the page asks
    /// for a keyframe when it sees the gap).
    pub fn frame(&self, session: u64, config: Bytes, data: Bytes, bitrate_kbps: u32) {
        if self.tx.try_send(Msg::Frame { session, config, data, bitrate_kbps }).is_err() {
            dropped(&self.open, session, 1);
        }
    }

    /// Releases only the named attempt, returning whether it held video and needs a refresh.
    /// Delayed client closes cannot remove its successor.
    pub async fn close_attempt(&self, session: u64, g: u64) -> bool {
        let (reply, rx) = oneshot::channel();
        let _ = self.tx.send(Msg::Close { session, g: Some(g), reply: Some(reply) }).await;
        rx.await.unwrap_or(false)
    }

    pub async fn close(&self, session: u64) {
        let _ = self.tx.send(Msg::Close { session, g: None, reply: None }).await;
    }
}

/// Include loopback for viewers opened locally. Link-local IPv6 needs an interface scope.
fn local_ips() -> Vec<IpAddr> {
    if_addrs::get_if_addrs()
        .unwrap_or_default()
        .into_iter()
        .map(|i| i.ip())
        .filter(|ip| !matches!(ip, IpAddr::V6(v6) if v6.is_unicast_link_local()))
        .collect()
}

struct Peer {
    rtc: Rtc,
    channel: Option<ChannelId>,
    /// Numbers the fragmented messages, so the page can tell one frame's fragments from the next's.
    frame_id: u32,
    /// Configuration and video waiting for the send buffer, the front message `sent` fragments in.
    queue: VecDeque<Bytes>,
    /// Latest configuration admitted to the ordered channel, including its stream ID.
    config: Option<Bytes>,
    sent: usize,
    front_since: Instant,
    progress: SendProgress,
    pacer: Pacer,
    /// The session's socket and the offer's number, for the word that the channel is given up.
    reply: mpsc::Sender<Bytes>,
    g: u64,
    close_reason: &'static str,
}

/// A frame waiting this long, or pending SCTP bytes without acknowledgements this long, gives the
/// video back to the socket.
const STALL: Duration = Duration::from_secs(3);

struct Pacer {
    next: Instant,
    bitrate_kbps: u32,
}

impl Pacer {
    fn new(now: Instant) -> Self { Self { next: now, bitrate_kbps: 1 } }
    fn ready(&self, now: Instant) -> bool { now >= self.next }
    fn sent(&mut self, bytes: usize, now: Instant) {
        // Allow 25% above the stream target, charging 10% for wire overhead: 1.10 / 1.25 = 22/25.
        // One fragment is the entire burst allowance; idle time never accumulates credit.
        let nanos = (bytes as u64 * 8 * 1_000_000 * 22).div_ceil(u64::from(self.bitrate_kbps.max(1)) * 25);
        self.next = now + Duration::from_nanos(nanos);
    }
}

#[derive(Default)]
struct SendProgress {
    buffered: usize,
    since: Option<Instant>,
}

impl SendProgress {
    /// str0m's reliable SCTP buffer releases bytes on acknowledgement. Appending or replacing
    /// application frames cannot prove transport progress, including a new encoder's keyframe.
    fn observe(&mut self, buffered: usize, queued: bool, now: Instant) {
        if buffered < self.buffered { self.since = Some(now); }
        if buffered != 0 || queued {
            self.since.get_or_insert(now);
        } else {
            self.since = None;
        }
        self.buffered = buffered;
    }
}

/// Frames a channel's queue holds before a new one is dropped: half a second at 60 fps.
// ponytail: a cap; blocking the session as the socket does if a viewer wants the latency bounded tighter
const QUEUE: usize = 30;

/// The latest channel claim, with live queue pressure or an inactive claim awaiting close acknowledgement.
struct Claim {
    g: u64,
    active: bool,
    dropped: u32,
    blocked: bool,
}
type Open = Mutex<HashMap<u64, Claim>>;

/// One datagram in: the candidate address it came to, from where, the bytes.
type Datagram = (SocketAddr, SocketAddr, Vec<u8>);

async fn run(sockets: HashMap<SocketAddr, Arc<UdpSocket>>, mut rx: mpsc::Receiver<Msg>, open: Arc<Open>) {
    let (dtx, mut drx) = mpsc::channel::<Datagram>(1024);
    for (addr, socket) in &sockets {
        let (addr, socket, dtx) = (*addr, socket.clone(), dtx.clone());
        tokio::spawn(async move {
            let mut buf = vec![0u8; 2000];
            while let Ok((n, source)) = socket.recv_from(&mut buf).await {
                if dtx.send((addr, source, buf[..n].to_vec())).await.is_err() {
                    break;
                }
            }
        });
    }
    let addrs: Vec<SocketAddr> = sockets.keys().copied().collect();
    let mut peers: HashMap<u64, Peer> = HashMap::new();
    loop {
        // every change to an Rtc is followed by draining its output, down to when it next wants a timeout;
        // a frame waiting for room in the send buffer goes on first (acknowledgements came in as datagrams)
        let mut deadline = Instant::now() + Duration::from_secs(1);
        for (id, peer) in peers.iter_mut() {
            if let Some(paced) = flush(peer, &open, *id) { deadline = deadline.min(paced); }
            if (!peer.queue.is_empty() && peer.front_since.elapsed() >= STALL)
                || peer.progress.since.is_some_and(|since| since.elapsed() >= STALL)
            {
                tracing::info!(session = id, "WebRTC: video delivery stalled for {STALL:?}; the socket takes the video");
                peer.close_reason = "Server queue stalled";
                peer.rtc.disconnect(); // and the peer goes below, with its channel's claim on the frames
            }
            if let Some(since) = peer.progress.since { deadline = deadline.min(since + STALL); }
            loop {
                match peer.rtc.poll_output() {
                    Ok(Output::Timeout(t)) => {
                        deadline = deadline.min(t);
                        break;
                    }
                    Ok(Output::Transmit(t)) => {
                        let socket = sockets.get(&t.source).or_else(|| sockets.values().next()).unwrap();
                        let _ = socket.send_to(&t.contents, t.destination).await;
                    }
                    Ok(Output::Event(e)) => event(*id, peer, e, &open),
                    Err(e) => {
                        tracing::warn!(session = id, "WebRTC: {e}");
                        peer.rtc.disconnect();
                        break;
                    }
                }
            }
        }
        peers.retain(|id, p| {
            let alive = p.rtc.is_alive();
            if !alive {
                if let Some(claim) = open.lock().unwrap().get_mut(id) { claim.active = false; }
                let _ = notify_closed(p.reply.clone(), p.g, p.close_reason);
                tracing::debug!(session = id, "WebRTC: peer connection over");
            }
            alive
        });
        tokio::select! {
            Some((destination, source, bytes)) = drx.recv() => {
                let Ok(contents) = bytes.as_slice().try_into() else { continue };
                let input = Input::Receive(Instant::now(), Receive { proto: Protocol::Udp, source, destination, contents });
                if let Some(peer) = peers.values_mut().find(|p| p.rtc.accepts(&input))
                    && let Err(e) = peer.rtc.handle_input(input)
                {
                    tracing::debug!("WebRTC: {e}");
                }
            }
            _ = tokio::time::sleep_until(deadline.into()) => {
                let now = Instant::now();
                for peer in peers.values_mut() {
                    let _ = peer.rtc.handle_input(Input::Timeout(now));
                }
            }
            msg = rx.recv() => match msg {
                Some(Msg::Offer { session, sdp, g, reply }) => {
                    peers.remove(&session);
                    open.lock().unwrap().remove(&session);
                    match answer(&sdp, g, &addrs, reply.clone()) {
                        Ok(peer) => {
                            peers.insert(session, peer); // a second offer replaces the first connection
                        }
                        Err(e) => {
                            tracing::warn!(session, "WebRTC offer refused: {e:#}");
                            let _ = reply.try_send(protocol::rtc(&serde_json::json!({ "close": true, "g": g, "reason": "Offer rejected" })));
                        }
                    }
                }
                Some(Msg::Frame { session, config, data, bitrate_kbps }) => {
                    if let Some(peer) = peers.get_mut(&session) && peer.channel.is_some() {
                        // New targets affect future charges; keys and encoder restarts retain pacing debt.
                        peer.pacer.bitrate_kbps = bitrate_kbps;
                        dropped(&open, session, enqueue(peer, config, data));
                        let _ = flush(peer, &open, session);
                    }
                }
                Some(Msg::Close { session, g, reply }) => {
                    let mut claims = open.lock().unwrap();
                    let claimed = claims.get(&session).is_some_and(|c| g.is_none() || g == Some(c.g));
                    if g.is_none() || peers.get(&session).is_some_and(|p| g == Some(p.g)) {
                        peers.remove(&session);
                    }
                    if claimed { claims.remove(&session); }
                    if let Some(reply) = reply { let _ = reply.send(claimed); }
                }
                None => return,
            },
        }
    }
}

/// ICE lite uses local candidates. The viewer applies its endpoint to the answer sent through `reply`.
fn answer(sdp: &str, g: u64, addrs: &[SocketAddr], reply: mpsc::Sender<Bytes>) -> Result<Peer> {
    let offer = SdpOffer::from_sdp_string(sdp).context("offer")?;
    let mut rtc = Rtc::builder().set_ice_lite(true).set_stats_interval(None).build(Instant::now());
    for addr in addrs {
        if let Ok(c) = Candidate::host(*addr, "udp") {
            rtc.add_local_candidate(c);
        }
    }
    let answer = rtc.sdp_api().accept_offer(offer).context("accept offer")?.to_sdp_string();
    let _ = reply.try_send(protocol::rtc(&serde_json::json!({ "answer": answer, "g": g })));
    Ok(Peer { rtc, channel: None, frame_id: 0, queue: VecDeque::new(), config: None, sent: 0, front_since: Instant::now(), progress: SendProgress::default(), pacer: Pacer::new(Instant::now()), reply, g, close_reason: "Peer connection closed" })
}

fn event(session: u64, peer: &mut Peer, e: Event, open: &Open) {
    match e {
        Event::ChannelOpen(cid, label) => {
            tracing::info!(session, label, "WebRTC: data channel open");
            peer.channel = Some(cid);
            open.lock().unwrap().insert(session, Claim { g: peer.g, active: true, dropped: 0, blocked: false });
        }
        Event::ChannelClose(cid) => {
            if peer.channel == Some(cid) {
                peer.channel = None;
                peer.queue.clear();
                peer.sent = 0;
                if let Some(claim) = open.lock().unwrap().get_mut(&session) { claim.active = false; }
            }
        }
        Event::IceConnectionStateChange(state) => {
            tracing::debug!(session, ?state, "WebRTC: ICE");
            if state == str0m::IceConnectionState::Disconnected {
                peer.rtc.disconnect(); // the UDP path died: frames go back to the socket at once, not when the browser gives up
            }
        }
        _ => {}
    }
}

fn dropped(open: &Open, session: u64, count: u32) {
    if let Some(claim) = open.lock().unwrap().get_mut(&session) {
        claim.dropped += count;
    }
}

/// A full session event queue must not lose the notice that gives video back to the socket.
/// This task retains no peer or video buffers and ends when the session drains or drops its receiver.
fn notify_closed(reply: mpsc::Sender<Bytes>, g: u64, reason: &'static str) -> tokio::task::JoinHandle<()> {
    let message = protocol::rtc(&serde_json::json!({ "close": true, "g": g, "reason": reason }));
    tokio::spawn(async move { let _ = reply.send(message).await; })
}

/// Configuration and video share the channel's order. Every new configuration and every key replaces
/// unsent video, with its configuration first. A delta can announce a new configuration if the hub's
/// mailbox dropped its first key; the browser then requests another key from the correct stream.
/// Only rejection by a full queue reports congestion. Replacing video with a recovery key does not.
fn enqueue(peer: &mut Peer, config: Bytes, data: Bytes) -> u32 {
    let boundary = peer.config.as_ref() != Some(&config) || data.get(1).is_some_and(|flags| flags & 1 != 0);
    if boundary {
        peer.queue.clear();
        peer.sent = 0;
        peer.frame_id = peer.frame_id.wrapping_add(1);
        peer.front_since = Instant::now();
        peer.queue.push_back(config.clone());
        peer.config = Some(config);
    }
    if peer.queue.iter().filter(|message| message.first() == Some(&protocol::VIDEO)).count() >= QUEUE {
        return 1;
    }
    if peer.queue.is_empty() { peer.front_since = Instant::now(); }
    peer.queue.push_back(data);
    0
}

/// The queue's frames, front first, as fragments `[FRAGMENT][u32 id][u16 index][u16 count]` then the bytes,
/// at their pacing deadlines while the send buffer takes them; the rest waits for the next round.
fn flush(peer: &mut Peer, open: &Open, session: u64) -> Option<Instant> {
    let buffered = peer.channel.and_then(|cid| peer.rtc.channel(cid)).map_or(0, |mut channel| channel.buffered_amount());
    let acknowledged = buffered < peer.progress.buffered;
    peer.progress.observe(buffered, !peer.queue.is_empty(), Instant::now());
    let mut blocked = false;
    let mut deadline = None;
    let mut msg = Vec::with_capacity(FRAGMENT + 9);
    'frames: while let (Some(cid), Some(data)) = (peer.channel, peer.queue.front()) {
        let count = data.chunks(FRAGMENT).count();
        while peer.sent < count {
            if !peer.pacer.ready(Instant::now()) { deadline = Some(peer.pacer.next); break 'frames; }
            let chunk = &data[peer.sent * FRAGMENT..data.len().min((peer.sent + 1) * FRAGMENT)];
            msg.clear();
            msg.push(protocol::FRAGMENT);
            msg.extend_from_slice(&peer.frame_id.to_le_bytes());
            msg.extend_from_slice(&(peer.sent as u16).to_le_bytes());
            msg.extend_from_slice(&(count as u16).to_le_bytes());
            msg.extend_from_slice(chunk);
            let Some(mut channel) = peer.rtc.channel(cid) else { break 'frames };
            match channel.write(true, &msg) {
                Ok(true) => {
                    peer.sent += 1;
                    peer.pacer.sent(msg.len(), Instant::now());
                }
                Ok(false) | Err(_) => { blocked = true; break 'frames; }
            }
        }
        peer.queue.pop_front();
        peer.sent = 0;
        peer.front_since = Instant::now();
        peer.frame_id = peer.frame_id.wrapping_add(1);
    }
    let buffered = peer.channel.and_then(|cid| peer.rtc.channel(cid)).map_or(0, |mut channel| channel.buffered_amount());
    peer.progress.observe(buffered, !peer.queue.is_empty(), Instant::now());
    if let Some(claim) = open.lock().unwrap().get_mut(&session) {
        if acknowledged { claim.blocked = false; }
        if blocked { claim.blocked = true; }
    }
    tracing::trace!(session, queued_frames = peer.queue.iter().filter(|message| message.first() == Some(&protocol::VIDEO)).count(),
        queued_bytes = peer.queue.iter().map(|frame| frame.len()).sum::<usize>(),
        sent_bytes = peer.queue.front().map_or(0, |frame| (peer.sent * FRAGMENT).min(frame.len())),
        front_age_ms = if peer.queue.is_empty() { 0 } else { peer.front_since.elapsed().as_millis() as u64 },
        transport_pending_bytes = buffered,
        target_kbps = peer.pacer.bitrate_kbps,
        native_write_blocked = blocked,
        pacing_wait_us = peer.pacer.next.saturating_duration_since(Instant::now()).as_micros() as u64,
        progress_age_ms = peer.progress.since.map_or(0, |since| since.elapsed().as_millis() as u64),
        "RTC output queue");
    deadline
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn close_notice_survives_full_events_and_ends_with_the_session() {
        let (reply, mut events) = mpsc::channel(1);
        reply.send(Bytes::from_static(b"full")).await.unwrap();
        let notice = notify_closed(reply.clone(), 7, "Server queue stalled");
        tokio::task::yield_now().await;
        assert!(!notice.is_finished());
        assert_eq!(events.recv().await.unwrap(), Bytes::from_static(b"full"));
        let message = tokio::time::timeout(Duration::from_millis(100), events.recv()).await.unwrap().unwrap();
        assert_eq!(message, protocol::rtc(&serde_json::json!({ "close": true, "g": 7, "reason": "Server queue stalled" })));
        notice.await.unwrap();

        reply.send(Bytes::from_static(b"full")).await.unwrap();
        let notice = notify_closed(reply, 8, "Peer connection closed");
        tokio::task::yield_now().await;
        assert!(!notice.is_finished());
        drop(events);
        tokio::time::timeout(Duration::from_millis(100), notice).await.unwrap().unwrap();
    }

    #[test]
    fn configuration_survives_missing_keys_replacement_and_video_pressure() {
        let now = Instant::now();
        let (reply, _events) = mpsc::channel(1);
        let mut peer = Peer {
            rtc: Rtc::builder().build(now), channel: None, frame_id: 0, queue: VecDeque::new(), config: None,
            sent: 0, front_since: now, progress: SendProgress { buffered: 100, since: Some(now) },
            pacer: Pacer::new(now), reply, g: 1, close_reason: "Peer connection closed",
        };
        peer.pacer.next = now + Duration::from_secs(1);
        let config = Bytes::from_static(b"\x01config");
        let delta = Bytes::from_static(&[protocol::VIDEO, 0]);
        let key = Bytes::from_static(&[protocol::VIDEO, 1]);

        // A full hub mailbox can lose the first key; the next admitted delta still announces its configuration.
        let (tx, mut rx) = mpsc::channel(1);
        let hub = Hub { tx, open: Default::default(), config: serde_json::json!({}) };
        hub.open.lock().unwrap().insert(1, Claim { g: 1, active: true, dropped: 0, blocked: false });
        assert!(hub.tx.try_send(Msg::Close { session: 1, g: None, reply: None }).is_ok());
        hub.frame(1, config.clone(), key.clone(), 8000);
        assert_eq!(hub.pressure(1), Some((1, false)));
        assert_eq!(hub.pressure(1), Some((0, false)));
        rx.try_recv().unwrap();
        hub.frame(1, config.clone(), delta.clone(), 8000);
        let Msg::Frame { config: delivered, data, .. } = rx.try_recv().unwrap() else { panic!("frame expected") };
        assert_eq!(enqueue(&mut peer, delivered, data), 0);
        assert_eq!(peer.queue, VecDeque::from([config.clone(), delta.clone()]));
        for _ in 1..QUEUE { assert_eq!(enqueue(&mut peer, config.clone(), delta.clone()), 0); }
        assert_eq!(peer.queue.len(), QUEUE + 1);
        dropped(&hub.open, 1, enqueue(&mut peer, config.clone(), delta));
        hub.open.lock().unwrap().get_mut(&1).unwrap().blocked = true;

        assert_eq!(enqueue(&mut peer, config.clone(), key.clone()), 0);
        assert_eq!(peer.queue, VecDeque::from([config.clone(), key.clone()]));
        // A repeated key carries configuration even after the previous copy entered SCTP.
        peer.queue.pop_front();
        peer.sent = 1;
        assert_eq!(enqueue(&mut peer, config.clone(), key.clone()), 0);
        assert_eq!(peer.queue, VecDeque::from([config, key.clone()]));
        let next_config = Bytes::from_static(b"\x01next config");
        assert_eq!(enqueue(&mut peer, next_config.clone(), key.clone()), 0);
        assert_eq!(peer.queue, VecDeque::from([next_config, key]));
        // Recovery preserves genuine pressure already observed by either queue or the native writer.
        assert_eq!(hub.pressure(1), Some((1, true)));
        assert_eq!(hub.pressure(1), Some((0, true)));
        assert_eq!(peer.sent, 0);
        assert_eq!(peer.pacer.next, now + Duration::from_secs(1));
        assert_eq!(peer.progress.since, Some(now));
    }

    #[test]
    fn fragments_are_paced_without_idle_credit_or_target_reset() {
        let now = Instant::now();
        let mut pacer = Pacer::new(now);
        pacer.bitrate_kbps = 8000;
        assert!(pacer.ready(now));
        pacer.sent(FRAGMENT + 9, now);
        let due = pacer.next;
        assert_eq!(due - now, Duration::from_nanos(14_425_840));
        assert!(!pacer.ready(due - Duration::from_nanos(1)));
        assert!(pacer.ready(due));

        // Reopening or replacing a key changes neither the peer nor its existing deadline.
        // Lowering the target preserves that debt; the next accepted fragment uses the new rate.
        pacer.bitrate_kbps = 1000;
        assert_eq!(pacer.next, due);
        pacer.sent(FRAGMENT + 9, due);
        assert_eq!(pacer.next - due, Duration::from_nanos(115_406_720));

        let later = now + Duration::from_secs(10);
        assert!(pacer.ready(later));
        pacer.sent(FRAGMENT + 9, later);
        assert!(!pacer.ready(later));
        assert_eq!(pacer.next - later, Duration::from_nanos(115_406_720));
        // Zero is guarded at this internal boundary, and every accepted byte costs time.
        let due = pacer.next;
        pacer.bitrate_kbps = 0;
        pacer.sent(1, due);
        assert_eq!(pacer.next - due, Duration::from_micros(7040));
    }

    #[test]
    fn pending_transport_deadline_survives_replacement_and_idle_frames() {
        let now = Instant::now();
        let mut progress = SendProgress::default();
        progress.observe(0, false, now);
        assert_eq!(progress.since, None);
        progress.observe(100, false, now + Duration::from_secs(10));
        let started = progress.since;
        // New/replacement keys and additional SCTP writes do not acknowledge the first frame.
        progress.observe(100, true, now + Duration::from_secs(11));
        progress.observe(200, false, now + Duration::from_secs(12));
        progress.observe(200, true, now + Duration::from_secs(13));
        assert_eq!(progress.since, started);
        assert!(now + Duration::from_secs(13) >= progress.since.unwrap() + STALL);
        // Acknowledgements make progress; subsequent healthy idle time is not a stall.
        progress.observe(50, true, now + Duration::from_secs(14));
        assert_eq!(progress.since, Some(now + Duration::from_secs(14)));
        progress.observe(0, false, now + Duration::from_secs(15));
        assert_eq!(progress.since, None);
        progress.observe(0, true, now + Duration::from_secs(100));
        assert_eq!(progress.since, Some(now + Duration::from_secs(100)));
    }

}
