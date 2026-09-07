// Run in the Docker desktop rig with FFmpeg, Chromium, nginx, Node and the current binary.
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { spawn, execFileSync, spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, open, readFile, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright-core';
const root = await mkdtemp('/tmp/elsewhere-broadcast-check-');
const children = [], handles = [];
const withAudio = process.env.BROADCAST_AUDIO === '1';
let browser, blackhole;
const sockets = new Set();
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function wait(label, fn, seconds = 20) {
  const end = Date.now() + seconds * 1000;
  while (Date.now() < end) { if (await fn()) return; await sleep(100); }
  throw new Error('Timed out: ' + label);
}
async function start(command, args, env = process.env, name = String(children.length)) {
  const log = await open(root + '/' + name + '.log', 'w'); handles.push(log);
  const p = spawn(command, args, { env, stdio: ['ignore', log.fd, log.fd] }); children.push(p); return p;
}
const base = 'http://127.0.0.1:8097';
let token, viewerToken;
async function api(path, body, auth = token) {
  const response = await fetch(base + '/api/broadcasts' + path, { headers: { Authorization: `Bearer ${auth}`, 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }) });
  const text = await response.text();
  assert.ok(!text.includes('secret-sentinel'), 'API leaked connection credential');
  return { status: response.status, body: text ? JSON.parse(text) : null };
}
const settings = (id, port, fps = 30) => ({ request_id: id, label: id, url: `rtmp://127.0.0.1:${port}/live`, stream_key: 'secret-sentinel', width: 640, height: 360, fps, bitrate_kbps: 800, audio: withAudio ? 'desktop' : 'silence', cursor: true });
async function ingest(port, name) {
  return start('ffmpeg', ['-hide_banner', '-loglevel', 'warning', '-listen', '1', '-i', `rtmp://127.0.0.1:${port}/live/secret-sentinel`, '-c', 'copy', '-y', root + '/' + name + '.flv'], process.env, name);
}
let mcpSession;
async function mcp(method, params, auth = token) {
  const response = await fetch(base + '/mcp', { method: 'POST', headers: { Authorization: `Bearer ${auth}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...(mcpSession ? { 'Mcp-Session-Id': mcpSession } : {}) }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  if (response.headers.get('mcp-session-id')) mcpSession = response.headers.get('mcp-session-id');
  const text = await response.text();
  assert.ok(!text.includes('secret-sentinel'), 'MCP leaked credential');
  const data = text.startsWith('data:') || text.includes('\ndata:') ? text.split('\n').filter(l => l.startsWith('data:')).map(l => l.slice(5).trim()).join('') : text;
  return JSON.parse(data);
}
try {
  await mkdir(root + '/runtime', { mode: 0o700 });
  const desktop = await start(process.env.ELSEWHERE_BINARY || '/src/target/release/elsewhere', [...(!withAudio ? ['--no-audio', '--screen-size', '640x480'] : []), '--no-tls', ...(process.env.BROADCAST_GPU === '1' ? [] : ['--render-node', 'none', '--codec', 'vp8']), '--listen', '127.0.0.1:8097', '--rtc-port', '50997', '--socket-name', 'wayland-broadcast-check'], { ...process.env, XDG_CONFIG_HOME: root + '/config', XDG_RUNTIME_DIR: root + '/runtime' }, 'desktop');
  await wait('desktop startup', async () => { try { return (await fetch(base)).ok; } catch { return false; } });
  token = (await readFile(root + '/config/elsewhere/token', 'utf8')).trim();
  viewerToken = (await readFile(root + '/config/elsewhere/viewer-token', 'utf8')).trim();
  assert.equal((await api('/capabilities')).body.available, true);
  assert.equal((await api('/start', settings('denied', 19357), viewerToken)).status, 403);
  if (!withAudio) assert.equal((await api('/start', { ...settings('audio-unavailable', 19357), audio: 'desktop' })).status, 503);
  else {
    assert.equal((await api('/capabilities')).body.desktop_audio, true);
    await fetch(base + '/api/control', { method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body: JSON.stringify({ op: 'spawn', cmd: 'gst-launch-1.0 -q audiotestsrc is-live=true wave=sine ! audioconvert ! audioresample ! pulsesink' }) });
  }
  assert.equal((await api('/start', { ...settings('bad-size', 19357), width: 641 })).status, 400);
  await mcp('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'broadcast-check', version: '1' } });
  const tools = await mcp('tools/list', {});
  assert.ok(tools.result.tools.some(t => t.name === 'broadcast_start'));
  const denied = await mcp('tools/call', { name: 'broadcast_start', arguments: settings('mcp-denied', 19357) }, viewerToken);
  assert.equal(denied.result.isError, true);
  const sinkA = await ingest(19357, 'capture-a'), sinkB = await ingest(19358, 'capture-b');
  await sleep(500);
  const first = settings('first', 19357), second = { ...settings('second', 19358, 60), width: 320, height: 240, cursor: false };
  const [a, duplicate] = await Promise.all([api('/start', first), api('/start', first)]);
  assert.equal(a.status, 200); assert.equal(a.body.id, duplicate.body.id);
  assert.equal((await api('/start', { ...first, bitrate_kbps: 900 })).status, 409);
  const called = await mcp('tools/call', { name: 'broadcast_start', arguments: second });
  assert.ok(!called.result.isError, JSON.stringify(called));
  const b = JSON.parse(called.result.content[0].text);
  await wait('both outputs sending without browser viewers', async () => (await api('')).body.filter(s => s.state === 'sending').length === 2);
  blackhole = createServer(socket => { sockets.add(socket); socket.pause(); socket.on('close', () => sockets.delete(socket)); });
  await new Promise(resolve => blackhole.listen(19359, '127.0.0.1', resolve));
  const stalled = await api('/start', { ...settings('stalled-handshake', 19359), audio: 'silence' });
  await sleep(500);
  assert.equal((await api('/' + a.body.id)).body.state, 'sending');
  await api('/' + stalled.body.id + '/stop', {});
  await wait('stop stalled handshake', async () => (await api('/' + stalled.body.id)).body.state === 'stopped', 10);
  for (const socket of sockets) socket.destroy();
  await new Promise(resolve => blackhole.close(resolve)); blackhole = null;
  const before = (await api('/' + a.body.id)).body.frames;
  if (withAudio) {
    browser = await chromium.launch({ executablePath: '/usr/bin/chromium', headless: true, args: ['--no-sandbox'] });
    const context = await browser.newContext({ viewport: { width: 1000, height: 800 } });
    const page = await context.newPage();
    await page.goto(base + '/#token=' + token);
    await page.waitForFunction(() => window.elsewhere?.store.get().stats.frames > 0);
    await sleep(1200);
    const frames = await page.evaluate(() => elsewhere.store.get().stats.frames);
    await sleep(1500);
    const after = await page.evaluate(() => elsewhere.store.get().stats.frames);
    assert.ok(after - frames < 5, 'broadcast cadence must not send idle frames to the browser');
    const originalWidth = await page.evaluate(() => elsewhere.store.get().stream.width);
    await page.setViewportSize({ width: 1300, height: 900 });
    await page.waitForFunction(width => elsewhere.store.get().stream.width !== width, originalWidth);
    await sleep(1200);
    await fetch(base + '/api/input', { method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body: JSON.stringify({ type: 'move', x: 200, y: 200 }) });
    await sleep(1200);
    await browser.close(); browser = null;
  } else await sleep(6000);
  assert.ok((await api('/' + a.body.id)).body.frames > before + 150, 'idle output must keep producing frames');
  assert.equal((await api('/' + a.body.id + '/stop', {}, viewerToken)).status, 403);
  sinkA.kill('SIGINT');
  await wait('disconnected output retries', async () => (await api('/' + a.body.id)).body.state === 'reconnecting');
  assert.equal((await api('/' + b.id)).body.state, 'sending');
  const replacement = await ingest(19357, 'capture-reconnect');
  await wait('output reconnects', async () => (await api('/' + a.body.id)).body.state === 'sending', 35);
  await api('/' + a.body.id + '/stop', {});
  await mcp('tools/call', { name: 'broadcast_stop', arguments: { id: b.id } });
  await wait('both stopped', async () => (await api('')).body.every(s => s.state === 'stopped'));
  assert.equal((await api('/start', first)).body.state, 'stopped', 'retry must not revive stopped run');
  await api('/' + a.body.id + '/stop', {});
  sinkB.kill('SIGINT'); replacement.kill('SIGINT'); await sleep(500);
  for (const [name, width, height, fps] of [['capture-a', 640, 360, 30], ['capture-b', 320, 240, 60]]) {
    const probe = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-show_packets', '-of', 'json', root + '/' + name + '.flv'], { maxBuffer: 20 * 1024 * 1024 }));
    const v = probe.streams.find(s => s.codec_type === 'video'), a = probe.streams.find(s => s.codec_type === 'audio');
    assert.ok(+probe.format.bit_rate > 800000 * 0.8, 'CBR video maintains its configured bitrate during idle');
    assert.equal(v.codec_name, 'h264'); assert.equal(a.codec_name, 'aac'); assert.equal(v.width, width); assert.equal(v.height, height);
    const packets = probe.packets.filter(p => p.stream_index === v.index);
    const duration = +packets.at(-1).pts_time - +packets[0].pts_time;
    const measured = (packets.length - 1) / duration;
    assert.ok(measured > fps * 0.9 && measured < fps * 1.1, `cadence ${name}: ${measured}`);
    const keys = packets.filter(p => p.flags.includes('K')).map(p => +p.pts_time);
    assert.ok(keys.length >= 2, 'multiple periodic keyframes');
    for (let i = 1; i < keys.length; i++) assert.ok(keys[i] - keys[i-1] <= 2.3, 'regular keyframes');
    const audio = probe.packets.filter(p => p.stream_index === a.index);
    assert.ok(Math.abs(+audio[0].pts_time - +packets[0].pts_time) < 0.3, 'A/V startup synchronization');
    console.log(JSON.stringify({ name, width, height, fps: measured, frames: packets.length, keyframes: keys.length }));
  }
  if (withAudio) {
    const volume = spawnSync('ffmpeg', ['-hide_banner', '-i', root + '/capture-a.flv', '-af', 'volumedetect', '-f', 'null', '-'], { encoding: 'utf8' });
    assert.equal(volume.status, 0);
    const peak = /max_volume: ([\d.-]+) dB/.exec(volume.stderr);
    assert.ok(peak && +peak[1] > -30, 'desktop audio contains the test tone');
    for (const [name, visible] of [['capture-a', true], ['capture-b', false]]) {
      const rgb = execFileSync('ffmpeg', ['-v', 'error', '-ss', '5', '-i', root + '/' + name + '.flv', '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { maxBuffer: 2 * 1024 * 1024 });
      const bright = rgb.filter(value => value > 150).length;
      assert.equal(bright > 5, visible, 'cursor visibility in ' + name);
    }
    const audioSink = await ingest(19357, 'audio-failure'), silentSink = await ingest(19358, 'silence-survives');
    await sleep(500);
    const audioRun = await api('/start', settings('audio-failure', 19357));
    const silentRun = await api('/start', { ...settings('silence-survives', 19358), audio: 'silence' });
    await wait('audio outputs sending', async () => (await api('/' + audioRun.body.id)).body.state === 'sending' && (await api('/' + silentRun.body.id)).body.state === 'sending');
    const processes = execFileSync('ps', ['-eo', 'pid,ppid,comm'], { encoding: 'utf8' });
    const pipewire = processes.split('\n').map(line => line.trim().split(/\s+/)).find(([, parent, name]) => +parent === desktop.pid && name === 'pipewire');
    assert.ok(pipewire, 'private PipeWire service is a child of this desktop');
    process.kill(+pipewire[0], 'SIGTERM');
    await wait('audio failure reported', async () => (await api('/' + audioRun.body.id)).body.state === 'failed');
    assert.equal((await api('/' + silentRun.body.id)).body.state, 'sending');
    const retried = await api('/start', settings('audio-failure', 19357));
    assert.equal(retried.status, 200, 'retry retrieves admitted run after capability loss');
    assert.equal(retried.body.id, audioRun.body.id);
    await api('/' + silentRun.body.id + '/stop', {});
    audioSink.kill('SIGINT'); silentSink.kill('SIGINT');
  }
  const hanging = await api('/start', { ...settings('stop-during-start', 19359), audio: 'silence' });
  await api('/' + hanging.body.id + '/stop', {});
  await wait('stop during start', async () => (await api('/' + hanging.body.id)).body.state === 'stopped');
  const log = await readFile(root + '/desktop.log', 'utf8');
  assert.ok(!log.includes('secret-sentinel'), 'server diagnostics leaked key');
  console.log('Broadcast backend checks passed. Artifacts: ' + root);
} finally {
  await browser?.close();
  for (const socket of sockets) socket.destroy();
  blackhole?.close();
  for (const child of children) child.kill('SIGTERM');
  await Promise.all(handles.map(h => h.close()));
}
