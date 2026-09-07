// Run in the Docker desktop rig with FFmpeg, Chromium, nginx, Node and the current binary.
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, open, readFile, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright-core';
const root = await mkdtemp('/tmp/elsewhere-broadcast-check-');
const children = [], handles = [];
let browser;
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
const settings = (id, port, fps = 30) => ({ request_id: id, label: id, url: `rtmp://127.0.0.1:${port}/live`, stream_key: 'secret-sentinel', width: 640, height: 360, fps, bitrate_kbps: 800, audio: 'silence', cursor: true });
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
  await start(process.env.ELSEWHERE_BINARY || '/src/target/release/elsewhere', ['--no-audio', '--no-tls', '--render-node', 'none', '--codec', 'vp8', '--screen-size', '640x480', '--listen', '127.0.0.1:8097', '--rtc-port', '50997', '--socket-name', 'wayland-broadcast-check'], { ...process.env, XDG_CONFIG_HOME: root + '/config', XDG_RUNTIME_DIR: root + '/runtime' }, 'desktop');
  await wait('desktop startup', async () => { try { return (await fetch(base)).ok; } catch { return false; } });
  token = (await readFile(root + '/config/elsewhere/token', 'utf8')).trim();
  viewerToken = (await readFile(root + '/config/elsewhere/viewer-token', 'utf8')).trim();
  assert.equal((await api('/capabilities')).body.available, true);
  assert.equal((await api('/start', settings('denied', 19357), viewerToken)).status, 403);
  assert.equal((await api('/start', { ...settings('audio-unavailable', 19357), audio: 'desktop' })).status, 503);
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
  const before = (await api('/' + a.body.id)).body.frames;
  await sleep(6000);
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
    const probe = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_streams', '-show_packets', '-of', 'json', root + '/' + name + '.flv'], { maxBuffer: 20 * 1024 * 1024 }));
    const v = probe.streams.find(s => s.codec_type === 'video'), a = probe.streams.find(s => s.codec_type === 'audio');
    assert.equal(v.codec_name, 'h264'); assert.equal(a.codec_name, 'aac'); assert.equal(v.width, width); assert.equal(v.height, height);
    const packets = probe.packets.filter(p => p.stream_index === v.index);
    const duration = +packets.at(-1).pts_time - +packets[0].pts_time;
    const measured = (packets.length - 1) / duration;
    assert.ok(measured > fps * 0.9 && measured < fps * 1.1, `cadence ${name}: ${measured}`);
    const keys = packets.filter(p => p.flags.includes('K')).map(p => +p.pts_time);
    for (let i = 1; i < keys.length; i++) assert.ok(keys[i] - keys[i-1] <= 2.3, 'regular keyframes');
    const audio = probe.packets.filter(p => p.stream_index === a.index);
    assert.ok(Math.abs(+audio[0].pts_time - +packets[0].pts_time) < 0.3, 'A/V startup synchronization');
    console.log(JSON.stringify({ name, width, height, fps: measured, frames: packets.length, keyframes: keys.length }));
  }
  const hanging = await api('/start', settings('stop-during-start', 19359));
  await api('/' + hanging.body.id + '/stop', {});
  await wait('stop during start', async () => (await api('/' + hanging.body.id)).body.state === 'stopped');
  const log = await readFile(root + '/desktop.log', 'utf8');
  assert.ok(!log.includes('secret-sentinel'), 'server diagnostics leaked key');
  console.log('Broadcast backend checks passed. Artifacts: ' + root);
} finally {
  await browser?.close();
  for (const child of children) child.kill('SIGTERM');
  await Promise.all(handles.map(h => h.close()));
}
