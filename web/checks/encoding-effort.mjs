// Run in Docker with Chromium, foot, FFmpeg encoders and a mounted release binary.
// ELSEWHERE_RENDER_NODE selects hardware; ELSEWHERE_SOFTWARE_ENCODING keeps GPU rendering.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, open, readFile, rm } from 'node:fs/promises';
import { chromium } from 'playwright-core';

const root = await mkdtemp('/tmp/elsewhere-effort-');
const renderNode = process.env.ELSEWHERE_RENDER_NODE ?? 'none';
const initialCodec = process.env.ELSEWHERE_CODEC ?? (renderNode === 'none' || process.env.ELSEWHERE_SOFTWARE_ENCODING ? 'vp8' : 'h264');
const listen = `127.0.0.1:${process.env.ELSEWHERE_TEST_PORT ?? 8095}`;
await mkdir(root + '/runtime', { mode: 0o700 });
const log = await open(root + '/server.log', 'w');
const origin = `http://${listen}`;
const server = spawn(process.env.ELSEWHERE_BINARY || '/src/target/release/elsewhere', [
  '--no-audio', '--no-rtc', '--no-tls', '--render-node', renderNode, '--codec', initialCodec,
  ...(process.env.ELSEWHERE_SOFTWARE_ENCODING ? ['--software-encoding'] : []), '--listen', listen,
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
    libvpx: ['cpu-used=8', 'cpu-used=4', 'cpu-used=2'],
    'libvpx-vp9': ['cpu-used=8', 'cpu-used=6', 'cpu-used=4'],
    libx264: ['preset=superfast', 'preset=fast', 'preset=medium'],
    libx265: ['preset=ultrafast', 'preset=superfast', 'preset=fast'],
    'libaom-av1': ['cpu-used=8', 'cpu-used=6', 'cpu-used=4'],
  };
  for (const windowId of [null, id]) {
    const page = windowId ? await connect(windowId) : main;
    await page.evaluate(() => elsewhere.setChoice({ quality: 'low' }));
    if (process.env.ELSEWHERE_EXPECT_UNSUPPORTED) {
      await page.evaluate(() => elsewhere.setChoice({ codec: 'h264', effort: 'high' }));
      await page.waitForFunction(() => elsewhere.store.get().streamState?.codec === 'h264' && !elsewhere.store.get().streamState.effort.pending);
      const state = await page.evaluate(() => elsewhere.store.get().streamState.effort);
      assert.equal(state.encoder, 'libopenh264');
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
      let qualityMaximum;
      await page.getByTitle('Video codec', { exact: true }).selectOption(codec);
      for (const [index, effort] of ['fast', 'balanced', 'high'].entries()) {
        const frames = await page.evaluate(() => elsewhere.store.get().stats.frames);
        await page.getByTitle('Encoding effort', { exact: true }).selectOption(effort);
        await page.waitForFunction(({ codec, effort }) => {
          const state = elsewhere.store.get().streamState;
          return state?.codec === codec && state.effort.requested === effort && !state.effort.pending;
        }, { codec, effort }).catch(async error => {
          console.error('failed choice', codec, effort, await page.evaluate(() => ({ streamState: elsewhere.store.get().streamState, stats: elsewhere.store.get().stats })));
          throw error;
        });
        await page.waitForFunction(frames => elsewhere.store.get().stats.frames > frames, frames);
        const state = await page.evaluate(() => elsewhere.store.get().streamState);
        assert.equal(state.ceiling_kbps, 5000);
        const { encoder, applied, setting } = state.effort;
        if (encoder.endsWith('_vaapi')) {
          if (index === 0) {
            qualityMaximum = setting === null ? null : Number(/^compression_level=(\d+)$/.exec(setting)?.[1]);
            assert.ok(qualityMaximum === null || Number.isInteger(qualityMaximum) && qualityMaximum > 0, 'VA effort reports its driver quality range');
          }
          assert.equal(applied, qualityMaximum === null ? null : effort);
          assert.equal(setting, qualityMaximum === null ? null : `compression_level=${[qualityMaximum, Math.ceil(qualityMaximum / 2), 1][index]}`);
        } else if (encoder === 'libopenh264') {
          assert.equal(applied, null); assert.equal(setting, null);
        } else {
          assert.equal(applied, effort);
          assert.ok(settings[encoder], `known FFmpeg effort mapping for ${encoder}`);
          assert.equal(setting, settings[encoder][index]);
        }
        if (applied === null) assert.equal(await page.locator('[data-effort-status]').textContent(), 'Effort unavailable');
        assert.ok(await page.locator('[data-effort-status]').evaluate(element => element.scrollWidth <= element.clientWidth), 'effort status fits ' + effort);
        assert.equal(await page.evaluate(() => localStorage.getItem('elsewhere.effort')), effort);
      }
      const old = await page.evaluate(() => elsewhere.store.get().stream.streamId);
      await page.evaluate(() => { window.effortStates = []; elsewhere.setChoice({ effort: 'fast' }); });
      await page.waitForFunction(old => elsewhere.store.get().stream.streamId !== old && elsewhere.store.get().streamState.effort.requested === 'fast' && !elsewhere.store.get().streamState.effort.pending, old);
      assert.ok(await page.evaluate(() => effortStates.some(state => state.effort.pending)), 'change reports pending before new stream');
      console.log(windowId ? 'window' : 'desktop', codec, 'all effort states verified with unchanged ceiling');
    }
    await page.evaluate(codec => elsewhere.setChoice({ codec, effort: 'high' }), initialCodec);
    await page.waitForFunction(codec => elsewhere.store.get().streamState?.codec === codec && elsewhere.store.get().streamState.effort.requested === 'high' && !elsewhere.store.get().streamState.effort.pending, initialCodec);
    const savedEffort = await page.evaluate(() => elsewhere.store.get().streamState.effort);
    await page.reload();
    await page.waitForFunction(() => elsewhere.store.get().streamState?.effort?.requested === 'high' && !elsewhere.store.get().streamState.effort.pending);
    await page.waitForFunction(() => elsewhere.store.get().stats.frames > 0);
    assert.deepEqual(await page.evaluate(() => elsewhere.store.get().streamState.effort), savedEffort);
    assert.equal(await page.getByTitle('Encoding effort', { exact: true }).inputValue(), 'high');
    await page.evaluate(() => viewerSocket.close());
    await page.waitForFunction(() => elsewhere.store.get().stats.connects >= 2 && elsewhere.store.get().streamState?.effort?.requested === 'high' && !elsewhere.store.get().streamState.effort.pending);
    assert.deepEqual(await page.evaluate(() => elsewhere.store.get().streamState.effort), savedEffort);
    await page.evaluate(() => { window.pressure = setInterval(() => viewerSocket.send(new Uint8Array([0x96, 200, 0, 0, 0])), 100); });
    await page.waitForFunction(() => elsewhere.store.get().streamState.bitrate_kbps < 5000);
    await page.evaluate(() => elsewhere.setChoice({ effort: 'balanced' }));
    await page.waitForFunction(() => elsewhere.store.get().streamState.effort.requested === 'balanced' && !elsewhere.store.get().streamState.effort.pending);
    assert.equal(await page.evaluate(() => elsewhere.store.get().streamState.effort.applied), savedEffort.applied === null ? null : 'balanced');
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
