import { createToken } from './token-fixture.mjs';
// Docker: real Wayland Chromium scene -> compositor/encoder -> browser canvas.
// Optional EFFORT_CODECS=vp8,h264 and EFFORT_SECONDS=6 narrow the measurement.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, open, readFile, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright-core';

const root = await mkdtemp('/tmp/elsewhere-effort-benchmark-');
const binary = process.env.ELSEWHERE_BINARY || '/src/target/release/elsewhere';
const [width, height] = (process.env.EFFORT_SIZE || '1280x720').split('x').map(Number);
const bitrate = Number(process.env.EFFORT_BITRATE || 4000);
const viewerCount = Number(process.env.EFFORT_VIEWERS || 1);
const sampleSeconds = Number(process.env.EFFORT_SECONDS || 6);
assert(Number.isFinite(sampleSeconds) && sampleSeconds >= 3, 'EFFORT_SECONDS must be at least three seconds');
assert(Number.isSafeInteger(viewerCount) && viewerCount > 0);
const clockTicks = Number(execFileSync('getconf', ['CLK_TCK'], { encoding: 'utf8' }));
const pageBytes = Number(execFileSync('getconf', ['PAGESIZE'], { encoding: 'utf8' }));
assert.ok(Number.isInteger(width) && Number.isInteger(height) && width >= 800 && height >= 480 && width % 2 === 0 && height % 2 === 0);
assert.ok(Number.isInteger(bitrate) && bitrate > 0);
await writeFile(root + '/environment.json', JSON.stringify({
  binary_sha256: createHash('sha256').update(await readFile(binary)).digest('hex'),
  ffmpeg: execFileSync('ffmpeg', ['-version'], { encoding: 'utf8' }).split('\n')[0],
  chromium: execFileSync('chromium', ['--version'], { encoding: 'utf8' }).trim(),
  render_node: process.env.ELSEWHERE_RENDER_NODE ?? 'none', software_encoding: Boolean(process.env.ELSEWHERE_SOFTWARE_ENCODING),
  width, height, bitrate, viewer_count: viewerCount, preload: process.env.LD_PRELOAD || null,
  hidden_encoder: process.env.ELSEWHERE_PROBE_HIDE_ENCODER || null,
  probe_buffer_ms: process.env.ELSEWHERE_PROBE_BUFFER_MS || null,
}, null, 2));
await mkdir(root + '/runtime', { mode: 0o700 });
const log = await open(root + '/server.log', 'w');
const origin = 'http://127.0.0.1:8094';
const server = spawn(binary, [
  '--no-audio', '--no-rtc', '--no-tls', '--render-node', process.env.ELSEWHERE_RENDER_NODE ?? 'none', '--codecs', process.env.EFFORT_CODECS ?? 'vp8,h264,hevc,av1,vp9',
  ...(process.env.ELSEWHERE_SOFTWARE_ENCODING ? ['--software-encoding'] : []), '--bitrate', String(bitrate),
  '--screen-size', `${width}x${height}`, '--kiosk', '--listen', '127.0.0.1:8094',
], { cwd: root, env: { ...process.env, HOME: root, XDG_CONFIG_HOME: root + '/config', XDG_RUNTIME_DIR: root + '/runtime',
  ...((process.env.ELSEWHERE_RENDER_NODE ?? 'none') === 'none' ? { __EGL_VENDOR_LIBRARY_FILENAMES: '/usr/share/glvnd/egl_vendor.d/50_mesa.json', LIBGL_ALWAYS_SOFTWARE: '1' } : {}),
  RUST_LOG: 'elsewhere_stream=trace,elsewhere_compositor::gpu=debug,info', NO_COLOR: '1' }, stdio: ['ignore', log.fd, log.fd] });
