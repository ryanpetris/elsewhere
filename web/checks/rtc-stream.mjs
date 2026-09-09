import { createToken } from './token-fixture.mjs';
// Run in Docker with the release build, Chromium and mpv.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, open, readFile, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright-core';

const root = await mkdtemp('/tmp/elsewhere-rtc-stream-');
await mkdir(root + '/runtime', { mode: 0o700 });
const log = await open(root + '/server.log', 'w');
const port = process.env.ELSEWHERE_TEST_PORT ?? '8855';
const origin = `http://127.0.0.1:${port}`;
const environment = { ...process.env, XDG_RUNTIME_DIR: root + '/runtime', XDG_CONFIG_HOME: root + '/config', WAYLAND_DISPLAY: 'wayland-rtc-stream' };
const startServer = (fixedSize = false) => spawn(process.env.ELSEWHERE_BINARY || '/src/target/release/elsewhere', [
  '--no-audio', '--no-tls', '--render-node', 'none', '--codecs', 'vp8', '--bitrate', '8000',
  ...(fixedSize ? ['--screen-size', '640x360'] : []),
  '--listen', `127.0.0.1:${port}`, '--socket-name', 'wayland-rtc-stream',
], { env: environment, stdio: ['ignore', log.fd, log.fd] });
let server = startServer(), browser, source;
async function stop(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise(resolve => child.once('exit', resolve));
  child.kill('SIGTERM');
  const timer = setTimeout(() => child.kill('SIGKILL'), 2000);
  await exited; clearTimeout(timer);
}

