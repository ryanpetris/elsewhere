// Video over an ordered, reliable WebRTC data channel. Lost packets hold later frames until
// retransmission. The page offers one channel and applies the configured endpoint to the ICE answer.
// The browser resolves its hostname. Numbered fragments carry up to 16 KiB of frame data,
// reassembled here and handed to the same message handler as the socket's.
export const RTC_TIMING = { gather: 1500, gatherWithServers: 5000, attempt: 10000, retry: 1000, retryMax: 30000, healthy: 10000 };

export function openRtc({ iceServers, endpoint, g, signal, onMessage, onOpen, onClose }) {
  const pc = new RTCPeerConnection({ iceServers });
  let ch;
  try { ch = pc.createDataChannel('video', { ordered: true }); } catch (e) { pc.close(); throw e; }
  let offered = false, closed = false, gatherTimer;
  const fail = reason => { if (!closed) onClose(reason); };
  ch.binaryType = 'arraybuffer';
  const parts = new Map(); // frame id -> { got, chunks } while its fragments come in
  let incomplete = 0; // frames given up on: the server abandoned one half-sent
  ch.onmessage = e => {
    if (closed) return;
    const dv = new DataView(e.data); // every message is a fragment, a whole frame a fragment of one
    const id = dv.getUint32(1, true), index = dv.getUint16(5, true), count = dv.getUint16(7, true);
    let p = parts.get(id);
    if (!p) {
      p = { got: 0, chunks: new Array(count), arrival: performance.now() };
      parts.set(id, p);
      if (parts.size > 8) { parts.delete(parts.keys().next().value); incomplete++; } // a frame that lost a fragment is forgotten
    }
    p.chunks[index] = new Uint8Array(e.data, 9);
    if (++p.got < count) return;
    parts.delete(id);
    const out = new Uint8Array(p.chunks.reduce((n, c) => n + c.length, 0));
    let o = 0;
    for (const c of p.chunks) { out.set(c, o); o += c.length; }
    onMessage(out.buffer, p.arrival);
  };
  ch.onopen = () => { if (!closed) onOpen(); };
  ch.onclose = () => fail('Data channel closed');
  ch.onerror = () => fail('Data channel failed');
  pc.onconnectionstatechange = () => {
    if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected') fail('Peer connection ' + pc.connectionState);
  };
  // the offer goes out with the candidates in it, once gathering is done (host ones come at once; a STUN
  // or TURN one takes a round trip or an allocation, so the wait is longer with servers configured): the
  // server does no trickle; `g` comes back with the answer
  const offer = () => { if (!offered && !closed && pc.localDescription) { offered = true; clearTimeout(gatherTimer); signal({ offer: pc.localDescription.sdp, g }); } };
  pc.onicegatheringstatechange = () => { if (pc.iceGatheringState === 'complete') offer(); };
  pc.createOffer().then(o => { if (!closed) return pc.setLocalDescription(o); }).then(() => {
    if (!closed && !offered) gatherTimer = setTimeout(offer, iceServers.length ? RTC_TIMING.gatherWithServers : RTC_TIMING.gather);
  }).catch(() => fail('Offer failed'));
  return {
    answer: sdp => {
      if (closed) return;
      let candidate = false;
      // The video channel has one endpoint, shared by all of the server's local sockets.
      sdp = sdp.replace(/^(a=candidate:\S+ \d+ \S+ \d+) \S+ \d+([^\r\n]*)(\r?\n|$)/gm, (_, prefix, rest, end) => {
        if (candidate) return '';
        candidate = true;
        return `${prefix} ${endpoint.host} ${endpoint.port}${rest}${end}`;
      });
      pc.setRemoteDescription({ type: 'answer', sdp }).catch(() => fail('Answer rejected'));
    },
    close: () => {
      closed = true;
      clearTimeout(gatherTimer);
      ch.onopen = ch.onclose = ch.onerror = ch.onmessage = null;
      pc.onicegatheringstatechange = pc.onconnectionstatechange = null;
      parts.clear();
      pc.close();
    },
    incomplete: () => incomplete,
    // the numbers the Statistics tab shows: the path's round trip, what the channel carried, frames lost to it
    stats: async () => {
      const out = { incomplete, rttMs: null, bytes: 0, messages: 0 };
      (await pc.getStats()).forEach(r => {
        if (r.type === 'candidate-pair' && r.nominated && r.currentRoundTripTime !== undefined) out.rttMs = r.currentRoundTripTime * 1000; // the pair in use, not any that worked
        if (r.type === 'data-channel') { out.bytes = r.bytesReceived; out.messages = r.messagesReceived; }
      });
      return out;
    },
  };
}

// The server supplies the UDP port and an optional address override.
export function rtcEndpoint({ hostname }, { host, port }) {
  return { host: host || hostname.replace(/^\[|\]$/g, ''), port };
}
