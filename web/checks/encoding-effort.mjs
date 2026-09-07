// Run in Docker with Chromium, foot, GStreamer encoders and a mounted release binary.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, open, readFile, rm } from 'node:fs/promises';
import { chromium } from 'playwright-core';

const root = await mkdtemp('/tmp/elsewhere-effort-');
await mkdir(root + '/runtime', { mode: 0o700 });
const log = await open(root + '/server.log', 'w');
const origin = 'http://127.0.0.1:8095';
const server = spawn(process.env.ELSEWHERE_BINARY || '/src/target/release/elsewhere', [
  '--no-audio', '--no-rtc', '--no-tls', '--render-node', 'none', '--codec', 'vp8', '--listen', '127.0.0.1:8095',
], { cwd: root, env: { ...process.env, HOME: root, XDG_CONFIG_HOME: root + '/config', XDG_RUNTIME_DIR: root + '/runtime' }, stdio: ['ignore', log.fd, log.fd] });
const wait = async predicate => {
  for (let i = 0; i < 400; i++) { if (await predicate()) return; await new Promise(resolve => setTimeout(resolve, 50)); }
  throw new Error('effort check timed out');
};
let browser;
try {
  await wait(async () => { try { return (await fetch(origin)).ok; } catch { return false; } });
  const token = (await readFile(root + '/config/elsewhere/token', 'utf8')).trim();
  browser = await chromium.launch({ executablePath: '/usr/bin/chromium', headless: true, args: ['--no-sandbox'] });
  const context = await browser.newContext({ viewport: { width: 960, height: 720 } });
  const errors = [];
  await context.addInitScript(() => {
    const Original = window.WebSocket;
    window.effortStates = [];
    window.WebSocket = class extends Original {
      constructor(...args) {
        super(...args);
        window.viewerSocket = this;
        this.addEventListener('message', event => {
          if (event.data instanceof ArrayBuffer && new Uint8Array(event.data)[0] === 0x0c) effortStates.push(JSON.parse(new TextDecoder().decode(new Uint8Array(event.data, 1))));
        });
      }
    };
  });
  const connect = async id => {
    const page = await context.newPage();
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(`${origin}/${id ? '?window=' + id : ''}#token=${token}`);
    await page.waitForFunction(() => elsewhere.store.get().streamState?.effort && !elsewhere.store.get().streamState.effort.pending);
    return page;
  };
  const main = await connect(null);
  assert.equal(await main.getByTitle('Encoding effort', { exact: true }).inputValue(), 'fast');
  await main.evaluate(() => elsewhere.spawn('foot --app-id=effort-check'));
  await main.waitForFunction(() => elsewhere.store.get().windows.some(window => window.app_id === 'effort-check'));
  const id = await main.evaluate(() => elsewhere.store.get().windows.find(window => window.app_id === 'effort-check').id);
  const settings = {
    vp8: ['cpu-used=8', 'cpu-used=4', 'cpu-used=2'],
    vp9: ['cpu-used=8', 'cpu-used=6', 'cpu-used=4'],
    h264: ['speed-preset=superfast', 'speed-preset=fast', 'speed-preset=medium'],
    hevc: ['speed-preset=ultrafast', 'speed-preset=superfast', 'speed-preset=fast'],
    av1: ['preset=12', 'preset=10', 'preset=8'],
  };
  for (const windowId of [null, id]) {
    const page = windowId ? await connect(windowId) : main;
    await page.evaluate(() => elsewhere.setChoice({ quality: 'low' }));
    if (process.env.ELSEWHERE_EXPECT_UNSUPPORTED) {
      await page.evaluate(() => elsewhere.setChoice({ codec: 'h264', effort: 'high' }));
      await page.waitForFunction(() => elsewhere.store.get().streamState?.codec === 'h264' && !elsewhere.store.get().streamState.effort.pending);
      const state = await page.evaluate(() => elsewhere.store.get().streamState.effort);
      assert.equal(state.encoder, 'openh264enc');
      assert.equal(state.applied, null);
      assert.equal(state.setting, null);
      assert.equal(await page.locator('[data-effort-status]').textContent(), 'Effort unavailable');
      await page.reload();
      await page.waitForFunction(() => elsewhere.store.get().streamState?.effort?.requested === 'high' && !elsewhere.store.get().streamState.effort.pending);
      await page.waitForFunction(() => elsewhere.store.get().stats.frames > 0);
      assert.equal(await page.getByTitle('Encoding effort', { exact: true }).inputValue(), 'high');
      console.log(windowId ? 'window' : 'desktop', 'unsupported OpenH264 effort remains truthful and saved');
      if (windowId) await page.close();
      continue;
    }
    const codecs = await page.evaluate(() => elsewhere.store.get().codecs.filter(codec => elsewhere.store.get().decodable.includes(codec.codec)).map(codec => codec.codec));
    assert.ok(codecs.length >= 3, 'rig exposes multiple codec implementations');
    for (const codec of codecs) {
      await page.getByTitle('Video codec', { exact: true }).selectOption(codec);
      for (const [index, effort] of ['fast', 'balanced', 'high'].entries()) {
        const frames = await page.evaluate(() => elsewhere.store.get().stats.frames);
        await page.getByTitle('Encoding effort', { exact: true }).selectOption(effort);
        await page.waitForFunction(({ codec, effort }) => {
          const state = elsewhere.store.get().streamState;
          return state?.codec === codec && state.effort.applied === effort && !state.effort.pending;
        }, { codec, effort }).catch(async error => {
          console.error('failed choice', codec, effort, await page.evaluate(() => ({ streamState: elsewhere.store.get().streamState, stats: elsewhere.store.get().stats })));
          throw error;
        });
        await page.waitForFunction(frames => elsewhere.store.get().stats.frames > frames, frames);
        const state = await page.evaluate(() => elsewhere.store.get().streamState);
        assert.equal(state.ceiling_kbps, 5000);
        assert.equal(state.effort.setting, settings[codec][index]);
        assert.ok(await page.locator('[data-effort-status]').evaluate(element => element.scrollWidth <= element.clientWidth), 'effort status fits ' + effort);
        assert.equal(await page.evaluate(() => localStorage.getItem('elsewhere.effort')), effort);
      }
      const old = await page.evaluate(() => elsewhere.store.get().stream.streamId);
      await page.evaluate(() => { window.effortStates = []; elsewhere.setChoice({ effort: 'fast' }); });
      await page.waitForFunction(old => elsewhere.store.get().stream.streamId !== old && elsewhere.store.get().streamState.effort.applied === 'fast', old);
      assert.ok(await page.evaluate(() => effortStates.some(state => state.effort.pending)), 'change reports pending before new stream');
      console.log(windowId ? 'window' : 'desktop', codec, 'all effort mappings applied with unchanged ceiling');
    }
    await page.evaluate(() => elsewhere.setChoice({ codec: 'vp8', effort: 'high' }));
    await page.waitForFunction(() => elsewhere.store.get().streamState?.codec === 'vp8' && elsewhere.store.get().streamState.effort.applied === 'high');
    await page.reload();
    await page.waitForFunction(() => elsewhere.store.get().streamState?.effort?.applied === 'high');
    assert.equal(await page.getByTitle('Encoding effort', { exact: true }).inputValue(), 'high');
    await page.evaluate(() => viewerSocket.close());
    await page.waitForFunction(() => elsewhere.store.get().stats.connects >= 2 && elsewhere.store.get().streamState?.effort?.applied === 'high');
    await page.evaluate(() => { window.pressure = setInterval(() => viewerSocket.send(new Uint8Array([0x96, 200, 0, 0, 0])), 100); });
    await page.waitForFunction(() => elsewhere.store.get().streamState.bitrate_kbps < 5000);
    await page.evaluate(() => elsewhere.setChoice({ effort: 'balanced' }));
    await page.waitForFunction(() => elsewhere.store.get().streamState.effort.applied === 'balanced');
    assert.equal(await page.evaluate(() => elsewhere.store.get().streamState.ceiling_kbps), 5000);
    assert.ok(await page.evaluate(() => elsewhere.store.get().streamState.bitrate_kbps < 5000), 'effort change preserves adapted target');
    await page.evaluate(() => clearInterval(pressure));
    console.log(windowId ? 'window' : 'desktop', 'persistence, reconnect, restart and congestion adaptation passed');
    if (windowId) await page.close();
  }
  for (const width of [640, 800, 960, 1280]) {
    await main.setViewportSize({ width, height: 720 });
    assert.ok(await main.locator('footer').evaluate(footer => footer.scrollWidth <= footer.clientWidth), 'footer fits at ' + width);
  }
  assert.deepEqual(errors, []);
} catch (error) {
  console.error(error, await readFile(root + '/server.log', 'utf8'));
  throw error;
} finally {
  await browser?.close();
  server.kill('SIGTERM');
  await new Promise(resolve => { if (server.exitCode !== null || server.signalCode !== null) resolve(); else server.once('exit', resolve); });
  await log.close();
  await rm(root, { recursive: true, force: true, maxRetries: 5 });
}