const wait = async predicate => {
  for (let i = 0; i < 400; i++) { if (await predicate()) return; await new Promise(resolve => setTimeout(resolve, 50)); }
  throw new Error('benchmark condition timed out');
};
const percentile = (values, fraction) => values.length ? values.slice().sort((a, b) => a - b)[Math.min(values.length - 1, Math.floor(values.length * fraction))] : null;
const nativeRates = trace => [...trace.matchAll(/ffmpeg video rate[^\n]*stream_target_kbps=(\d+)[^\n]*encoder_target_bps=(\d+)[^\n]*buffer_bits=(\d+)/g)]
  .map(([, stream, encoder, buffer]) => ({ stream_target_kbps: Number(stream), encoder_target_bps: Number(encoder), encoder_buffer_bits: Number(buffer) }));
let browser, remote;
try {
  await wait(async () => { try { return (await fetch(origin)).ok; } catch { return false; } });
  if ((process.env.ELSEWHERE_RENDER_NODE ?? 'none') === 'none') assert.match(await readFile(root + '/server.log', 'utf8'), /GL Renderer:[^\n]*(llvmpipe|softpipe)/i, 'CPU-only benchmark uses Mesa software rendering');
  const token = await createToken(root);
  const viewerToken = await createToken(root, ['desktop.view']);
  browser = await chromium.launch({ executablePath: '/usr/bin/chromium', headless: true, args: ['--no-sandbox'] });
  const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
  await context.addInitScript(({ width, height }) => {
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
          // Capture the first decoded frame at or after the next target phase; source frames may be skipped.
          measurement.captureAfter ??= marker.sequence + (30 - marker.sequence % 60 + 60) % 60;
          if (!window.captured && marker.sequence >= measurement.captureAfter) {
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
        // Every benchmark page requests the full resolution, independent of browser chrome.
        if (data instanceof ArrayBuffer && new Uint8Array(data)[0] === 0x82) {
          const view = new DataView(data);
          view.setUint16(1, width, true); view.setUint16(3, height, true); view.setFloat32(5, 1, true);
        }
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
  const page = await context.newPage();
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
  const pages = [page];
  for (let index = 1; index < viewerCount; index++) {
    const viewer = await context.newPage();
    await viewer.goto(origin + '/#token=' + viewerToken);
    await viewer.waitForFunction(() => elsewhere.store.get().stats.frames > 0);
    pages.push(viewer);
  }
  const processUsage = () => {
    const fields = readFileSync(`/proc/${server.pid}/stat`, 'utf8').split(') ')[1].split(/\s+/);
    return { at: performance.now(), ticks: Number(fields[11]) + Number(fields[12]), rss_bytes: Number(fields[21]) * pageBytes };
  };
  const results = [];
  const scenes = process.env.EFFORT_SCENES ? process.env.EFFORT_SCENES.split(',') : ['text', 'scroll', 'motion'];
  for (const codec of codecs) for (const scene of scenes) for (const effort of ['fast', 'high']) {
    assert.ok(['text', 'scroll', 'motion'].includes(scene));
    assert.ok(available.includes(codec), 'browser must decode ' + codec);
    await scenePage.evaluate(scene => { window.scene = scene; }, scene);
    for (const viewer of pages) {
      await viewer.evaluate(choice => elsewhere.setChoice(choice), { codec, effort, quality: 'medium' });
      await viewer.reload(); // each sample starts with its ceiling and fresh delay history
      await viewer.waitForFunction(({ codec, effort }) => { const state = elsewhere.store.get().streamState; return state?.codec === codec && state.effort.applied === effort; }, { codec, effort });
      await viewer.waitForFunction(({ width, height }) => elsewhere.store.get().stream?.width === width && elsewhere.store.get().stream?.height === height, { width, height });
    }
    await page.waitForTimeout(2500);
    assert.deepEqual(await scenePage.evaluate(() => [innerWidth, innerHeight, canvas.width, canvas.height]), [width, height, width, height], 'source canvas matches encoded output');
    const precedingTrace = await readFile(root + '/server.log');
    const beforeLog = precedingTrace.length;
    const textureReadback = precedingTrace.includes('verified texture render target and framebuffer readback');
    const noRenderNode = (process.env.ELSEWHERE_RENDER_NODE ?? 'none') === 'none';
    const nvidiaRendering = textureReadback && !noRenderNode;
    if (nvidiaRendering) assert.match(precedingTrace.toString(), /GL Vendor:[^\n]*NVIDIA/i, 'benchmark uses the NVIDIA renderer');
    // All viewers use this fixed target throughout the warmed sample.
    const nativeRate = nativeRates(precedingTrace.toString()).at(-1);
    assert.ok(nativeRate, 'native encoder rate configuration was traced');
    assert.equal(nativeRate.stream_target_kbps, bitrate, 'native configuration uses this stream target');
    const beforeSamples = await Promise.all(pages.map(viewer => viewer.evaluate(() => {
      window.captured = null;
      window.measurement = { latency: [], sequences: [], invalid: 0, bytes: 0, packets: 0, targets: [] };
      return { at: Date.now(), stats: elsewhere.store.get().stats, state: elsewhere.store.get().streamState };
    })));
    const resources = [];
    let previousUsage = processUsage();
    const resourceTimer = setInterval(() => {
      const current = processUsage();
      let gpus = [];
      try {
        if (nvidiaRendering) gpus = execFileSync('nvidia-smi', ['--query-gpu=index,utilization.gpu,utilization.encoder,memory.used', '--format=csv,noheader,nounits'], { encoding: 'utf8', timeout: 2000, stdio: ['ignore', 'pipe', 'ignore'] }).trim().split('\n').map(line => {
          const [index, gpu, encoder, memory] = line.split(',').map(Number);
          return { index, utilization_percent: gpu, encoder_percent: encoder, memory_mib: memory };
        });
      } catch {}
      resources.push({ at: Date.now(), cpu_percent: (current.ticks - previousUsage.ticks) / clockTicks / ((current.at - previousUsage.at) / 1000) * 100, rss_bytes: current.rss_bytes, gpus });
      previousUsage = current;
    }, 1000);
    try { await page.waitForTimeout(sampleSeconds * 1000); }
    finally { clearInterval(resourceTimer); }
    const endLog = (await readFile(root + '/server.log')).length;
    const afterSamples = await Promise.all(pages.map(viewer => viewer.evaluate(() => {
      const result = { at: Date.now(), measurement, stats: elsewhere.store.get().stats, state: elsewhere.store.get().streamState };
      window.measurement = null;
      if (!window.captured) throw new Error('no scene frame reached the screenshot phase');
      result.marker = readMarker(captured.getContext('2d'));
      return result;
    })));
    const before = beforeSamples[0], after = afterSamples[0];
    assert.equal(before.state.bitrate_kbps, bitrate, 'fixed stream target before sample');
    assert.equal(after.state.bitrate_kbps, bitrate, 'fixed stream target after sample');
    assert.equal(after.state.ceiling_kbps, bitrate);
    assert.ok(after.measurement.targets.every(target => target === bitrate), 'stream target stays fixed throughout sample');
    assert.ok(after.measurement.latency.length > 10, 'decoded clock markers');
    assert.equal(after.measurement.invalid, 0, 'all clock markers decode');
    after.png = await page.evaluate(() => captured.toDataURL());
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
    const trace = Buffer.alloc(endLog - beforeLog);
    await file.read(trace, 0, trace.length, beforeLog); await file.close();
    const encode = [...trace.toString().matchAll(/ffmpeg encoded[^\n]*\bencode_us=(\d+)/g)].map(match => Number(match[1]) / 1000);
    assert.ok(encode.length > 10, 'FFmpeg conversion and encode timing samples');
    const timings = field => [...trace.toString().matchAll(new RegExp(`\\b${field}=(\\d+)`, 'g'))].map(match => Number(match[1]) / 1000);
    const readback = [...trace.toString().matchAll(/framebuffer readback[^\n]*\bwidth=(\d+)[^\n]*\bheight=(\d+)[^\n]*\breadback_us=(\d+)/g)]
      .filter(([, w, h]) => Number(w) === width && Number(h) === height).map(([, , , micros]) => Number(micros) / 1000);
    const conversion = timings('conversion_us'), encodeOnly = timings('encode_only_us');
    assert.ok(conversion.length > 10 && encodeOnly.length > 10, 'separate conversion and encoder timing samples');
    if (textureReadback || noRenderNode || after.state.effort.encoder.endsWith('_nvenc')) assert.ok(readback.length > 10, 'framebuffer readback timing samples');
    for (const rate of nativeRates(trace.toString())) assert.deepEqual(rate, nativeRate, 'native encoder rate stays fixed throughout sample');
    const seconds = (after.at - before.at) / 1000;
    const sequences = after.measurement.sequences, unique = new Set(sequences);
    const span = Math.max(...sequences) - Math.min(...sequences) + 1;
    const perViewer = afterSamples.map((sample, index) => {
      const previous = beforeSamples[index], seconds = (sample.at - previous.at) / 1000;
      assert.equal(sample.measurement.invalid, 0, 'all viewer markers decode');
      assert.ok(sample.measurement.latency.length > 10, 'each viewer receives scene frames');
      assert.equal(sample.state.bitrate_kbps, bitrate, 'each viewer keeps the requested bitrate');
      assert.ok(sample.measurement.targets.every(target => target === bitrate), 'each viewer keeps its target throughout the sample');
      return { viewer: index, delivered_fps: sample.measurement.latency.length / seconds, actual_kbps: sample.measurement.bytes * 8 / seconds / 1000,
        end_to_end_ms: [percentile(sample.measurement.latency, .5), percentile(sample.measurement.latency, .95)],
        lost: sample.stats.lost - previous.stats.lost, dropped: sample.stats.dropped - previous.stats.dropped,
        decode_errors: sample.stats.decodeErrors - previous.stats.decodeErrors };
    });
    assert.ok(resources.length >= 2, 'process resource samples');
    assert.ok(resources.every(sample => sample.gpus.every(gpu => Object.values(gpu).every(Number.isFinite))), 'GPU resource fields are numeric');
    if (nvidiaRendering || after.state.effort.encoder.endsWith('_nvenc')) assert.ok(resources.every(sample => sample.gpus.length > 0), 'NVIDIA utilization and memory samples');
    const row = { codec, effort, scene, width, height, viewer_count: viewerCount, per_viewer: perViewer,
      cpu_percent: [percentile(resources.map(sample => sample.cpu_percent), .5), Math.max(...resources.map(sample => sample.cpu_percent))],
      rss_bytes: [percentile(resources.map(sample => sample.rss_bytes), .5), Math.max(...resources.map(sample => sample.rss_bytes))], resources, encoder: after.state.effort.encoder, compositor_hz: process.env.ELSEWHERE_RENDER_NODE && process.env.ELSEWHERE_RENDER_NODE !== 'none' && !process.env.ELSEWHERE_SOFTWARE_ENCODING ? 60 : 30, ceiling_kbps: bitrate, ...nativeRate,
      source_sequence_fps: span / seconds,
      actual_kbps: after.measurement.bytes * 8 / seconds / 1000, delivered_fps: after.measurement.latency.length / seconds,
      readback_ms: [percentile(readback, .5), percentile(readback, .95)], conversion_ms: [percentile(conversion, .5), percentile(conversion, .95)],
      encode_only_ms: [percentile(encodeOnly, .5), percentile(encodeOnly, .95)], encoder_ms: [percentile(encode, .5), percentile(encode, .95)], end_to_end_ms: [percentile(after.measurement.latency, .5), percentile(after.measurement.latency, .95)],
      source_sequence_gaps: span - unique.size, repeated_source_frames: sequences.length - unique.size,
      sequence_regressions: sequences.filter((value, index) => index && value < sequences[index - 1]).length,
      lost: after.stats.lost - before.stats.lost, dropped: after.stats.dropped - before.stats.dropped,
      decode_errors: after.stats.decodeErrors - before.stats.decodeErrors, psnr_db: psnr,
      capture_sequence: after.marker.sequence, capture_phase: after.marker.sequence % 60,
      capture_phase_skip: after.marker.sequence - after.measurement.captureAfter,
      seconds, setting: after.state.effort.setting };
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
