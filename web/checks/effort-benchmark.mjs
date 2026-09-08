// Docker: real Wayland Chromium scene -> compositor/encoder -> browser canvas.
// Optional EFFORT_CODECS=vp8,h264 and EFFORT_SECONDS=6 narrow the measurement.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, open, readFile, writeFile, stat } from 'node:fs/promises';
import { chromium } from 'playwright-core';

const root = await mkdtemp('/tmp/elsewhere-effort-benchmark-');
const binary = process.env.ELSEWHERE_BINARY || '/src/target/release/elsewhere';
const [width, height] = (process.env.EFFORT_SIZE || '1280x720').split('x').map(Number);
const bitrate = Number(process.env.EFFORT_BITRATE || 4000);
assert.ok(Number.isInteger(width) && Number.isInteger(height) && width >= 800 && height >= 480 && width % 2 === 0 && height % 2 === 0);
assert.ok(Number.isInteger(bitrate) && bitrate > 0);
await writeFile(root + '/environment.json', JSON.stringify({
  binary_sha256: createHash('sha256').update(await readFile(binary)).digest('hex'),
  ffmpeg: execFileSync('ffmpeg', ['-version'], { encoding: 'utf8' }).split('\n')[0],
  chromium: execFileSync('chromium', ['--version'], { encoding: 'utf8' }).trim(),
  width, height, bitrate, preload: process.env.LD_PRELOAD || null,
  hidden_encoder: process.env.ELSEWHERE_PROBE_HIDE_ENCODER || null,
  probe_buffer_ms: process.env.ELSEWHERE_PROBE_BUFFER_MS || null,
}, null, 2));
await mkdir(root + '/runtime', { mode: 0o700 });
const log = await open(root + '/server.log', 'w');
const origin = 'http://127.0.0.1:8094';
const server = spawn(binary, [
  '--no-audio', '--no-rtc', '--no-tls', '--render-node', 'none', '--codec', 'vp8', '--bitrate', String(bitrate),
  '--screen-size', `${width}x${height}`, '--kiosk', '--listen', '127.0.0.1:8094',
], { cwd: root, env: { ...process.env, HOME: root, XDG_CONFIG_HOME: root + '/config', XDG_RUNTIME_DIR: root + '/runtime',
  RUST_LOG: 'elsewhere_stream=trace,info', NO_COLOR: '1' }, stdio: ['ignore', log.fd, log.fd] });
