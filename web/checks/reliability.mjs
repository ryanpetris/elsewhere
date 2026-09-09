import { createToken } from './token-fixture.mjs';
// Docker with NET_ADMIN: Wayland Chromium -> compositor -> RTC -> decoded clock markers.
// Default: 3 x 60 seconds for H.264/AV1 at 720p/1080p, with a stable 12 Mbit/s, 20 ms link.
// RELIABILITY_PROFILE=capacity,loss,burst-loss,fallback runs those cases separately. Use clean for smoke checks.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, open, readFile, writeFile, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { basename } from 'node:path';
import { chromium } from 'playwright-core';

const profile = process.env.RELIABILITY_PROFILE ?? 'stable';
assert.ok(['stable', 'capacity', 'loss', 'burst-loss', 'fallback', 'clean'].includes(profile));
const codecs = (process.env.RELIABILITY_CODECS ?? 'h264,av1').split(',');
const sizes = (process.env.RELIABILITY_SIZES ?? '1280x720,1920x1080').split(',').map(size => size.split('x').map(Number));
const repeats = Number(process.env.RELIABILITY_REPEATS ?? 3), seconds = Number(process.env.RELIABILITY_SECONDS ?? 60);
const warmup = Number(process.env.RELIABILITY_WARMUP ?? 6);
const ceiling = Number(process.env.RELIABILITY_BITRATE ?? 8000);
const linkRate = Number(process.env.RELIABILITY_LINK_MBPS ?? 12);
// Delayed packets share this capacity; scale it with the initial rate, then keep it fixed.
const queueLimit = Math.ceil(100 * linkRate / 12);
const scenes = (process.env.RELIABILITY_SCENES ?? process.env.RELIABILITY_SCENE ?? 'cuts,scroll,game,video').split(',');
const viewerCount = Number(process.env.RELIABILITY_VIEWERS ?? 1), blockedCount = Number(process.env.RELIABILITY_BLOCKED_CONSUMERS ?? 0);
const consumerPresets = Array.from({ length: blockedCount }, (_, index) => index % 2 ? 'medium' : 'very-low');
const port = Number(process.env.ELSEWHERE_TEST_PORT ?? 8096), debugPort = port + 1000;
const renderNode = process.env.ELSEWHERE_RENDER_NODE ?? '/dev/dri/renderD128';
const binary = process.env.ELSEWHERE_BINARY ?? '/src/target/release/elsewhere';
const logFilter = process.env.RUST_LOG ?? 'elsewhere_stream=debug,elsewhere_server::rtc=trace,info';
assert.ok(scenes.every(scene => ['cycle', 'cuts', 'scroll', 'game', 'video', 'text'].includes(scene)));
assert.ok(Number.isInteger(viewerCount) && viewerCount > 0 && Number.isInteger(blockedCount) && blockedCount >= 0);
assert.ok(Number.isInteger(repeats) && repeats > 0 && seconds > 0 && warmup >= 0);
assert.ok(Number.isInteger(ceiling) && ceiling >= 1000 && ceiling <= 25000);
assert.ok(Number.isFinite(linkRate) && linkRate > 0 && linkRate <= 1000);
for (const [width, height] of sizes) assert.ok(width >= 800 && height >= 480 && width % 2 === 0 && height % 2 === 0);
const root = process.env.RELIABILITY_OUTPUT ?? await mkdtemp('/tmp/elsewhere-reliability-');
await mkdir(root, { recursive: true });
const command = (name, args) => execFileSync(name, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const optionalCommand = (name, args) => { try { return command(name, args).trim(); } catch { return null; } };
const tc = (...args) => command('tc', args);
const qdiscs = () => JSON.parse(tc('-s', '-j', 'qdisc', 'show', 'dev', 'lo'));
const beforeLink = JSON.parse(command('ip', ['-j', 'link', 'show', 'lo']))[0];
const beforeOffloads = command('ethtool', ['-k', 'lo']);
const offloads = [['tso', 'tcp-segmentation-offload'], ['gso', 'generic-segmentation-offload'], ['gro', 'generic-receive-offload']]
  .map(([flag, name]) => [flag, new RegExp(`^${name}: (on|off)`, 'm').exec(beforeOffloads)?.[1]]);
assert.ok(offloads.every(([, value]) => value), 'loopback segmentation features are readable');
const initialQdisc = qdiscs();
assert.ok(initialQdisc.every(q => q.kind === 'noqueue'), 'run in an isolated rig without an existing loopback shaper');
let shaped = false, configuredLink = false;
function shape() {
  if (profile === 'clean') return;
  configuredLink = true;
  command('ip', ['link', 'set', 'dev', 'lo', 'mtu', '1500']);
  command('ethtool', ['-K', 'lo', 'tso', 'off', 'gso', 'off', 'gro', 'off']);
  tc('qdisc', 'add', 'dev', 'lo', 'root', 'handle', '1:', 'prio', 'priomap', ...Array(16).fill('0')); shaped = true;
  tc('qdisc', 'add', 'dev', 'lo', 'parent', '1:3', 'handle', '30:', 'netem', 'limit', String(queueLimit), 'delay', '20ms',
    'rate', `${linkRate}mbit`, 'loss', ...(profile === 'burst-loss' ? ['gemodel', '0.125%', '25%', '100%', '0%'] : [profile === 'loss' ? '0.5%' : '0%']), 'seed', '42');
  for (const [protocol, priority] of [['tcp', '10'], ['udp', '20']]) {
    tc('filter', 'add', 'dev', 'lo', 'protocol', 'ip', 'parent', '1:', 'prio', priority, 'flower', 'ip_proto', protocol,
      'src_port', String(port), 'flowid', '1:3');
  }
  if (profile === 'fallback') tc('qdisc', 'add', 'dev', 'lo', 'parent', '1:2', 'handle', '20:', 'netem', 'loss', '100%');
}
function capacity(rate) {
  tc('qdisc', 'change', 'dev', 'lo', 'parent', '1:3', 'handle', '30:', 'netem', 'limit', String(queueLimit), 'delay', '20ms', 'rate', rate, 'loss', '0%', 'seed', '42');
}
function blockUdp(block) {
  if (block) tc('filter', 'add', 'dev', 'lo', 'protocol', 'ip', 'parent', '1:', 'prio', '1', 'flower',
    'ip_proto', 'udp', 'src_port', String(port), 'flowid', '1:2');
  else tc('filter', 'del', 'dev', 'lo', 'protocol', 'ip', 'parent', '1:', 'prio', '1');
}
const percentile = (values, fraction) => values.length ? values.slice().sort((a, b) => a - b)[Math.min(values.length - 1, Math.floor(values.length * fraction))] : null;
const distribution = values => ({ p50: percentile(values, .5), p95: percentile(values, .95), p99: percentile(values, .99), max: percentile(values, 1) });
const bins = (events, start, end, period = 100) => {
  const values = Array.from({ length: Math.max(1, Math.ceil((end - start) / period)) }, () => 0);
  for (const event of events) { const index = Math.floor((event.at - start) / period); if (index >= 0 && index < values.length) values[index] += event.bytes; }
  return values.map(bytes => bytes * 8 / (period / 1000) / 1e6);
};
const paintGaps = (start, paints, end) => {
  const times = [start, ...paints, end];
  return times.slice(1).map((time, index) => time - times[index]);
};
const wait = async predicate => {
  for (let attempt = 0; attempt < 600; attempt++) { if (await predicate()) return; await new Promise(resolve => setTimeout(resolve, 50)); }
  throw new Error('reliability condition timed out');
};
const results = [];
try {
  shape(); // The bandwidth and propagation delay exist before ICE, warmup or scene changes.
  const cpuInfo = await readFile('/proc/cpuinfo', 'utf8');
  const gpuPath = `/sys/class/drm/${basename(renderNode)}/device`;
  const [vendor, device] = await Promise.all(['vendor', 'device'].map(name => readFile(`${gpuPath}/${name}`, 'utf8').then(value => value.trim()).catch(() => null)));
  const pci = vendor && device ? optionalCommand('lspci', ['-mm', '-d', `${vendor.slice(2)}:${device.slice(2)}`]) : null;
  const archDrivers = ['libva', 'intel-media-driver', 'mesa', 'libva-mesa-driver'].map(name => optionalCommand('pacman', ['-Q', name])).filter(Boolean);
  const driverPackages = archDrivers.length ? archDrivers : ['libva2', 'intel-media-va-driver', 'intel-media-va-driver-non-free', 'mesa-va-drivers', 'libgl1-mesa-dri']
    .map(name => optionalCommand('dpkg-query', ['-W', '-f=${Package} ${Version}\n', name])).filter(Boolean);
  await writeFile(root + '/environment.json', JSON.stringify({ profile, binary, binary_version: command(binary, ['--version']).trim(),
    binary_sha256: createHash('sha256').update(await readFile(binary)).digest('hex'), renderNode, codecs, sizes, repeats, seconds, warmup, scenes, ceiling_kbps: ceiling, link_mbps: profile === 'clean' ? null : linkRate, viewers: viewerCount, blocked_consumers: blockedCount, blocked_consumer_presets: consumerPresets,
    queue_limit_packets: profile === 'clean' ? null : queueLimit, rust_log: logFilter,
    link: JSON.parse(command('ip', ['-j', 'link', 'show', 'lo'])), offloads: command('ethtool', ['-k', 'lo']), qdisc: qdiscs(),
    ffmpeg: command('ffmpeg', ['-version']).trim(), chromium: command('chromium', ['--version']).trim(), kernel: command('uname', ['-sr']).trim(),
    cpu: { model: /^(?:model name|Hardware)\s*:\s*(.+)$/m.exec(cpuInfo)?.[1] ?? null, logical_processors: (cpuInfo.match(/^processor\s*:/gm) ?? []).length },
    gpu: { vendor, device, models: pci?.split('\n')[0].match(/"([^"]*)"/g)?.slice(1, 3).map(value => value.slice(1, -1)) ?? null }, driver_packages: driverPackages,
    encoder_probe: { libraries: process.env.LD_PRELOAD ?? null, buffer_ms: process.env.ELSEWHERE_PROBE_BUFFER_MS ?? null, hidden_encoder: process.env.ELSEWHERE_PROBE_HIDE_ENCODER ?? null },
    limitations: ['Synthetic scenes do not include game or video decoding work.', 'Clock markers use the shared machine wall clock; canvas paint is not physical display scanout.',
      'Source runs at the compositor refresh rate; video picture updates every other source frame.', 'One-way shaping applies to server traffic; ACKs and CDP are unshaped.',
      'Network and server queue maxima are sampled; 100 ms rates use fixed bins.', 'PSNR and text error are pixel comparisons, not a perceptual quality score.', 'Trace logging and marker readback overhead are included in these measurements.'] }, null, 2));
  for (const [width, height] of sizes) {
    const directory = `${root}/${width}x${height}`;
    await mkdir(directory + '/runtime', { recursive: true, mode: 0o700 });
    const log = await open(directory + '/server.log', 'w');
    const origin = `http://127.0.0.1:${port}`;
    const server = spawn(binary, ['--no-audio', '--no-tls', '--render-node', renderNode, '--codecs', codecs.join(','), '--bitrate', String(ceiling),
      '--screen-size', `${width}x${height}`, '--kiosk', '--listen', `127.0.0.1:${port}`],
    { cwd: directory, env: { ...process.env, HOME: directory, XDG_CONFIG_HOME: directory + '/config', XDG_RUNTIME_DIR: directory + '/runtime',
      RUST_LOG: logFilter, NO_COLOR: '1' }, stdio: ['ignore', log.fd, log.fd] });
    let browser, remote; const consumers = [], consumerLogs = [], extraViewers = [];
    try {
      await wait(async () => { try { return (await fetch(origin)).ok; } catch { return false; } });
      const token = await createToken(directory);
      browser = await chromium.launch({ executablePath: '/usr/bin/chromium', args: ['--no-sandbox', '--disable-background-timer-throttling'] });
      const context = await browser.newContext({ viewport: { width: 1600, height: 1200 } });
      const page = await context.newPage();
      const mediaProperties = [];
      const observeDecoder = async (viewer, index) => {
        const session = await viewer.context().newCDPSession(viewer);
        session.on('Media.playerPropertiesChanged', event => {
          // Other media properties can contain URLs with authentication tokens.
          const properties = event.properties.filter(({ name }) => ['kVideoDecoderName', 'kIsPlatformVideoDecoder'].includes(name));
          if (properties.length) mediaProperties.push({ at: Date.now(), viewer: index, playerId: event.playerId, properties });
        });
        await session.send('Media.enable');
      };
      await observeDecoder(page, 0);
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      await context.addInitScript(({ width, height }) => {
        window.measurement = null; window.captures = {}; window.markerReads = [];
        window.readMarker = context => {
          const start = performance.now();
          const pixels = context.getImageData(8, 8, 768, 40).data;
          const read = (bits, row) => {
            let value = 0;
            for (let bit = 0; bit < bits; bit++) {
              const i = ((row + 8) * 768 + bit * 16 + 8) * 4;
              if ((pixels[i] + pixels[i + 1] + pixels[i + 2]) / 3 > 128) value += 2 ** bit;
            }
            return value;
          };
          const marker = { timestamp: read(48, 0), sequence: read(32, 24) };
          markerReads.push(performance.now() - start);
          return marker;
        };
        const draw = CanvasRenderingContext2D.prototype.drawImage;
        CanvasRenderingContext2D.prototype.drawImage = function(source, ...args) {
          const result = draw.call(this, source, ...args);
          if (source instanceof VideoFrame && measurement && this.canvas.width === width && this.canvas.height === height) {
            const marker = readMarker(this), age = Date.now() - marker.timestamp;
            if (measurement.text && (marker.timestamp <= measurement.textStarted || marker.sequence < 60)) return result;
            const kind = measurement.text ? 'text' : measurement.scene === 'cycle' ? ['cuts', 'scroll', 'game', 'video'][Math.floor(marker.sequence / 900) % 4] : measurement.scene;
            measurement.paints.push({ at: performance.now(), age, sequence: marker.sequence, scene: kind });
            if (age < 0 || age >= 30000) measurement.invalid++;
            else {
              const capture = kind === 'cuts' && marker.sequence % 120 <= 5 ? 'cuts-first' :
                marker.sequence % 60 >= 25 && marker.sequence % 60 <= 35 ? kind : null;
              if (capture && !captures[capture]) {
                const image = document.createElement('canvas'); image.width = width; image.height = height;
                image.getContext('2d').drawImage(this.canvas, 0, 0);
                captures[capture] = { image, marker, captured_at: Date.now(), observed_target_kbps: elsewhere.store.get().streamState?.bitrate_kbps ?? null };
              }
            }
          }
          return result;
        };
        const record = (bytes, transport) => {
          if (!measurement) return;
          const at = performance.now();
          if (bytes[0] === 2) {
            measurement.arrivals.push({ at, bytes: bytes.byteLength, transport });
            measurement.frames.push({ at, bytes: bytes.length - 12, key: !!(bytes[1] & 1) });
          }
          if (bytes[0] === 1) measurement.configs.push({ at, ...JSON.parse(new TextDecoder().decode(bytes.subarray(1))) });
        };
        const create = RTCPeerConnection.prototype.createDataChannel;
        RTCPeerConnection.prototype.createDataChannel = function(...args) {
          const channel = create.apply(this, args), parts = new Map(); let observed;
          channel.addEventListener('message', ({ data }) => {
            if (!measurement) return;
            if (observed !== measurement) { parts.clear(); observed = measurement; }
            const bytes = new Uint8Array(data), view = new DataView(data), id = view.getUint32(1, true), index = view.getUint16(5, true), count = view.getUint16(7, true);
            measurement.arrivals.push({ at: performance.now(), bytes: bytes.length, transport: 'webrtc' });
            let part = parts.get(id);
            if (!part) { part = { bytes: 0, got: 0, video: false, key: false, config: null }; parts.set(id, part); if (parts.size > 8) parts.delete(parts.keys().next().value); }
            if (index === 0) { part.video = bytes[9] === 2; part.key = !!(bytes[10] & 1); if (bytes[9] === 1) part.config = []; }
            if (part.config) part.config[index] = bytes.subarray(9);
            part.bytes += bytes.length - 9; part.got++;
            measurement.partialBytes = Math.max(measurement.partialBytes, [...parts.values()].reduce((sum, part) => sum + part.bytes, 0));
            if (part.got === count) {
              if (part.video) measurement.frames.push({ at: performance.now(), bytes: part.bytes - 12, key: part.key });
              if (part.config) {
                const config = new Uint8Array(part.bytes); let offset = 0;
                for (const chunk of part.config) { config.set(chunk, offset); offset += chunk.length; }
                record(config, 'webrtc');
              }
              parts.delete(id);
            }
          });
          return channel;
        };
        const Original = WebSocket;
        window.WebSocket = class extends Original {
          constructor(...args) { super(...args); this.addEventListener('message', ({ data }) => { if (data instanceof ArrayBuffer) record(new Uint8Array(data), 'websocket'); }); }
          send(data) {
            const bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : ArrayBuffer.isView(data) ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength) : [];
            if (measurement && bytes[0] === 0x88) measurement.keyRequests++;
            super.send(data);
          }
        };
      }, { width, height });
      await page.goto(`${origin}/#token=${token}`);
      await page.waitForFunction(() => elsewhere.store.get().role === 'controller');
      const sceneFile = fileURLToPath(new URL('./effort-scene.html', import.meta.url));
      const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
      await page.evaluate(command => elsewhere.spawn(command), `chromium --no-sandbox --no-first-run --no-default-browser-check --ozone-platform=wayland --user-data-dir=${quote(directory + '/chromium')} --remote-debugging-port=${debugPort} --kiosk ${quote('file://' + sceneFile)}`);
      await wait(async () => { try { return (await fetch(`http://127.0.0.1:${debugPort}/json/version`)).ok; } catch { return false; } });
      remote = await chromium.connectOverCDP(`http://127.0.0.1:${debugPort}`);
      const scene = remote.contexts()[0].pages().find(page => page.url().endsWith('effort-scene.html'));
      assert.ok(scene, 'Wayland source page');
      await scene.waitForFunction(() => typeof drawScene === 'function');
      const available = await page.evaluate(() => elsewhere.store.get().decodable);
      for (const codec of codecs) for (const selectedScene of scenes) for (let repeat = 1; repeat <= repeats; repeat++) {
        const mediaStart = mediaProperties.length;
        assert.ok(available.includes(codec), `browser must decode ${codec}`);
        await scene.evaluate(selectedScene => { window.scene = selectedScene; window.sequence = 0; }, selectedScene);
        await page.evaluate(codec => { elsewhere.setChoice({ codec, quality: 'medium', effort: 'fast' }); elsewhere.setTransport('webrtc'); }, codec);
        await page.reload();
        await page.waitForFunction(codec => elsewhere.store.get().videoVia === 'webrtc' && elsewhere.store.get().streamState?.codec === codec && elsewhere.store.get().stats.frames > 5, codec);
        await page.evaluate(() => elsewhere.setStatsOn(true));
        for (let index = 1; index < viewerCount; index++) {
          const viewer = await page.context().newPage(); extraViewers.push(viewer);
          await observeDecoder(viewer, index);
          await viewer.setViewportSize({ width: Math.max(1600, width + 320), height: Math.max(1200, height + 240) });
          viewer.on('pageerror', error => errors.push(error.message));
          await viewer.addInitScript(({ width, height }) => {
            window.viewerPaints = null;
            const draw = CanvasRenderingContext2D.prototype.drawImage;
            CanvasRenderingContext2D.prototype.drawImage = function(source, ...args) {
              const result = draw.call(this, source, ...args);
              if (source instanceof VideoFrame && viewerPaints && this.canvas.matches('canvas.stage')) {
                if (this.canvas.width !== width || this.canvas.height !== height) {
                  viewerPaints.push({ at: performance.now(), age: -1, width: this.canvas.width, height: this.canvas.height });
                } else viewerPaints.push({ at: performance.now(), age: Date.now() - readMarker(this).timestamp });
              }
              return result;
            };
          }, { width, height });
          await viewer.goto(`${origin}/#token=${token}`);
          await viewer.waitForFunction(({ codec, width, height }) => {
            const state = elsewhere.store.get();
            return state.streamState?.codec === codec && state.stats.frames > 5 && state.videoVia === 'webrtc' && state.stream?.width === width && state.stream?.height === height;
          }, { codec, width, height });
          assert.equal(await viewer.evaluate(() => elsewhere.store.get().renderer), '2d', 'secondary clock observation requires the 2D viewer renderer');
          await viewer.evaluate(() => elsewhere.setStatsOn(true));
        }
        const consumerFiles = [];
        for (let index = 0; index < blockedCount; index++) {
          const path = `${directory}/${codec}-${selectedScene}-${repeat}-consumer-${index}.log`;
          const file = await open(path, 'w'); consumerLogs.push(file); consumerFiles.push(path);
          consumers.push(spawn('python3', [fileURLToPath(new URL('./reliability-consumer.py', import.meta.url)), String(port), token, codec, consumerPresets[index]], { stdio: ['ignore', file.fd, file.fd] }));
        }
        await wait(async () => (await Promise.all(consumerFiles.map(path => readFile(path, 'utf8')))).every(text => text.includes('\"blocked\"')));
        await page.waitForTimeout(warmup * 1000);
        assert.equal(await page.evaluate(() => elsewhere.store.get().renderer), '2d', 'clock observation requires the 2D viewer renderer');
        assert.deepEqual(await scene.evaluate(() => [innerWidth, innerHeight, canvas.width, canvas.height]), [width, height, width, height]);
        const mappings = await readFile(`/proc/${server.pid}/maps`, 'utf8');
        await writeFile(directory + '/drivers.json', JSON.stringify({ va_modules: [...new Set(mappings.split('\n').filter(line => line.includes('_drv_video.so')).map(line => basename(line.trim().split(/\s+/).at(-1))))] }, null, 2));
        const offset = (await stat(directory + '/server.log')).size;
        const qdiscBefore = qdiscs();
        const otherBefore = await Promise.all(extraViewers.map(viewer => viewer.evaluate(() => {
          window.viewerPaints = []; window.markerReads = []; return { start: performance.now(), state: elsewhere.store.get(), visibility: document.visibilityState };
        })));
        const before = await page.evaluate(scene => {
          window.captures = {}; window.markerReads = []; window.measurement = { scene, start: performance.now(), paints: [], arrivals: [], frames: [], configs: [], invalid: 0, partialBytes: 0, keyRequests: 0 };
          return { at: Date.now(), state: elsewhere.store.get() };
        }, selectedScene);
        const events = [], ticks = []; let blocked = false, restored = false, reduced = false, recovered = false;
        while (Date.now() - before.at < seconds * 1000) {
          await page.waitForTimeout(Math.min(100, seconds * 1000 - (Date.now() - before.at)));
          const elapsed = (Date.now() - before.at) / 1000;
          if (profile === 'capacity' && !reduced && elapsed >= seconds / 3) { capacity('4mbit'); reduced = true; events.push({ at: Date.now(), change: 'capacity', rate: '4mbit', qdisc: qdiscs() }); }
          if (profile === 'capacity' && !recovered && elapsed >= seconds * 2 / 3) { capacity(`${linkRate}mbit`); recovered = true; events.push({ at: Date.now(), change: 'capacity', rate: `${linkRate}mbit`, qdisc: qdiscs() }); }
          if (profile === 'fallback' && !blocked && elapsed >= seconds * .3) { blockUdp(true); blocked = true; events.push({ at: Date.now(), change: 'udp-block' }); }
          if (profile === 'fallback' && blocked && !restored && elapsed >= seconds * .6) { blockUdp(false); restored = true; events.push({ at: Date.now(), change: 'udp-restore' }); }
          const state = await page.evaluate(() => { const s = elsewhere.store.get(); return { at: performance.now(), via: s.videoVia, recovery: s.rtcRecovery, stats: s.stats, target: s.streamState.bitrate_kbps }; });
          const viewers = await Promise.all(extraViewers.map(viewer => viewer.evaluate(() => { const s = elsewhere.store.get(); return { stats: s.stats, via: s.videoVia, target: s.streamState.bitrate_kbps }; })));
          ticks.push({ ...state, viewers, qdisc: qdiscs() });
        }
        if (blocked && !restored) blockUdp(false);
        const after = await page.evaluate(() => { const m = measurement; measurement = null; return { at: Date.now(), now: performance.now(), m, markerReads, state: elsewhere.store.get() }; });
        const qdiscAfter = qdiscs();
        const otherAfter = await Promise.all(extraViewers.map(viewer => viewer.evaluate(() => {
          const paints = viewerPaints; viewerPaints = null; return { end: performance.now(), paints, markerReads, state: elsewhere.store.get(), visibility: document.visibilityState };
        })));
        const decoderProperties = mediaProperties.slice(mediaStart);
        const consumersAlive = consumers.every(consumer => consumer.exitCode === null && consumer.signalCode === null);
        for (const consumer of consumers.splice(0)) { consumer.kill('SIGTERM'); await new Promise(resolve => { if (consumer.exitCode !== null || consumer.signalCode !== null) resolve(); else consumer.once('exit', resolve); }); }
        for (const file of consumerLogs.splice(0)) await file.close();
        for (const viewer of extraViewers.splice(0)) await viewer.close();
        const consumerEvents = await Promise.all(consumerFiles.map(async path => (await readFile(path, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line))));
        const file = await open(directory + '/server.log', 'r'), trace = Buffer.alloc((await file.stat()).size - offset);
        await file.read(trace, 0, trace.length, offset); await file.close();
        const text = trace.toString();
        const sampleLines = text.split('\n').filter(line => { const at = Date.parse(line.split(' ')[0]); return at >= before.at && at <= after.at; });
        const streamIds = new Set([before.state.stream.streamId, ...after.m.configs.map(config => config.streamId)]);
        const primarySession = Number(before.state.sessionId);
        const primaryText = sampleLines.filter(line => line.includes('ffmpeg ') ? streamIds.has(Number(/\bstream_id=(\d+)/.exec(line)?.[1])) :
          !line.includes('RTC output queue') || Number(/\bsession=(\d+)/.exec(line)?.[1]) === primarySession).join('\n');
        const fields = (message, key) => [...primaryText.matchAll(new RegExp(`${message}[^\\n]*\\b${key}=(\\d+)`, 'g'))].map(match => Number(match[1]));
        const paints = after.m.paints, valid = paints.filter(paint => paint.age >= 0 && paint.age < 30000);
        const gaps = paintGaps(after.m.start, paints.map(paint => paint.at), after.now);
        const duration = (after.now - after.m.start) / 1000;
        const rates = bins(after.m.arrivals, after.m.start, after.now);
        const encodedEvents = primaryText.split('\n').filter(line => line.includes('ffmpeg encoded')).map(line => ({ at: Date.parse(line.split(' ')[0]),
          bytes: Number(/\bbytes=(\d+)/.exec(line)?.[1]), streamId: Number(/\bstream_id=(\d+)/.exec(line)?.[1]), key: /\bkeyframe=true\b/.test(line) }));
        const encodedRates = bins(encodedEvents, before.at, after.at);
        const networkCounters = qdiscAfter.filter(queue => queue.kind === 'netem').map(queue => {
          const before = qdiscBefore.find(previous => previous.handle === queue.handle);
          return { handle: queue.handle, drops: queue.drops - (before?.drops ?? 0),
            injected_drops: queue.dropped === undefined || before?.dropped === undefined ? null : queue.dropped - before.dropped,
            start_bytes: before?.backlog ?? 0, end_bytes: queue.backlog ?? 0 };
        });
        const reopenKeys = primaryText.split('\n').filter(line => line.includes('ffmpeg encoder open') && line.includes('success=true')).map(line => {
          const streamId = Number(/\bstream_id=(\d+)/.exec(line)?.[1]), openMs = Number(/\bopen_us=(\d+)/.exec(line)?.[1]) / 1000;
          const complete = Date.parse(line.split(' ')[0]), key = encodedEvents.find(event => event.streamId === streamId && event.key);
          return { streamId, open_ms: openMs, open_to_key_ms: key ? key.at - complete + openMs : null };
        });
        const queueEvents = sampleLines.filter(line => line.includes('RTC output queue')).map(line => ({
          at: Date.parse(line.split(' ')[0]), session: Number(/\bsession=(\d+)/.exec(line)?.[1]), bytes: Number(/\bqueued_bytes=(\d+)/.exec(line)?.[1])
        }));
        const queueSessions = [...new Set(queueEvents.map(event => event.session))].map(session => {
          const events = queueEvents.filter(event => event.session === session);
          const quarters = [0, 1, 2, 3].map(quarter => distribution(events.filter(event => event.at >= before.at + quarter * duration * 250 && event.at < before.at + (quarter + 1) * duration * 250).map(event => event.bytes)));
          return { session, bytes_by_quarter: quarters, empty_fraction: events.filter(event => event.bytes === 0).length / events.length,
            longest_without_empty_ms: paintGaps(events[0].at, events.filter(event => event.bytes === 0).map(event => event.at), events.at(-1).at).reduce((max, gap) => Math.max(max, gap), 0) };
        });
        const sequences = valid.map(paint => paint.sequence), span = Math.max(...sequences) - Math.min(...sequences) + 1;
        const row = { codec, width, height, repeat, profile, scene: selectedScene, seconds: duration, ceiling_kbps: ceiling, link_mbps: profile === 'clean' ? null : linkRate, viewers: viewerCount, blocked_consumers: blockedCount,
          queue_limit_packets: profile === 'clean' ? null : queueLimit,
          blocked_consumer_presets: consumerPresets,
          primary_session: primarySession, primary_stream_ids: [...streamIds], capacity_changes: events.filter(event => event.change === 'capacity'), effort: after.state.streamState.effort,
          start_target_kbps: before.state.streamState.bitrate_kbps, end_target_kbps: after.state.streamState.bitrate_kbps,
          target_kbps: distribution(ticks.map(tick => tick.target)), target_kbps_min: Math.min(...ticks.map(tick => tick.target)),
          at_ceiling_fraction: ticks.filter(tick => tick.target === ceiling).length / ticks.length, delivered_fps: paints.length / duration,
          age_ms: distribution(valid.map(paint => paint.age)), gap_ms: distribution(gaps), gaps_over_250ms: gaps.filter(gap => gap > 250).length,
          marker_read_ms: distribution(after.markerReads),
          gaps_over_1s: gaps.filter(gap => gap > 1000).length, invalid_markers: after.m.invalid,
          source_sequence_fps: span / duration, source_sequence_gaps: span - new Set(sequences).size,
          sequence_regressions: sequences.filter((seq, i) => i && seq < sequences[i - 1]).length,
          frame_bytes: distribution(after.m.frames.map(frame => frame.bytes)), encoded_frame_bytes: distribution(fields('ffmpeg encoded', 'bytes')), receive_mbps_100ms: distribution(rates), encoded_mbps_100ms: distribution(encodedRates),
          receive_mbps_1s: distribution(bins(after.m.arrivals, after.m.start, after.now, 1000)), encoded_mbps_1s: distribution(bins(encodedEvents, before.at, after.at, 1000)),
          received_mbps: after.m.arrivals.reduce((sum, arrival) => sum + arrival.bytes, 0) * 8 / duration / 1e6,
          encoded_mbps: encodedEvents.reduce((sum, frame) => sum + frame.bytes, 0) * 8 / duration / 1e6,
          network_counters: networkCounters,
          network_queue_bytes: distribution(ticks.flatMap(tick => tick.qdisc.filter(q => q.kind === 'netem').map(q => q.backlog ?? 0))),
          client_partial_bytes_max: after.m.partialBytes, decoder_queue_max: Math.max(...ticks.map(tick => tick.stats.queue)),
          server_queue_bytes: distribution(fields('RTC output queue', 'queued_bytes')), server_queue_frames: distribution(fields('RTC output queue', 'queued_frames')),
          server_front_accepted_bytes: distribution(fields('RTC output queue', 'sent_bytes')), server_front_age_ms: distribution(fields('RTC output queue', 'front_age_ms')), encoder_ms: distribution(fields('ffmpeg encoded', 'encode_us').map(value => value / 1000)),
          server_transport_pending_bytes: distribution(fields('RTC output queue', 'transport_pending_bytes')), server_progress_age_ms: distribution(fields('RTC output queue', 'progress_age_ms')), all_queue_sessions: queueSessions,
          server_pacing_wait_ms: distribution(fields('RTC output queue', 'pacing_wait_us').map(value => value / 1000)),
          submit_to_packet_ms: distribution(fields('ffmpeg encoded', 'submit_to_packet_us').map(value => value / 1000)),
          encoder_open_ms: distribution(fields('ffmpeg encoder open', 'open_us').map(value => value / 1000)), reopen_to_key_ms: distribution(reopenKeys.map(reopen => reopen.open_to_key_ms).filter(value => value !== null)), reopen_keys: reopenKeys, reopens: streamIds.size - 1,
          lost: after.state.stats.lost - before.state.stats.lost, dropped: after.state.stats.dropped - before.state.stats.dropped,
          decode_errors: after.state.stats.decodeErrors - before.state.stats.decodeErrors, key_requests: after.m.keyRequests,
          rtc_fraction: ticks.filter(tick => tick.via === 'webrtc').length / ticks.length,
          other_viewers: otherAfter.map(({ state, paints, end, visibility, markerReads }, index) => ({ delivered_fps: paints.length / duration,
            marker_read_ms: distribution(markerReads),
            width: state.stream.width, height: state.stream.height,
            gap_ms: distribution(paintGaps(otherBefore[index].start, paints.map(paint => paint.at), end)),
            age_ms: distribution(paints.filter(paint => paint.age >= 0 && paint.age < 30000).map(paint => paint.age)),
            invalid_markers: paints.filter(paint => paint.age < 0 || paint.age >= 30000).length, visibility, start_visibility: otherBefore[index].visibility,
            decode_errors: state.stats.decodeErrors - otherBefore[index].state.stats.decodeErrors, end_target_kbps: state.streamState.bitrate_kbps })),
          scenes: Object.fromEntries(['cuts', 'scroll', 'game', 'video', 'text'].map(kind => [kind, { frames: valid.filter(paint => paint.scene === kind).length, age_ms: distribution(valid.filter(paint => paint.scene === kind).map(paint => paint.age)) }])) };
        // Static text gets a settled picture and a matching source reference outside the timing sample.
        const textStarted = await scene.evaluate(() => { window.scene = 'text'; window.sequence = 0; return Date.now(); });
        await page.waitForTimeout(1000);
        await page.evaluate(textStarted => { delete captures.text; window.measurement = { text: true, textStarted, paints: [], arrivals: [], frames: [], configs: [], invalid: 0, partialBytes: 0, keyRequests: 0 }; }, textStarted);
        await page.waitForFunction(() => !!captures.text);
        const screenshots = await page.evaluate(() => { measurement = null; return Object.entries(captures).map(([scene, { image, ...metadata }]) => ({ scene, ...metadata, png: image.toDataURL() })); });
        row.quality = {};
        const name = `${codec}-${selectedScene}-${profile}-${repeat}`;
        for (const capture of screenshots) {
          const reference = await scene.evaluate(({ width, height, scene, marker }) => {
            const image = document.createElement('canvas'); image.width = width; image.height = height;
            drawScene(image.getContext('2d'), marker.timestamp, marker.sequence, scene === 'cuts-first' ? 'cuts' : scene); return image.toDataURL();
          }, { width, height, ...capture });
          row.quality[capture.scene] = { source_sequence: capture.marker.sequence, source_timestamp: capture.marker.timestamp,
            ...(capture.scene === 'text' ? { text_started_at: textStarted } : {}), captured_at: capture.captured_at, observed_target_kbps: capture.observed_target_kbps, ...await page.evaluate(async ({ reference, kind, width, height }) => {
            const image = new Image(); image.src = reference; await image.decode();
            const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height;
            canvas.getContext('2d').drawImage(image, 0, 0);
            const wanted = canvas.getContext('2d').getImageData(0, 64, width, height - 64).data;
            const actual = captures[kind].image.getContext('2d').getImageData(0, 64, width, height - 64).data;
            let squared = 0, absolute = 0;
            for (let i = 0; i < wanted.length; i += 4) for (let channel = 0; channel < 3; channel++) { const error = wanted[i + channel] - actual[i + channel]; squared += error ** 2; absolute += Math.abs(error); }
            const count = width * (height - 64) * 3, mse = squared / count;
            return { psnr_db: mse ? 10 * Math.log10(255 ** 2 / mse) : 100, mean_absolute_error: absolute / count };
          }, { reference, kind: capture.scene, width, height }) };
          await writeFile(`${directory}/${name}-${capture.scene}.png`, Buffer.from(capture.png.split(',')[1], 'base64'));
          await writeFile(`${directory}/${name}-${capture.scene}-reference.png`, Buffer.from(reference.split(',')[1], 'base64'));
        }
        const formal = seconds >= 60;
        const transportChanges = ticks.filter((tick, index) => !index || tick.via !== ticks[index - 1].via)
          .map(tick => ({ at: before.at + tick.at - after.m.start, via: tick.via }));
        const udpBlock = events.find(event => event.change === 'udp-block'), udpRestore = events.find(event => event.change === 'udp-restore');
        const fallback = udpBlock && transportChanges.find(event => event.at >= udpBlock.at && event.via === 'websocket');
        row.transport_changes = transportChanges;
        row.fallback_ms = fallback ? fallback.at - udpBlock.at : null;
        row.acceptance = {
          controlled_720p: profile === 'stable' && width === 1280 && height === 720 && ceiling === 8000 && linkRate === viewerCount * 12 ? {
            formal_sample: formal, p99_age_below_300ms: row.age_ms.p99 < 300, gap_below_500ms: row.gap_ms.max < 500,
            all_viewer_p99_age_below_300ms: row.age_ms.p99 < 300 && row.other_viewers.every(viewer => viewer.age_ms.p99 < 300),
            all_viewer_gap_below_500ms: row.gap_ms.max < 500 && row.other_viewers.every(viewer => viewer.gap_ms.max < 500),
            server_queue_empties_every_second: queueSessions.some(queue => queue.session === primarySession && queue.longest_without_empty_ms < 1000)
          } : null,
          consumers: blockedCount ? { formal_sample: formal, alive_until_sample_end: consumersAlive,
            requested_states_observed: consumerEvents.every((events, index) => {
              const blocked = events.filter(event => event.phase === 'blocked'), preset = consumerPresets[index];
              const target = preset === 'very-low' ? 2000 : ceiling;
              return blocked.length > 0 && blocked.every(event => event.stream_state?.preset === preset
                && event.stream_state.bitrate_kbps === target && event.stream_state.ceiling_kbps === target
                && event.stream_state.max_fps === (target < 3000 ? 30 : 0));
            }),
            repeated_closures: consumerEvents.every(events => events.filter(event => event.phase === 'replaced' && event.at >= before.at && event.at <= after.at && event.server_closed).length >= 2),
            repeated_blocks: consumerEvents.every(events => events.filter(event => event.phase === 'blocked').length >= 3),
            all_observed_replacements_closed: consumerEvents.every(events => events.filter(event => event.phase === 'replaced').every(event => event.server_closed)) } : null,
          other_viewers: row.other_viewers.every(viewer => viewer.width === width && viewer.height === height && viewer.delivered_fps > 0 && viewer.decode_errors === 0 && viewer.invalid_markers === 0 && viewer.gap_ms.max < 1000),
          primary_isolation_progress: profile === 'clean' && (blockedCount || viewerCount > 1) ? row.gap_ms.max < 1000 : null,
          fallback: profile === 'fallback' ? {
            reached_socket_while_blocked: !!fallback && fallback.at < udpRestore?.at,
            returned_to_rtc: !!fallback && transportChanges.some(event => event.at >= udpRestore?.at && event.via === 'webrtc')
          } : null
        };
        results.push(row);
        await writeFile(root + '/results.json', JSON.stringify(results, null, 2));
        await writeFile(`${directory}/${name}.json`, JSON.stringify({ row, ticks, events, consumerEvents,
          decoder_properties: decoderProperties,
          sample: { wall_start: before.at, wall_end: after.at, monotonic_start: after.m.start, monotonic_end: after.now },
          measurement: after.m, rates, encodedRates, qdiscBefore, qdiscAfter }, null, 2));
        await writeFile(`${directory}/${name}.log`, text);
        console.log(JSON.stringify(row));
        assert.ok(encodedEvents.length > 0, 'native encoding observations are present');
        assert.ok(queueSessions.some(queue => queue.session === primarySession && queue.bytes_by_quarter.some(quarter => Number.isFinite(quarter.max))), 'primary RTC queue observations are present');
        assert.ok(valid.length > 10, 'decoded source clock markers');
        assert.equal(after.m.invalid, 0, 'all source clock markers decode');
        assert.equal(row.decode_errors, 0, 'fresh stream and recovery packets decode');
        assert.ok(row.acceptance.other_viewers, 'other real viewers paint continuously without one-second stalls');
        if (row.acceptance.primary_isolation_progress !== null) assert.ok(row.acceptance.primary_isolation_progress, 'the primary viewer paints continuously during consumer isolation');
        if (blockedCount) {
          assert.ok(consumersAlive, 'blocked consumers remain alive until the sample ends');
          assert.ok(row.acceptance.consumers.requested_states_observed, 'each blocked consumer reports its requested bitrate and frame cap before stopping reads');
          assert.ok(row.acceptance.consumers.all_observed_replacements_closed, 'the server closes blocked consumers');
          if (formal) assert.ok(row.acceptance.consumers.repeated_closures && row.acceptance.consumers.repeated_blocks, 'each blocked consumer is closed and replaced at least twice');
        }
        if (formal && profile === 'fallback') assert.ok(row.acceptance.fallback.reached_socket_while_blocked && row.acceptance.fallback.returned_to_rtc, 'UDP failure falls back to WebSocket and reconnects after restoration');
        assert.deepEqual(errors, []);
      }
    } finally {
      for (const consumer of consumers) consumer.kill('SIGTERM');
      for (const file of consumerLogs) await file.close();
      if (remote) { const session = await remote.newBrowserCDPSession().catch(() => null); await session?.send('Browser.close').catch(() => {}); await remote.close().catch(() => {}); }
      await browser?.close(); server.kill('SIGTERM');
      await new Promise(resolve => { if (server.exitCode !== null || server.signalCode !== null) resolve(); else server.once('exit', resolve); });
      await log.close();
    }
  }
  const failed = results.filter(row => row.acceptance.controlled_720p?.formal_sample &&
    (!row.acceptance.controlled_720p.all_viewer_p99_age_below_300ms || !row.acceptance.controlled_720p.all_viewer_gap_below_500ms));
  assert.equal(failed.length, 0, `controlled 720p timing targets failed: ${failed.map(row => `${row.codec}/${row.scene}/${row.repeat}`).join(', ')}`);
} finally {
  if (shaped) { try { tc('qdisc', 'del', 'dev', 'lo', 'root'); } catch {} }
  if (configuredLink) { command('ip', ['link', 'set', 'dev', 'lo', 'mtu', String(beforeLink.mtu)]); command('ethtool', ['-K', 'lo', ...offloads.flatMap(([flag, value]) => [flag, value])]); }
  console.log('Artifacts:', root);
}
