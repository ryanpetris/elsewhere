// Run inside the Docker rig: node checks/rtc-peer.mjs.
import assert from 'node:assert/strict';
import { openRtc, rtcEndpoint } from '../src/rtc.js';

for (const [url, address, port] of [
  ['https://desktop.example:9443/', 'desktop.example', '9443'],
  ['https://192.0.2.1/', '192.0.2.1', '443'],
  ['http://localhost/', 'localhost', '80'],
  ['https://[2001:db8::1]:9443/', '2001:db8::1', '9443'],
]) {
  assert.deepEqual(rtcEndpoint(new URL(url), { port: Number(port) }), { host: address, port: Number(port) });
}

assert.deepEqual(rtcEndpoint(new URL('https://viewer.example:9443'), { port: 19502 }), { host: 'viewer.example', port: 19502 });
assert.deepEqual(rtcEndpoint(new URL('https://viewer.example'), { host: '192.0.2.5', port: 19502 }), { host: '192.0.2.5', port: 19502 });

let pc;
const timers = new Map();
let timerId = 0;
globalThis.setTimeout = (fn, ms) => { timers.set(++timerId, { fn, ms }); return timerId; };
globalThis.clearTimeout = id => timers.delete(id);
class Peer {
  constructor() { pc = this; this.channel = {}; this.localCalls = 0; this.closed = false; }
  createDataChannel(name, options) { assert.equal(name, 'video'); assert.equal(options.ordered, true); return this.channel; }
  createOffer() { return new Promise(resolve => { this.offerReady = resolve; }); }
  async setLocalDescription(o) { this.localCalls++; this.localDescription = o; if (!this.gatherPending) { this.iceGatheringState = 'complete'; this.onicegatheringstatechange?.(); } }
  async setRemoteDescription(answer) { this.remoteDescription = answer; throw new Error('invalid answer'); }
  close() { this.closed = true; this.channel.onclose?.(); }
}
globalThis.RTCPeerConnection = Peer;
const settle = async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); };
let messages = 0, opens = 0, failures = [], offers = [], received = [];
const start = () => openRtc({ iceServers: [], endpoint: { host: 'localhost', port: 8080 }, g: 7, signal: o => offers.push(o), onMessage: (buffer, arrival) => { messages++; received.push({ bytes: [...new Uint8Array(buffer)], arrival }); }, onOpen: () => opens++, onClose: reason => failures.push(reason) });
let peer = start();
const oldOpen = pc.channel.onopen, oldMessage = pc.channel.onmessage, oldClose = pc.channel.onclose;
peer.close();
pc.offerReady({ sdp: 'late' });
oldOpen(); oldMessage({}); oldClose();
await settle();
assert.equal(pc.localCalls, 0);
assert.deepEqual([messages, opens, failures.length, offers.length], [0, 0, 0, 0]);

peer = start();
pc.offerReady({ sdp: 'current' });
await settle();
assert.deepEqual(offers, [{ offer: 'current', g: 7 }]);
pc.channel.onopen();
assert.equal(opens, 1);
const sdp = 'v=0\r\na=ice-ufrag:test\r\na=candidate:1 1 udp 123 192.0.2.1 8443 typ host\r\na=candidate:2 1 udp 456 2001:db8::1 8443 typ host\r\na=end-of-candidates\r\n';
peer.answer(sdp);
assert.equal(pc.remoteDescription.sdp, sdp.replace('192.0.2.1 8443', 'localhost 8080').replace('a=candidate:2 1 udp 456 2001:db8::1 8443 typ host\r\n', ''));
await settle();
failures = [];
peer.answer('bad');
assert.equal(pc.remoteDescription.sdp, 'bad');
await settle();
assert.deepEqual(failures, ['Answer rejected']);
pc.connectionState = 'failed'; pc.onconnectionstatechange();
assert.equal(failures.at(-1), 'Peer connection failed');
const before = failures.length;
peer.answer('late bad answer');
peer.close();
await settle();
assert.equal(failures.length, before);
assert(pc.closed);
assert.equal(pc.onconnectionstatechange, null);
assert.equal(pc.channel.onmessage, null);
peer = start();
pc.gatherPending = true;
pc.offerReady({ sdp: 'gathering' });
await settle();
assert.equal(timers.size, 1);
const delayedOffer = [...timers.values()][0].fn;
peer.close();
assert.equal(timers.size, 0);
delayedOffer();
assert.equal(offers.length, 1);
peer = start();
pc.gatherPending = true; pc.offerReady({ sdp: 'gathered later' });
await settle();
assert.equal(timers.size, 1);
pc.iceGatheringState = 'complete'; pc.onicegatheringstatechange();
assert.equal(timers.size, 0);
assert.equal(offers.length, 2);
peer.close();

// Pacing a frame's remaining fragments must not move its first-arrival timestamp.
let now = 100;
Object.defineProperty(globalThis, 'performance', { configurable: true, value: { now: () => now } });
const fragment = (id, index, count, bytes) => {
  const data = new Uint8Array(9 + bytes.length), view = new DataView(data.buffer);
  view.setUint32(1, id, true); view.setUint16(5, index, true); view.setUint16(7, count, true);
  data.set(bytes, 9);
  return { data: data.buffer };
};
peer = start();
pc.channel.onmessage(fragment(1, 0, 2, [2, 3]));
assert.equal(received.length, 0, 'partial video cannot reach the decoder');
now = 900;
pc.channel.onmessage(fragment(1, 1, 2, [4, 5]));
assert.deepEqual(received, [{ bytes: [2, 3, 4, 5], arrival: 100 }]);
now = 950;
pc.channel.onmessage(fragment(2, 0, 1, [6]));
assert.deepEqual(received[1], { bytes: [6], arrival: 950 });
peer.close();
console.log('RTC peer callback disposal, gathering, failure and first-fragment arrival checks passed');