const wait = async predicate => {
  for (let i = 0; i < 400; i++) { if (await predicate()) return; await new Promise(resolve => setTimeout(resolve, 50)); }
  throw new Error('benchmark condition timed out');
};
const percentile = (values, fraction) => values.length ? values.slice().sort((a, b) => a - b)[Math.min(values.length - 1, Math.floor(values.length * fraction))] : null;
let browser, remote;
try {
  await wait(async () => { try { return (await fetch(origin)).ok; } catch { return false; } });
  const token = (await readFile(root + '/config/elsewhere/token', 'utf8')).trim();
  browser = await chromium.launch({ executablePath: '/usr/bin/chromium', headless: true, args: ['--no-sandbox'] });
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  await page.addInitScript(({ width, height }) => {
    window.measurement = null;
    window.readMarker = ctx => {
      const pixels = ctx.getImageData(8, 8, 768, 40).data;
      const read = (bits, row) => {
        let value = 0;
        for (let bit = 0; bit < bits; bit++) {
          const offset = ((row + 8) * 768 + bit * 16 + 8) * 4;
          if ((pixels[offset] + pixels[offset + 1] + pixels[offset + 2]) / 3 > 128) value += 2 ** bit;
        }
        return value;
      };
      return { timestamp: read(48, 0), sequence: read(32, 24) };
    };
    const draw = CanvasRenderingContext2D.prototype.drawImage;
    CanvasRenderingContext2D.prototype.drawImage = function(source, ...args) {
      const result = draw.call(this, source, ...args);
      if (source instanceof VideoFrame && measurement && this.canvas.width === width && this.canvas.height === height) {
        const marker = readMarker(this), age = Date.now() - marker.timestamp;
        if (age >= 0 && age < 10000) {
          measurement.latency.push(age);
          measurement.sequences.push(marker.sequence);
          if (!window.captured && marker.sequence % 60 === 30) {
            window.captured = document.createElement('canvas');
            captured.width = width; captured.height = height;
            captured.getContext('2d').drawImage(this.canvas, 0, 0);
          }
        } else measurement.invalid++;
      }
      return result;
    };
    const Original = WebSocket;
    window.WebSocket = class extends Original {
      send(data) {
        // Isolate encoder effort at a fixed target; the selection check exercises adaptation.
        if (data instanceof ArrayBuffer && new Uint8Array(data)[0] === 0x96) return;
        super.send(data);
      }
      constructor(...args) {
        super(...args);
        this.addEventListener('message', event => {
          if (measurement && event.data instanceof ArrayBuffer && new Uint8Array(event.data)[0] === 2) {
            measurement.bytes += event.data.byteLength - 12;
            measurement.packets++;
          }
          if (measurement && event.data instanceof ArrayBuffer && new Uint8Array(event.data)[0] === 0x0c) {
            measurement.targets.push(JSON.parse(new TextDecoder().decode(new Uint8Array(event.data, 1))).bitrate_kbps);
          }
        });
      }
    };
  }, { width, height });
  await page.goto(origin + '/#token=' + token);
  await page.waitForFunction(() => elsewhere.store.get().role === 'controller');
  await page.evaluate(command => elsewhere.spawn(command), `chromium --no-sandbox --no-first-run --no-default-browser-check --ozone-platform=wayland --user-data-dir=${root}/chromium --remote-debugging-port=9227 --kiosk file:///src/web/checks/effort-scene.html`);
  await wait(async () => { try { return (await fetch('http://127.0.0.1:9227/json/version')).ok; } catch { return false; } });
  remote = await chromium.connectOverCDP('http://127.0.0.1:9227');
  const scenePage = remote.contexts()[0].pages()[0];
  await scenePage.waitForFunction(() => typeof window.drawScene === 'function');
  await page.evaluate(() => elsewhere.setChoice({ quality: 'medium' }));
  await page.waitForFunction(({ width, height }) => elsewhere.store.get().stream?.width === width && elsewhere.store.get().stream?.height === height, { width, height });
  assert.equal(await page.evaluate(() => elsewhere.store.get().renderer), '2d');
  const available = await page.evaluate(() => elsewhere.store.get().codecs.filter(codec => elsewhere.store.get().decodable.includes(codec.codec)).map(codec => codec.codec));
  const codecs = process.env.EFFORT_CODECS ? process.env.EFFORT_CODECS.split(',') : available;
  const results = [];
  const scenes = process.env.EFFORT_SCENES ? process.env.EFFORT_SCENES.split(',') : ['text', 'scroll', 'motion'];
  for (const codec of codecs) for (const scene of scenes) for (const effort of ['fast', 'high']) {
    assert.ok(['text', 'scroll', 'motion'].includes(scene));
    assert.ok(available.includes(codec), 'browser must decode ' + codec);
    await scenePage.evaluate(scene => { window.scene = scene; }, scene);
    await page.evaluate(choice => elsewhere.setChoice(choice), { codec, effort });
    await page.reload(); // each sample starts with its ceiling and fresh delay history
    await page.waitForFunction(({ codec, effort }) => { const state = elsewhere.store.get().streamState; return state?.codec === codec && state.effort.applied === effort; }, { codec, effort });
    await page.waitForTimeout(2500);
    assert.deepEqual(await scenePage.evaluate(() => [innerWidth, innerHeight, canvas.width, canvas.height]), [width, height, width, height], 'source canvas matches encoded output');
    const beforeLog = (await stat(root + '/server.log')).size;
    const before = await page.evaluate(() => {
      window.captured = null;
      window.measurement = { latency: [], sequences: [], invalid: 0, bytes: 0, packets: 0, targets: [] };
      return { at: Date.now(), stats: elsewhere.store.get().stats, state: elsewhere.store.get().streamState };
    });
    await page.waitForTimeout(Number(process.env.EFFORT_SECONDS || 6) * 1000);
    const after = await page.evaluate(() => {
      const result = { at: Date.now(), measurement, stats: elsewhere.store.get().stats, state: elsewhere.store.get().streamState };
      window.measurement = null;
      if (!window.captured) throw new Error('matched scene phase was not decoded');
      result.marker = readMarker(captured.getContext('2d'));
      result.png = captured.toDataURL();
      return result;
    });
    assert.equal(before.state.bitrate_kbps, bitrate, 'fixed encoder target before sample');
    assert.equal(after.state.bitrate_kbps, bitrate, 'fixed encoder target after sample');
    assert.equal(after.state.ceiling_kbps, bitrate);
    assert.ok(after.measurement.targets.every(target => target === bitrate), 'encoder target stays fixed throughout sample');
    assert.ok(after.measurement.latency.length > 10, 'decoded clock markers');
    assert.equal(after.measurement.invalid, 0, 'all clock markers decode');
    const expected = await scenePage.evaluate(({ marker, scene, width, height }) => {
      const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height;
      drawScene(canvas.getContext('2d'), marker.timestamp, marker.sequence, scene);
      return canvas.toDataURL();
    }, { marker: after.marker, scene, width, height });
    const psnr = await page.evaluate(async ({ expected, width, height }) => {
      const image = new Image(); image.src = expected; await image.decode();
      const reference = document.createElement('canvas'); reference.width = width; reference.height = height;
      reference.getContext('2d').drawImage(image, 0, 0);
      const wanted = reference.getContext('2d').getImageData(0, 64, width, height - 64).data;
      const actual = captured.getContext('2d').getImageData(0, 64, width, height - 64).data;
      let sum = 0;
      for (let i = 0; i < wanted.length; i += 4) for (let channel = 0; channel < 3; channel++) sum += (wanted[i + channel] - actual[i + channel]) ** 2;
      const mse = sum / (width * (height - 64) * 3);
      return mse ? 10 * Math.log10(255 ** 2 / mse) : 100;
    }, { expected, width, height });
    const file = await open(root + '/server.log', 'r');
    const trace = Buffer.alloc((await file.stat()).size - beforeLog);
    await file.read(trace, 0, trace.length, beforeLog); await file.close();
    const encode = [...trace.toString().matchAll(/ffmpeg encoded[^\n]*\bencode_us=(\d+)/g)].map(match => Number(match[1]) / 1000);
    assert.ok(encode.length > 10, 'FFmpeg conversion and encode timing samples');
    const seconds = (after.at - before.at) / 1000;
    const sequences = after.measurement.sequences, unique = new Set(sequences);
    const span = Math.max(...sequences) - Math.min(...sequences) + 1;
    const row = { codec, effort, scene, width, height, encoder: after.state.effort.encoder, compositor_hz: 30, ceiling_kbps: bitrate,
      source_sequence_fps: span / seconds,
      actual_kbps: after.measurement.bytes * 8 / seconds / 1000, delivered_fps: after.measurement.latency.length / seconds,
      encoder_ms: [percentile(encode, .5), percentile(encode, .95)], end_to_end_ms: [percentile(after.measurement.latency, .5), percentile(after.measurement.latency, .95)],
      source_sequence_gaps: span - unique.size, repeated_source_frames: sequences.length - unique.size,
      sequence_regressions: sequences.filter((value, index) => index && value < sequences[index - 1]).length,
      lost: after.stats.lost - before.stats.lost, dropped: after.stats.dropped - before.stats.dropped,
      decode_errors: after.stats.decodeErrors - before.stats.decodeErrors, psnr_db: psnr, seconds, setting: after.state.effort.setting };
    results.push(row);
    const name = `${codec}-${scene}-${effort}`;
    await writeFile(root + '/' + name + '.png', Buffer.from(after.png.split(',')[1], 'base64'));
    await writeFile(root + '/' + name + '-reference.png', Buffer.from(expected.split(',')[1], 'base64'));
    await writeFile(root + '/results.json', JSON.stringify(results, null, 2));
    console.log(JSON.stringify(row));
  }
  console.log('Artifacts:', root);
} catch (error) {
  console.error(error, 'Artifacts:', root);
  throw error;
} finally {
  if (remote) {
    const session = await remote.newBrowserCDPSession().catch(() => null);
    await session?.send('Browser.close').catch(() => {});
    await remote.close().catch(() => {});
  }
  await browser?.close();
  server.kill('SIGTERM');
  await new Promise(resolve => { if (server.exitCode !== null || server.signalCode !== null) resolve(); else server.once('exit', resolve); });
  await log.close();
}
