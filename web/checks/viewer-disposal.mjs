// Docker: FFmpeg, Chromium and built viewer. Native VP8 decode; deterministic WebGPU scheduling fixture.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright-core';
import { CONFIG, VIDEO, ROLE } from '../src/protocol.js';

const ivf = execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=64x64:rate=1', '-frames:v', '1', '-c:v', 'libvpx', '-deadline', 'realtime', '-f', 'ivf', 'pipe:1']);
const key = [...ivf.subarray(44, 44 + ivf.readUInt32LE(32))];
const server = createServer(async (req, res) => {
  const path = new URL(req.url, 'http://localhost').pathname;
  if (path.startsWith('/api/')) {
    res.setHeader('Content-Type', 'application/json');
    return res.end(JSON.stringify(path === '/api/codecs' ? [{ codec: 'vp8', hardware: false }] : path === '/api/clipboard/state' ? { observation: 'fixture:0', operation: null, present: false, mime: null, size: 0, preview: 'empty' } : []));
  }
  try {
    res.setHeader('Content-Type', path.endsWith('.js') ? 'text/javascript' : path.endsWith('.css') ? 'text/css' : 'text/html');
    res.end(await readFile(new URL('../dist/' + (path === '/' ? 'index.html' : path.slice(1)), import.meta.url)));
  } catch { res.writeHead(404).end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const browser = await chromium.launch({ executablePath: '/usr/bin/chromium', args: ['--no-sandbox'] });
const results = [];
try {
  for (const renderer of ['2d', 'webgpu']) for (const ending of ['dispose', 4001, 4004, 1006, 4003]) {
    const page = await browser.newPage();
    await page.addInitScript(({ renderer, CONFIG, VIDEO, ROLE, key }) => {
      const probe = window.probe = { outputs: 0, draws: 0, hold: false, held: new Map(), delivered: [], decoders: [], views: [], created: [], errors: [], requests: 0 };
      addEventListener('error', event => probe.errors.push(event.message));
      addEventListener('unhandledrejection', event => probe.errors.push(String(event.reason)));
      const Frame = VideoFrame;
      window.VideoFrame = new Proxy(Frame, { construct(Target, args) {
        const frame = new Target(...args); probe.created.push(frame); return frame;
      } });
      const Decoder = VideoDecoder;
      window.VideoDecoder = class extends Decoder {
        constructor(init) {
          super({ ...init, output: frame => { probe.outputs++; probe.delivered.push(frame); init.output(frame); } });
          probe.decoders.push(this); probe.output = init.output; probe.error = init.error;
        }
      };
      const draw = CanvasRenderingContext2D.prototype.drawImage;
      CanvasRenderingContext2D.prototype.drawImage = function (...args) {
        if (this.canvas.matches('canvas.stage')) { probe.draws++; probe.views.push(args[0]); probe.size = [args[0].displayWidth, args[0].displayHeight]; }
        return draw.apply(this, args);
      };
      let heldId = 1000000;
      const raf = requestAnimationFrame, cancel = cancelAnimationFrame;
      window.requestAnimationFrame = fn => {
        if (!probe.hold) return raf(fn);
        const id = ++heldId; probe.held.set(id, fn); return id;
      };
      window.cancelAnimationFrame = id => { probe.held.delete(id); cancel(id); };
      if (renderer === 'webgpu') {
        const pass = { setPipeline() {}, setBindGroup() {}, draw() {}, end() {} };
        const device = {
          lost: new Promise(() => {}), createShaderModule() {}, createRenderPipeline: () => ({ getBindGroupLayout() {} }), createSampler() {},
          createBindGroup() {}, importExternalTexture({ source }) { probe.views.push(source); probe.size = [source.displayWidth, source.displayHeight]; }, createCommandEncoder: () => ({ beginRenderPass: () => pass, finish() {} }),
          queue: { submit() { probe.draws++; }, onSubmittedWorkDone: () => Promise.resolve() },
        };
        Object.defineProperty(navigator, 'gpu', { value: { requestAdapter: async () => ({ requestDevice: async () => device }), getPreferredCanvasFormat: () => 'bgra8unorm' } });
        const context = HTMLCanvasElement.prototype.getContext;
        HTMLCanvasElement.prototype.getContext = function (type, ...args) {
          return type === 'webgpu' ? { configure() {}, getCurrentTexture: () => ({ createView() {} }) } : context.call(this, type, ...args);
        };
      }
      window.WebSocket = class {
        static OPEN = 1; readyState = 1;
        constructor() { window.socket = this; queueMicrotask(() => { this.onopen?.({}); this.onmessage?.({ data: new Uint8Array([0x15, ...new TextEncoder().encode(JSON.stringify(["desktop.view", "desktop.control", "clipboard.read", "clipboard.write"]))]).buffer }); }); }
        send(data) { if (new Uint8Array(data)[0] === 0x88) probe.requests++; } close() { this.readyState = 3; }
      };
      let seq = 0;
      probe.configure = () => {
        socket.onmessage({ data: new Uint8Array([ROLE, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0]).buffer });
        socket.onmessage({ data: new Uint8Array([CONFIG, ...new TextEncoder().encode(JSON.stringify({ streamId: 1, codec: 'vp8', width: 62, height: 60, scale: 1.25 }))]).buffer });
      };
      probe.feed = () => {
        const bytes = new Uint8Array(12 + key.length), view = new DataView(bytes.buffer);
        bytes[0] = VIDEO; bytes[1] = 1; view.setUint16(2, seq, true); view.setBigUint64(4, BigInt(++seq * 1000), true); bytes.set(key, 12);
        socket.onmessage({ data: bytes.buffer });
      };
    }, { renderer, CONFIG, VIDEO, ROLE, key });
    await page.goto(`http://127.0.0.1:${server.address().port}/?renderer=${renderer}#token=fixture`);
    await page.waitForFunction(() => window.socket && window.elsewhere?.store);
    await page.evaluate(() => { probe.configure(); probe.feed(); });
    await page.waitForFunction(() => probe.draws > 0);
    assert.deepEqual(await page.evaluate(() => probe.size), [62, 60], 'each renderer receives the configured crop');
    if (renderer === 'webgpu') {
      await page.evaluate(() => { probe.hold = true; probe.feed(); });
      await page.waitForFunction(() => probe.held.size === 1);
    }
    const result = await page.evaluate(async ending => {
      const decoder = probe.decoders.at(-1), pending = probe.created.at(-1), callbacks = [...probe.held.values()], outputsBefore = probe.outputs;
      for (let i = 0; i < 12; i++) probe.feed();
      const queued = decoder.decodeQueueSize, before = probe.draws, pendingBefore = pending.codedWidth;
      if (ending === 'dispose') { elsewhere.dispose(); elsewhere.dispose(); }
      else { socket.readyState = 3; socket.onclose({ code: ending, reason: 'connection ended' }); }
      const state = decoder.state, pendingAfter = pending.codedWidth, held = probe.held.size;
      await new Promise(resolve => setTimeout(resolve, 150));
      // A callback already handed to the application must close its frame without painting or recovering.
      const late = new VideoFrame(document.createElement('canvas'), { timestamp: 50000 });
      probe.output(late); probe.error(new Error('late decoder callback'));
      for (const callback of callbacks) callback(performance.now());
      return { ending, requests: probe.requests, renderer: elsewhere.store.get().renderer, queued, state, status: elsewhere.store.get().status,
        decoderRetained: elsewhere().decoder !== undefined, pendingBefore, pendingAfter,
        held, nativeOutputsAfterDispose: probe.outputs - outputsBefore, lateClosed: late.codedWidth === 0, extraDraws: probe.draws - before, decoders: probe.decoders.length, nativeReleased: probe.delivered.every(f => f.codedWidth === 0), viewsClosed: probe.views.every(f => f.codedWidth === 0), errors: probe.errors };
    }, ending);
    results.push(result);
    if (ending === 1006 || ending === 4003) {
      const size = await page.evaluate(() => {
        elsewhere.setStage(310, 300);
        const canvas = document.querySelector('canvas.stage');
        return [parseFloat(canvas.style.width), parseFloat(canvas.style.height)];
      });
      assert.deepEqual(size, [310, 300], 'retained picture fits the stage while disconnected');
    }
    if (ending === 4001 || ending === 4004) {
      await page.getByPlaceholder('token', { exact: true }).fill('replacement-token');
      await Promise.all([page.waitForNavigation(), page.getByRole('button', { name: 'Connect', exact: true }).click()]);
      await page.waitForFunction(() => window.socket && window.elsewhere?.store);
      await page.evaluate(() => { probe.configure(); probe.feed(); });
      await page.waitForFunction(() => probe.draws > 0 && elsewhere.store.get().status === 'connected');
      assert.deepEqual(await page.evaluate(() => probe.size), [62, 60], 'authenticated replacement connection paints normally');
    }
    await page.close();
  }
  console.log(JSON.stringify(results));
  for (const result of results) {
    assert.ok(result.queued > 0, 'native decode work was queued at disposal');
    assert.equal(result.state, 'closed'); assert.equal(result.status, result.ending === 'dispose' ? 'closed' : result.ending === 1006 ? 'retrying' : result.ending === 4003 ? 'gone' : 'unauthorized'); assert.equal(result.decoderRetained, false);
    assert.equal(result.requests, 0); assert.equal(result.extraDraws, 0); assert.equal(result.lateClosed, true); assert.equal(result.decoders, 1);
    assert.equal(result.pendingAfter, 0); assert.equal(result.held, 0); assert.deepEqual(result.errors, []);
    assert.equal(result.nativeReleased, true, 'decoder originals released');
    assert.equal(result.viewsClosed, true, 'rendered crop views released');
    if (result.renderer === 'webgpu') assert.ok(result.pendingBefore > 0, 'cropped view pending before disposal');
  }
  console.log('viewer termination: disposal, authorization close 4001/4004, disconnect 1006/4003, retained-picture resize, queued decode cleanup and reauthentication passed');
} finally {
  await browser.close();
  await new Promise(resolve => server.close(resolve));
}
