import { createToken } from './token-fixture.mjs';
// Docker GPU check: a headed Wayland Chromium exposes the actual VAAPI HEVC decoder.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, open, readFile } from 'node:fs/promises';
import { chromium } from 'playwright-core';

const root = await mkdtemp('/tmp/elsewhere-hevc-browser-');
const binary = process.env.ELSEWHERE_BINARY || '/src/target/release/elsewhere';
const children = [], logs = [];
let browser;
async function desktop(name, port, software) {
  const runtime = `${root}/${name}`;
  await mkdir(runtime, { mode: 0o700 });
  const log = await open(`${root}/${name}.log`, 'w'); logs.push(log);
  const child = spawn(binary, ['--no-audio', '--no-rtc', '--no-tls', '--listen', `127.0.0.1:${port}`,
    '--render-node', software ? (process.env.ELSEWHERE_BROWSER_RENDER_NODE ?? '/dev/dri/renderD128') : (process.env.ELSEWHERE_RENDER_NODE ?? '/dev/dri/renderD128'),
    '--socket-name', name, '--screen-size', '1280x720', '--codecs', software ? 'vp8' : 'hevc',
    ...(software ? ['--software-encoding'] : [])],
  { env: { ...process.env, XDG_RUNTIME_DIR: runtime, XDG_CONFIG_HOME: runtime + '/config' }, stdio: ['ignore', log.fd, log.fd] });
  children.push(child);
  for (let i = 0; i < 200; i++) {
    try { if ((await fetch(`http://127.0.0.1:${port}`)).ok) return runtime; } catch {}
    assert.equal(child.exitCode, null, await readFile(`${root}/${name}.log`, 'utf8'));
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error('desktop startup timed out');
}

try {
  const host = await desktop('browser-host', 8848, true);
  const target = await desktop('hevc-source', 8849, false);
  const token = await createToken(target);
  browser = await chromium.launch({ executablePath: '/usr/bin/chromium', headless: false,
    args: ['--no-sandbox', '--ozone-platform=wayland'],
    env: { ...process.env, XDG_RUNTIME_DIR: host, WAYLAND_DISPLAY: 'browser-host' } });
  const context = await browser.newContext({ viewport: { width: 1100, height: 800 } });
  await context.addInitScript(() => {
    const NativeDecoder = VideoDecoder, NativeSocket = WebSocket;
    window.hevcKeys = [];
    window.VideoDecoder = class extends NativeDecoder {
      configure(config) { this.lastConfig = config; super.configure(config); }
      decode(chunk) {
        if (chunk.type === 'key' && this.lastConfig.codec.startsWith('hev1')) {
          const data = new Uint8Array(chunk.byteLength); chunk.copyTo(data);
          hevcKeys.push({ config: this.lastConfig, data, timestamp: chunk.timestamp, streamId: elsewhere.store.get().stream.streamId });
        }
        super.decode(chunk);
      }
    };
    window.WebSocket = class extends NativeSocket {
      constructor(...args) { super(...args); window.viewerSocket = this; }
    };
    window.checkFreshHevc = async () => {
      const stream = elsewhere.store.get().stream;
      const key = hevcKeys.findLast(key => key.streamId === stream.streamId);
      let frames = 0, failure, width, height;
      const decoder = new NativeDecoder({ output(frame) { frames++; width = frame.displayWidth; height = frame.displayHeight; frame.close(); }, error(error) { failure = error.message; } });
      try {
        decoder.configure(key.config);
        decoder.decode(new EncodedVideoChunk({ type: 'key', data: key.data, timestamp: key.timestamp }));
        await decoder.flush();
        return { frames, failure, codec: key.config.codec, width, height, expectedWidth: stream.width, expectedHeight: stream.height };
      } finally { if (decoder.state !== 'closed') decoder.close(); }
    };
  });
  const errors = [];
  async function connect(id) {
    const page = await context.newPage();
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(`http://127.0.0.1:8849/${id ? '?window=' + id : ''}#token=${token}`);
    await page.waitForFunction(() => elsewhere.store.get().stats.frames > 0 && elsewhere.store.get().streamState?.codec === 'hevc' && hevcKeys.length > 0);
    assert.ok(await page.evaluate(() => elsewhere.store.get().decodable.includes('hevc')));
    assert.equal(await page.evaluate(async () => (await VideoDecoder.isConfigSupported({ codec: hevcKeys.at(-1).config.codec,
      codedWidth: 1280, codedHeight: 720, hardwareAcceleration: 'prefer-hardware' })).supported), true);
    return page;
  }
  const main = await connect();
  await main.evaluate(() => elsewhere.spawn('foot --app-id=hevc-check'));
  await main.waitForFunction(() => elsewhere.store.get().windows.some(window => window.app_id === 'hevc-check'));
  const id = await main.evaluate(() => elsewhere.store.get().windows.find(window => window.app_id === 'hevc-check').id);
  const decodedKey = async page => {
    const decoded = await page.evaluate(() => checkFreshHevc());
    assert.ok(decoded.frames > 0 && !decoded.failure, JSON.stringify(decoded));
    assert.deepEqual([decoded.width, decoded.height], [decoded.expectedWidth, decoded.expectedHeight]);
    return decoded;
  };
  for (const [name, page] of [['desktop', main], ['window', await connect(id)]]) {
    let decoded = await decodedKey(page);
    const keys = await page.evaluate(() => hevcKeys.length);
    await page.evaluate(() => viewerSocket.send(new Uint8Array([0x88])));
    await page.waitForFunction(keys => hevcKeys.slice(keys).some(key => key.streamId === elsewhere.store.get().stream.streamId), keys);
    decoded = await decodedKey(page);
    for (const choice of [{ quality: 'low', effort: 'balanced' }, { quality: 'high', effort: 'fast' }]) {
      const previous = await page.evaluate(() => elsewhere.store.get().stream.streamId);
      const keys = await page.evaluate(() => hevcKeys.length);
      await page.evaluate(choice => elsewhere.setChoice(choice), choice);
      await page.waitForFunction(({ previous, keys, effort, target }) => elsewhere.store.get().stream.streamId !== previous
        && elsewhere.store.get().streamState?.effort.requested === effort && !elsewhere.store.get().streamState.effort.pending
        && elsewhere.store.get().streamState.ceiling_kbps === target && elsewhere.store.get().streamState.bitrate_kbps === target
        && hevcKeys.slice(keys).some(key => key.streamId === elsewhere.store.get().stream.streamId),
      { previous, keys, effort: choice.effort, target: choice.quality === 'low' ? 5000 : 12000 });
      decoded = await decodedKey(page);
    }
    console.log(name, 'hardware HEVC decode, requested recovery key and bitrate/effort reopen passed', JSON.stringify(decoded));
  }
  assert.deepEqual(errors, []);
  console.log('HEVC browser artifacts:', root);
} finally {
  await browser?.close();
  for (const child of children.reverse()) {
    child.kill('SIGTERM');
    await new Promise(resolve => { if (child.exitCode !== null || child.signalCode !== null) resolve(); else child.once('exit', resolve); });
  }
  await Promise.all(logs.map(log => log.close()));
}
