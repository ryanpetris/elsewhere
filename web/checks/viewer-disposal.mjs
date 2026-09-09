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
    return res.end(JSON.stringify(path === '/api/codecs' ? [{ codec: 'vp8', hardware: false }] : path === '/api/me' ? { permissions: ['desktop.view', 'desktop.control', 'clipboard.read', 'clipboard.write'] } : path === '/api/clipboard/state' ? { observation: 'fixture:0', operation: null, present: false, mime: null, size: 0, preview: 'empty' } : []));
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
  for (const renderer of ['2d', 'webgpu']) {
    const page = await browser.newPage();
    await page.addInitScript(({ renderer, CONFIG, VIDEO, ROLE, key }) => {
      const probe = window.probe = { outputs: 0, draws: 0, hold: false, held: new Map(), delivered: [], decoders: [], errors: [] };
      addEventListener('error', event => probe.errors.push(event.message));
      addEventListener('unhandledrejection', event => probe.errors.push(String(event.reason)));
      const Decoder = VideoDecoder;
      window.VideoDecoder = class extends Decoder {
        constructor(init) {
          super({ ...init, output: frame => { probe.outputs++; probe.delivered.push(frame); init.output(frame); } });
          probe.decoders.push(this); probe.output = init.output; probe.error = init.error;
        }
      };
      const draw = CanvasRenderingContext2D.prototype.drawImage;
      CanvasRenderingContext2D.prototype.drawImage = function (...args) {
        if (this.canvas.matches('canvas.stage')) probe.draws++;
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
          createBindGroup() {}, importExternalTexture() {}, createCommandEncoder: () => ({ beginRenderPass: () => pass, finish() {} }),
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
        constructor() { window.socket = this; queueMicrotask(() => this.onopen?.({})); }
        send() {} close() {}
      };
      let seq = 0;
      probe.configure = () => {
        socket.onmessage({ data: new Uint8Array([ROLE, 2, 0]).buffer });
        socket.onmessage({ data: new Uint8Array([CONFIG, ...new TextEncoder().encode(JSON.stringify({ streamId: 1, codec: 'vp8', width: 64, height: 64, scale: 1 }))]).buffer });
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
    if (renderer === 'webgpu') {
      await page.evaluate(() => { probe.hold = true; probe.feed(); });
      await page.waitForFunction(() => probe.held.size === 1);
    }
    const result = await page.evaluate(async () => {
      const decoder = probe.decoders.at(-1), pending = probe.delivered.at(-1), callbacks = [...probe.held.values()], outputsBefore = probe.outputs;
      for (let i = 0; i < 12; i++) probe.feed();
      const queued = decoder.decodeQueueSize, before = probe.draws, pendingBefore = pending.codedWidth;
      elsewhere.dispose(); elsewhere.dispose();
      const state = decoder.state, pendingAfter = pending.codedWidth, held = probe.held.size;
      await new Promise(resolve => setTimeout(resolve, 150));
      // A callback already handed to the application must close its frame without painting or recovering.
      const late = new VideoFrame(document.createElement('canvas'), { timestamp: 50000 });
      probe.output(late); probe.error(new Error('late decoder callback'));
      for (const callback of callbacks) callback(performance.now());
      return { renderer: elsewhere.store.get().renderer, queued, state, status: elsewhere.store.get().status,
        decoderRetained: elsewhere().decoder !== undefined, pendingBefore, pendingAfter,
        held, nativeOutputsAfterDispose: probe.outputs - outputsBefore, lateClosed: late.codedWidth === 0, extraDraws: probe.draws - before, decoders: probe.decoders.length, errors: probe.errors };
    });
    results.push(result);
    await page.close();
  }
  console.log(JSON.stringify(results));
  for (const result of results) {
    assert.ok(result.queued > 0, 'native decode work was queued at disposal');
    assert.equal(result.state, 'closed'); assert.equal(result.status, 'closed'); assert.equal(result.decoderRetained, false);
    assert.equal(result.extraDraws, 0); assert.equal(result.lateClosed, true); assert.equal(result.decoders, 1);
    assert.equal(result.pendingAfter, 0); assert.equal(result.held, 0); assert.deepEqual(result.errors, []);
    if (result.renderer === 'webgpu') assert.ok(result.pendingBefore > 0, 'a real decoded frame was pending for WebGPU');
  }
  console.log('viewer disposal: native queued decode, late callbacks, pending frame/animation cleanup and repeated disposal passed');
} finally {
  await browser.close();
  await new Promise(resolve => server.close(resolve));
}
