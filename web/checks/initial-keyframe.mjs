// Run in the Docker rig with Chromium and foot. EXPECT_INITIAL_REQUEST=1 records the baseline.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, open, readFile, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { chromium } from 'playwright-core';
import { createToken } from './token-fixture.mjs';

const root = await mkdtemp(tmpdir() + '/elsewhere-initial-frame-');
await mkdir(root + '/runtime', { mode: 0o700 });
const log = await open(root + '/server.log', 'w');
const origin = 'http://127.0.0.1:8097';
const server = spawn(process.env.ELSEWHERE_BINARY || '/src/target/release/elsewhere',
  ['--no-audio', '--no-rtc', '--no-tls', '--render-node', 'none', '--codecs', 'vp8,vp9', '--listen', '127.0.0.1:8097', '--socket-name', 'wayland-initial-frame'],
  { cwd: root, env: { ...process.env, HOME: root, XDG_CONFIG_HOME: root + '/config', XDG_RUNTIME_DIR: root + '/runtime', RUST_LOG: 'elsewhere_stream::viewer=debug' }, stdio: ['ignore', log.fd, log.fd] });
const wait = async fn => {
  for (let i = 0; i < 200; i++) { if (await fn()) return; await new Promise(resolve => setTimeout(resolve, 50)); }
  throw Error('condition timed out');
};
let browser;
try {
  await wait(async () => { try { return (await fetch(origin)).ok; } catch { return false; } });
  const token = await createToken(root);
  browser = await chromium.launch({ executablePath: '/usr/bin/chromium', args: ['--no-sandbox'] });
  const control = await browser.newPage({ viewport: { width: 1000, height: 700 } });
  await control.goto(origin + '/#token=' + token);
  await control.waitForFunction(() => elsewhere.store.get().status === 'connected');
  await control.evaluate(() => elsewhere.spawn('foot --app-id=initial-frame-check'));
  await control.waitForFunction(() => elsewhere.store.get().windows.some(w => w.app_id === 'initial-frame-check' && w.w > 0 && w.h > 0));
  const id = await control.evaluate(() => elsewhere.store.get().windows.find(w => w.app_id === 'initial-frame-check').id);
  for (const scene of ['idle', 'changing']) {
    if (scene === 'changing') {
      await control.evaluate(() => { elsewhere.type("while :; do printf '%s\\r' \"$(date +%s%N)\"; sleep 0.05; done"); elsewhere.key('Return'); });
    }
    for (const windowId of [null, id]) {
      const context = await browser.newContext({ viewport: { width: 1000, height: 700 } });
      await context.addInitScript(() => {
        localStorage.setItem('elsewhere.codec', 'vp8');
        window.initialFrame = { configs: [], requests: [], frames: [], painted: 0, delivered: 0, hold: true, fail: false, cause: '' };
        const OriginalDecoder = VideoDecoder;
        window.VideoDecoder = class extends OriginalDecoder {
          constructor(init) { initialFrame.error = init.error; const config = initialFrame.configs.length; super({ ...init, output: frame => { initialFrame.painted++; initialFrame.paintedConfig = config; init.output(frame); } }); }
          get decodeQueueSize() { return initialFrame.pressure ? 5 : super.decodeQueueSize; }
          decode(chunk) {
            if (initialFrame.fail) { initialFrame.fail = false; throw Error('Injected decoder failure'); }
            super.decode(chunk);
          }
        };
        const OriginalSocket = WebSocket;
        window.WebSocket = class extends OriginalSocket {
          constructor(...args) { super(...args); initialFrame.socket = this; }
          set onmessage(handler) {
            super.onmessage = event => {
              const bytes = new Uint8Array(event.data), tag = bytes[0];
              if (tag === 1) initialFrame.configs.push(JSON.parse(new TextDecoder().decode(bytes.subarray(1))));
              if (tag === 2) {
                initialFrame.frames.push({ key: !!(bytes[1] & 1), bytes: bytes.length - 12 });
                if (initialFrame.hold && initialFrame.delivered) return;
                initialFrame.delivered++;
              }
              initialFrame.cause = tag === 1 ? 'config' : 'recovery';
              try { handler(event); } finally { initialFrame.cause = ''; }
            };
          }
          send(data) {
            if (new Uint8Array(data)[0] === 0x88) initialFrame.requests.push({ cause: initialFrame.cause || 'explicit', config: initialFrame.configs.length });
            super.send(data);
          }
        };
      });
      const page = await context.newPage();
      // This check exercises the main viewer bundle only; baseline lazy chunks are not opened.
      if (process.env.BASELINE_BUNDLE) await page.route('**/app.js', route => route.fulfill({ path: process.env.BASELINE_BUNDLE, contentType: 'text/javascript' }));
      await page.goto(origin + '/' + (windowId ? '?window=' + windowId : '') + '#token=' + token);
      await page.waitForFunction(() => initialFrame.painted > 0);
      await page.waitForTimeout(1200);
      assert.equal(await page.evaluate(() => elsewhere.store.get().stats.frames), 1, 'viewer painted the first frame while later video was held');
      const sample = await page.evaluate(() => ({
        configs: initialFrame.configs, requests: initialFrame.requests, frames: initialFrame.frames,
        painted: initialFrame.painted, delivered: initialFrame.delivered,
      }));
      assert.equal(sample.delivered, 1);
      assert.equal(sample.painted, 1, 'first frame paints without any subsequent frame');
      assert(sample.frames[0].key, 'first video is a recovery keyframe');
      assert.equal(sample.requests.filter(request => request.cause === 'config' && request.config === 1).length, Number(process.env.EXPECT_INITIAL_REQUEST || 0));
      const streamIds = new Set(sample.configs.map(c => String(c.streamId)));
      const encoded = (await readFile(root + '/server.log', 'utf8')).replace(/\x1b\[[0-9;]*m/g, '').split('\n')
        .filter(line => line.includes('ffmpeg encoded') && streamIds.has(line.match(/stream_id=(\d+)/)?.[1]));
      assert(encoded.length > 0, 'encoder measurements identify the measured stream');
      console.log(JSON.stringify({ scene, viewer: windowId ? 'window' : 'desktop', requests: sample.requests, codec: sample.configs[0].codec,
        frames: sample.frames.length, keyframes: sample.frames.filter(f => f.key).length,
        frameBytes: sample.frames.reduce((n, f) => n + f.bytes, 0),
        encoderFrames: encoded.length, encoderKeyframes: encoded.filter(line => line.includes('keyframe=true')).length,
        encoderBytes: encoded.reduce((n, line) => n + Number(line.match(/bytes=(\d+)/)?.[1] || 0), 0) }));
      // A real decoder failure must still ask for and paint a new recovery frame.
      await page.evaluate(() => { initialFrame.hold = false; initialFrame.fail = true; initialFrame.socket.send(new Uint8Array([0x88])); });
      await page.waitForFunction(() => initialFrame.requests.some(request => request.cause === 'recovery') && initialFrame.painted > 1);
      for (const choice of [{ quality: 'low' }, { codec: 'vp9' }, { codec: 'vp8' }]) {
        const before = await page.evaluate(() => initialFrame.configs.length);
        await page.evaluate(choice => elsewhere.setChoice(choice), choice);
        await page.waitForFunction(before => initialFrame.configs.length > before && initialFrame.paintedConfig === initialFrame.configs.length, before);
      }
      const beforeResize = await page.evaluate(() => initialFrame.configs.length);
      const resizePage = windowId ? page : control;
      const size = resizePage.viewportSize();
      await resizePage.setViewportSize(windowId ? { width: scene === 'idle' ? 600 : 560, height: 500 } : { width: size.width + 40, height: size.height + 30 });
      await page.waitForFunction(before => initialFrame.configs.length > before && initialFrame.paintedConfig === initialFrame.configs.length, beforeResize);
      if (scene === 'changing') {
        for (const failure of ['drop', 'pressure', 'error']) {
          const before = await page.evaluate(failure => {
            const before = { requests: initialFrame.requests.length, painted: initialFrame.painted };
            if (failure === 'drop') elsewhere.dropNext();
            if (failure === 'pressure') initialFrame.pressure = true;
            if (failure === 'error') initialFrame.error(Error('Injected asynchronous decoder error'));
            return before;
          }, failure);
          await page.waitForFunction(before => initialFrame.requests.length > before.requests, before);
          await page.evaluate(() => { initialFrame.pressure = false; });
          await page.waitForFunction(before => initialFrame.painted > before.painted, before);
          console.log(`${windowId ? 'window' : 'desktop'} ${failure} recovery requested a keyframe and resumed painting`);
        }
      }
      await context.close();
    }
  }
} catch (error) {
  console.error(await readFile(root + '/server.log', 'utf8'));
  throw error;
} finally {
  await browser?.close();
  server.kill('SIGTERM');
  await new Promise(resolve => server.exitCode !== null || server.signalCode !== null ? resolve() : server.once('exit', resolve));
  await log.close();
  await rm(root, { recursive: true, force: true, maxRetries: 5 });
}