try {
  for (let i = 0; i < 200; i++) {
    try { if ((await fetch(origin)).ok) break; } catch {}
    assert.equal(server.exitCode, null, await readFile(root + '/server.log', 'utf8'));
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  const token = await createToken(root);
  source = spawn('mpv', ['--no-config', '--no-audio', '--vo=wlshm', '--title=elsewhere-rtc-stream',
    'av://lavfi:testsrc2=size=640x360:rate=30'], { env: environment, stdio: ['ignore', log.fd, log.fd] });
  await new Promise((resolve, reject) => { source.once('spawn', resolve); source.once('error', reject); });
  browser = await chromium.launch({ executablePath: '/usr/bin/chromium', args: ['--no-sandbox'] });
  const context = await browser.newContext({ viewport: { width: 900, height: 600 } });
  await context.addInitScript(() => {
    for (const [key, value] of Object.entries({ codec: 'vp8', transport: 'websocket', quality: 'medium', effort: 'fast' })) localStorage.setItem('elsewhere.' + key, value);
    window.ordering = { held: false, events: [], packets: [], parts: new Map(), configured: [], decoded: [], outputs: [], ws: [], sockets: 0, requests: 0 };
    ordering.hold = () => { ordering.held = true; ordering.events = []; ordering.packets = []; ordering.parts.clear(); };
    const NativeDecoder = VideoDecoder;
    window.VideoDecoder = class extends NativeDecoder {
      constructor(options) {
        let decoder;
        super({ ...options, output(frame) {
          ordering.outputs.push({ codec: decoder.codec, pts: frame.timestamp });
          if (ordering.holdPaint) {
            ordering.paintHeld?.frame.close();
            ordering.paintHeld = { frame, output: options.output, configuration: decoder.configuration };
          } else options.output(frame);
        } });
        decoder = this;
      }
      configure(config) { this.codec = config.codec; ordering.configured.push(config.codec); this.configuration = ordering.configured.length; super.configure(config); }
      decode(chunk) { ordering.decoded.push({ codec: this.codec, key: chunk.type === 'key', pts: chunk.timestamp }); super.decode(chunk); }
    };
    const NativePeer = RTCPeerConnection;
    window.RTCPeerConnection = class extends NativePeer {
      createDataChannel(...args) {
        const channel = super.createDataChannel(...args); ordering.channel = channel;
        channel.addEventListener('message', event => {
          if (!ordering.held) return;
          event.stopImmediatePropagation();
          const data = event.data.slice(0), view = new DataView(data);
          const id = view.getUint32(1, true), index = view.getUint16(5, true), count = view.getUint16(7, true);
          const position = ordering.events.push(data) - 1;
          let part = ordering.parts.get(id);
          if (!part) { part = { chunks: new Array(count), got: 0, start: position }; ordering.parts.set(id, part); }
          part.chunks[index] = new Uint8Array(data, 9); part.got++;
          if (part.got !== count) return;
          const bytes = new Uint8Array(part.chunks.reduce((size, chunk) => size + chunk.length, 0));
          let offset = 0;
          for (const chunk of part.chunks) { bytes.set(chunk, offset); offset += chunk.length; }
          const packet = { start: part.start, end: position, kind: bytes[0] };
          if (packet.kind === 1) packet.config = JSON.parse(new TextDecoder().decode(bytes.subarray(1)));
          if (packet.kind === 2) { packet.key = !!(bytes[1] & 1); packet.seq = new DataView(bytes.buffer).getUint16(2, true); }
          ordering.packets.push(packet); ordering.parts.delete(id);
        });
        return channel;
      }
    };
    const NativeSocket = WebSocket;
    window.WebSocket = class extends NativeSocket {
      constructor(...args) {
        super(...args); ordering.socket = this;
        const session = ++ordering.sockets;
        this.addEventListener('message', ({ data }) => {
          if (!(data instanceof ArrayBuffer)) return;
          const bytes = new Uint8Array(data), record = { kind: bytes[0], session };
          if (record.kind === 1) record.config = JSON.parse(new TextDecoder().decode(bytes.subarray(1)));
          if (record.kind === 2) { record.key = !!(bytes[1] & 1); record.seq = new DataView(data).getUint16(2, true); record.data = data.slice(0); }
          if (record.kind === 1 || record.kind === 2) ordering.ws.push(record);
        });
      }
      send(data) {
        const kind = new Uint8Array(data)[0];
        if (kind === 0x88) ordering.requests++;
        if (kind !== 0x96) super.send(data); // Keep this ordering test independent of rate adaptation.
      }
    };
    ordering.snapshot = () => ({ seq: elsewhere().videoSeq, awaitingKey: elsewhere().awaitingKey,
      streamId: elsewhere.store.get().stream.streamId, codec: elsewhere.store.get().stream.codec,
      decodes: ordering.decoded.length, configurations: ordering.configured.length, requests: ordering.requests });
    ordering.picture = () => {
      const canvas = document.querySelector('canvas'), sample = document.createElement('canvas');
      sample.width = 16; sample.height = 9;
      const context = sample.getContext('2d'); context.drawImage(canvas, 0, 0, 16, 9);
      return { width: canvas.width, height: canvas.height, png: canvas.toDataURL(),
        colored: [...context.getImageData(0, 0, 16, 9).data].some((value, index) => index % 4 !== 3 && value > 32) };
    };
  });
  const page = await context.newPage(), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(origin + '/#token=' + token);
  await page.waitForFunction(() => elsewhere().videoSeq > 60 && !elsewhere().awaitingKey, undefined, { timeout: 20000 });
  await page.evaluate(() => ordering.socket.send(new Uint8Array([0x88])));
  await page.waitForFunction(() => ordering.ws.some(packet => packet.key && packet.seq > 60));
  await page.evaluate(() => {
    ordering.oldSocketKey = ordering.ws.findLast(packet => packet.key && packet.seq > 60);
    ordering.oldSocketDelta = ordering.ws.findLast(packet => packet.kind === 2 && !packet.key);
    elsewhere.setTransport('webrtc');
  });
  await page.waitForFunction(() => elsewhere.store.get().videoVia === 'webrtc' && !elsewhere().awaitingKey);
  const original = await page.evaluate(() => { ordering.hold(); return ordering.snapshot(); });
  await page.waitForFunction(() => ordering.packets.some(packet => packet.kind === 2 && !packet.key));
  await page.evaluate(() => ordering.socket.send(new Uint8Array([0x88])));
  await page.waitForFunction(() => ordering.packets.some(packet => packet.kind === 2 && packet.key));
  await page.evaluate(() => elsewhere.setChoice({ codec: 'h264' }));
  await page.waitForFunction(id => {
    const config = ordering.packets.find(packet => packet.config?.codec.startsWith('avc1') && packet.config.streamId !== id);
    return config && ordering.packets.some(packet => packet.start > config.end && packet.kind === 2 && packet.key && packet.seq === 0);
  }, original.streamId, { timeout: 5000 });
  const ordered = await page.evaluate(id => {
    const config = ordering.packets.find(packet => packet.config?.codec.startsWith('avc1') && packet.config.streamId !== id);
    const key = ordering.packets.find(packet => packet.start > config.end && packet.kind === 2 && packet.key && packet.seq === 0);
    const before = ordering.snapshot(), old = ordering.packets.filter(packet => packet.kind === 2 && packet.end < config.start);
    const oldKeysBefore = ordering.decoded.filter(chunk => chunk.key && chunk.codec === before.codec).length;
    const newSocketConfigs = ordering.ws.filter(packet => packet.config && packet.config.streamId === config.config.streamId).length;
    for (let i = 0; i < config.start; i++) ordering.channel.onmessage({ data: ordering.events[i] });
    const afterOld = ordering.snapshot();
    const oldKeysAfter = ordering.decoded.filter(chunk => chunk.key && chunk.codec === before.codec).length;
    for (let i = config.start; i <= config.end; i++) ordering.channel.onmessage({ data: ordering.events[i] });
    const afterConfig = ordering.snapshot();
    for (let i = config.end + 1; i <= key.end; i++) ordering.channel.onmessage({ data: ordering.events[i] });
    const afterKey = ordering.snapshot();
    for (let i = config.start; i <= config.end; i++) ordering.channel.onmessage({ data: ordering.events[i] });
    const afterDuplicate = ordering.snapshot();
    ordering.socket.onmessage({ data: ordering.oldSocketKey.data.slice(0) });
    ordering.socket.onmessage({ data: ordering.oldSocketDelta.data.slice(0) });
    const afterLateSocket = ordering.snapshot();
    ordering.held = false;
    return { before, old, oldKeysBefore, oldKeysAfter, newSocketConfigs, afterOld, afterConfig, afterKey, afterDuplicate, afterLateSocket,
      lateSocketSeq: ordering.oldSocketKey.seq, newConfig: config.config, keySeq: key.seq };
  }, original.streamId);
  assert.equal(ordered.before.streamId, original.streamId, 'configuration cannot overtake retained RTC video');
  assert.equal(ordered.newSocketConfigs, 0, 'active RTC carries its configuration in video order');
  assert(ordered.old.some(packet => packet.key) && ordered.old.some(packet => !packet.key));
  assert.equal(ordered.afterOld.streamId, original.streamId);
  assert(ordered.oldKeysAfter > ordered.oldKeysBefore, 'old recovery key decodes with the old configuration');
  assert.equal(ordered.afterConfig.streamId, ordered.newConfig.streamId);
  assert(ordered.afterConfig.awaitingKey);
  assert.equal(ordered.afterKey.seq, 0);
  assert.equal(ordered.afterKey.decodes, ordered.afterConfig.decodes + 1);
  assert.equal(ordered.afterKey.awaitingKey, false);
  assert.deepEqual(ordered.afterDuplicate, ordered.afterKey, 'same-stream CONFIG cannot reset decoding or request another key');
  assert(ordered.lateSocketSeq > ordered.afterKey.seq, 'late socket key would pass an ordinary sequence comparison');
  assert.deepEqual(ordered.afterLateSocket, ordered.afterDuplicate, 'late socket key and delta cannot enter the active RTC stream');
  await page.waitForFunction(codec => ordering.outputs.some(output => output.codec === codec) && !elsewhere().awaitingKey, ordered.newConfig.codec);

  await page.evaluate(() => { ordering.hold(); elsewhere.setChoice({ codec: 'vp8' }); });
  await page.waitForFunction(id => ordering.packets.some(packet => packet.config?.codec === 'vp8' && packet.config.streamId !== id), ordered.newConfig.streamId, { timeout: 5000 });
  const fallback = await page.evaluate(id => {
    const target = ordering.packets.find(packet => packet.config?.codec === 'vp8' && packet.config.streamId !== id).config;
    ordering.fallbackSocketStart = ordering.ws.length;
    ordering.fallbackOutputs = ordering.outputs.length;
    ordering.closedReceive = ordering.channel.onmessage;
    ordering.closedPacket = ordering.events[0];
    elsewhere.setTransport('websocket');
    return target;
  }, ordered.newConfig.streamId);
  await page.waitForFunction(id => elsewhere.store.get().stream.streamId === id && elsewhere.store.get().videoVia === 'websocket'
    && !elsewhere().awaitingKey && ordering.outputs.slice(ordering.fallbackOutputs).some(output => output.codec === 'vp8'), fallback.streamId, { timeout: 5000 });
  const recovered = await page.evaluate(() => {
    const packets = ordering.ws.slice(ordering.fallbackSocketStart).map(({ kind, config, seq, key }) => ({ kind, config, seq, key }));
    const before = ordering.snapshot(); ordering.closedReceive({ data: ordering.closedPacket });
    return { packets, before, after: ordering.snapshot(), decodeErrors: elsewhere().decodeErrors };
  });
  const configAt = recovered.packets.findIndex(packet => packet.config?.streamId === fallback.streamId);
  const videoAt = recovered.packets.findIndex(packet => packet.kind === 2);
  assert(configAt >= 0 && videoAt > configAt, 'fallback sends the latest configuration before its first video');
  assert.deepEqual(recovered.after, recovered.before, 'callbacks from the closed RTC attempt cannot affect fallback');
  assert.equal(recovered.decodeErrors, 0);

  const retainedPictures = [];
  for (const transport of ['websocket', 'webrtc']) {
    await page.evaluate(transport => { ordering.held = false; elsewhere.setTransport(transport); }, transport);
    await page.waitForFunction(transport => elsewhere.store.get().videoVia === transport && !elsewhere().awaitingKey, transport);
    for (const resized of [false, true]) {
      const before = await page.evaluate(async () => {
        ordering.holdPaint = true;
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        return { ...ordering.picture(), ...ordering.snapshot() };
      });
      assert(before.colored, 'the retained picture must contain actual source pixels');
      try {
        if (resized) await page.setViewportSize(transport === 'websocket' ? { width: 760, height: 520 } : { width: 920, height: 640 });
        else await page.evaluate(() => elsewhere.setChoice({ effort: elsewhere.store.get().choice.effort === 'fast' ? 'balanced' : 'fast' }));
        await page.waitForFunction(before => elsewhere.store.get().stream.streamId !== before.streamId
          && ordering.configured.length > before.configurations && ordering.paintHeld?.configuration === ordering.configured.length
          && !elsewhere().awaitingKey, before, { timeout: 10000 });
        const held = await page.evaluate(async () => {
          const pictures = [];
          for (let i = 0; i < 5; i++) {
            await new Promise(resolve => setTimeout(resolve, 50));
            pictures.push(ordering.picture());
          }
          const frame = ordering.paintHeld.frame;
          return { pictures, stream: elsewhere.store.get().stream, width: frame.displayWidth, height: frame.displayHeight };
        });
        const name = `${transport}-${resized ? 'resized' : 'same-size'}`;
        for (const [phase, picture] of [['before', before], ['held', held.pictures.at(-1)]]) {
          await writeFile(`${root}/${name}-${phase}.png`, Buffer.from(picture.png.split(',')[1], 'base64'));
        }
        assert.equal(held.stream.streamId, await page.evaluate(() => elsewhere.store.get().stream.streamId));
        assert.equal(resized, held.width !== before.width || held.height !== before.height, 'the native output must exercise the requested size transition');
        for (const picture of held.pictures) {
          assert.deepEqual([picture.width, picture.height], [before.width, before.height]);
          assert(picture.png === before.png, `${transport} CONFIG must preserve the last painted pixels while output waits`);
        }
        const after = await page.evaluate(async () => {
          const held = ordering.paintHeld; ordering.paintHeld = null;
          held.output(held.frame);
          await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
          return ordering.picture();
        });
        assert.deepEqual([after.width, after.height], [held.width, held.height]);
        assert(after.colored, 'the fresh decoded output must paint actual source pixels');
        assert(after.png !== before.png, 'releasing the fresh output must replace the retained picture');
        await writeFile(`${root}/${name}-after.png`, Buffer.from(after.png.split(',')[1], 'base64'));
        retainedPictures.push({ transport, resized, before: [before.width, before.height], after: [after.width, after.height], streamId: held.stream.streamId });
      } finally {
        await page.evaluate(() => { ordering.holdPaint = false; ordering.paintHeld?.frame.close(); ordering.paintHeld = null; });
      }
    }
  }
  await page.evaluate(() => elsewhere.setTransport('websocket'));
  await page.waitForFunction(() => elsewhere.store.get().videoVia === 'websocket' && !elsewhere().awaitingKey);
  await stop(source); source = null;
  const restarts = [];
  for (let restart = 0; restart < 2; restart++) {
    await stop(server);
    await page.waitForFunction(() => elsewhere.store.get().status !== 'connected');
    const before = await page.evaluate(() => ({ outputs: ordering.outputs.length, configurations: ordering.configured.length, session: ordering.sockets }));
    server = startServer(true);
    await page.waitForFunction(before => ordering.sockets > before.session && ordering.configured.length > before.configurations
      && ordering.outputs.length > before.outputs && elsewhere.store.get().status === 'connected' && !elsewhere().awaitingKey,
    before, { timeout: 15000 });
    restarts.push(await page.evaluate(() => ({ streamId: elsewhere.store.get().stream.streamId, session: ordering.sockets,
      configurations: ordering.configured.length, outputs: ordering.outputs.length })));
  }
  assert.equal(restarts[0].streamId, restarts[1].streamId, 'a fresh server reuses its first stream ID');
  assert(restarts[1].session > restarts[0].session && restarts[1].configurations > restarts[0].configurations);
  assert.deepEqual(errors, []);
  await writeFile(root + '/results.json', JSON.stringify({ original, ordered, fallback, recovered, retainedPictures, restarts }, null, 2));
  console.log('Ordered RTC configurations, old key/delta delivery, late socket video, latest-config fallback and same-ID server restarts passed');
  console.log('WebSocket and RTC retain painted pixels through same-size and resized stream restarts');
} finally {
  await browser?.close().catch(() => {});
  await stop(source); await stop(server); await log.close();
  console.log('RTC stream artifacts:', root);
}
