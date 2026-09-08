// Docker live authorization check: independent sessions, cancellation and client feature gates.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, open, readFile, rm } from 'node:fs/promises';
import { chromium } from 'playwright-core';
import { createToken } from './token-fixture.mjs';
const root = await mkdtemp('/tmp/elsewhere-token-live-');
await mkdir(root + '/runtime', { mode: 0o700 });
const log = await open(root + '/server.log', 'w');
const origin = 'http://127.0.0.1:18446';
const binary = process.env.ELSEWHERE_BINARY || '/src/target/release/elsewhere';
const server = spawn(binary, ['--no-audio', '--no-rtc', '--no-tls', '--render-node', 'none', '--codec', 'vp8', '--listen', '127.0.0.1:18446', '--screen-size', '320x240'], {
  cwd: root, env: { ...process.env, HOME: root, SHELL: '/bin/bash', XDG_CONFIG_HOME: root + '/config', XDG_CACHE_HOME: root + '/cache', XDG_RUNTIME_DIR: root + '/runtime' }, stdio: ['ignore', log.fd, log.fd],
});
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const wait = async (label, condition) => { for (let i = 0; i < 200; i++) { if (await condition()) return; await delay(25); } throw Error(label + ' timed out'); };
const request = (path, token, method = 'GET', body) => fetch(origin + path, { method, headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, ...(body !== undefined && { body: JSON.stringify(body) }) });
let admin, browser;
const sockets = [];
const create = async (permissions, expires_at_ms) => {
  const response = await request('/api/tokens', admin, 'POST', { label: 'Live fixture', permissions, expires_at_ms });
  assert.equal(response.status, 201);
  return response.json();
};
const revoke = async token => { const response = await request('/api/tokens/' + token.metadata.id, admin, 'DELETE'); assert.equal(response.status, 204); };
async function connect(token, terminal = false) {
  const socket = new WebSocket(origin.replace('http', 'ws') + (terminal ? '/ws/terminal' : '/ws'));
  socket.binaryType = 'arraybuffer';
  const state = { socket, packets: [], closed: false };
  sockets.push(socket);
  socket.onmessage = event => state.packets.push(typeof event.data === 'string' ? event.data : Buffer.from(event.data));
  socket.onclose = event => { state.closed = true; state.code = event.code; };
  await wait('socket open', () => socket.readyState === WebSocket.OPEN);
  socket.send(Buffer.concat([Buffer.from([0x80]), Buffer.from(token)]));
  if (!terminal) socket.send(Buffer.from([0x81, 0, 16, 5, 0]));
  return state;
}
try {
  await wait('server', async () => { try { return (await fetch(origin)).ok; } catch { return false; } });
  admin = await createToken(root);
  const a = await create(['desktop.view', 'desktop.control', 'clipboard.write', 'commands.execute']);
  const b = await create(['desktop.view']);
  const one = await connect(a.token), two = await connect(b.token);
  await wait('two streams', () => [one, two].every(s => s.packets.some(p => p[0] === 1)));
  const terminal = await connect(a.token, true);
  await wait('terminal output', () => terminal.packets.length > 0);
  const clipboard = await request('/api/clipboard', a.token, 'PUT', 'private text');
  assert.equal(clipboard.status, 202);
  await delay(150);
  assert.ok(two.packets.every(p => ![5, 7, 10, 15, 16].includes(p[0])), 'desktop-only token has no clipboard or audio packets');
  await revoke(a);
  await wait('revoked desktop and terminal', () => one.closed && terminal.closed);
  assert.equal(one.code, 4001);
  assert.equal(two.closed, false);
  assert.equal((await request('/api/me', b.token)).status, 200);
  const deniedTerminal = await connect(b.token, true);
  await wait('terminal permission denied', () => deniedTerminal.closed);
  const expiring = await create(['desktop.view'], Date.now() + 750);
  const timed = await connect(expiring.token);
  await wait('expiry stream', () => timed.packets.some(p => p[0] === 1));
  await wait('idle expiry', () => timed.closed);
  assert.equal(two.closed, false);
  const uploadToken = await create(['files.upload']);
  let uploadBody;
  const upload = fetch(origin + '/api/files/incomplete?path=@transfer', { method: 'PUT', headers: { Authorization: 'Bearer ' + uploadToken.token }, duplex: 'half',
    body: new ReadableStream({ start(controller) { uploadBody = controller; controller.enqueue(new Uint8Array(65536)); } }),
  }).catch(error => error);
  await delay(100);
  await revoke(uploadToken);
  try { uploadBody.close(); } catch {}
  const uploadResult = await upload;
  assert.ok(uploadResult instanceof Error || uploadResult.status === 401);
  assert.equal((await request('/api/files/incomplete?path=@transfer', admin)).status, 404);
  // A committed revoke owns cleanup even when its manager expires while SQLite is busy.
  const victim = await create(['desktop.view']);
  const victimSocket = await connect(victim.token);
  await wait('victim stream', () => victimSocket.packets.some(p => p[0] === 1));
  const manager = await create(['tokens.manage'], Date.now() + 700);
  const lock = spawn('python3', ['-u', '-c', "import sqlite3,sys; db=sqlite3.connect(sys.argv[1]); db.execute('BEGIN IMMEDIATE'); print('locked',flush=True); sys.stdin.readline(); db.rollback()", root + '/config/elsewhere/state.sqlite3']);
  await new Promise(resolve => lock.stdout.once('data', resolve));
  const deleting = request('/api/tokens/' + victim.metadata.id, manager.token, 'DELETE');
  await delay(1000);
  lock.stdin.end('\n');
  await deleting;
  await wait('committed cleanup after caller expiry', () => victimSocket.closed);
  assert.equal((await request('/api/me', victim.token)).status, 401);
  assert.equal(two.closed, false);
  // Registration overlapping revocation cannot leave a live stream.
  const racing = await create(['desktop.view']);
  const attempts = await Promise.all(Array.from({ length: 8 }, () => connect(racing.token)));
  await revoke(racing);
  await wait('registration cancellation', () => attempts.every(s => s.closed));
  assert.equal(two.closed, false);
  browser = await chromium.launch({ executablePath: '/usr/bin/chromium', headless: true, args: ['--no-sandbox'] });
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(origin + '/#token=' + b.token);
  await page.waitForFunction(() => elsewhere.store.get().status === 'connected');
  for (const selector of ['#apps-toggle', '#terminal-toggle', '#power-toggle', '#clipboard-toggle', '#session-mixer-toggle']) assert.equal(await page.locator(selector).count(), 0, selector);
  const writable = await create(['desktop.view', 'clipboard.write']);
  const writer = await browser.newPage();
  writer.on('pageerror', error => errors.push(error.message));
  await writer.goto(origin + '/#token=' + writable.token);
  await writer.waitForFunction(() => elsewhere.store.get().status === 'connected');
  await writer.locator('#clipboard-toggle').click();
  await writer.getByRole('button', { name: 'New text', exact: true }).click();
  await writer.getByRole('textbox', { name: 'Clipboard text' }).fill('write without read');
  await writer.getByRole('button', { name: 'Save', exact: true }).click();
  await writer.getByRole('button', { name: 'New text', exact: true }).waitFor();
  assert.deepEqual(errors, []);
  await revoke(b);
  await page.waitForFunction(() => elsewhere.store.get().status === 'unauthorized');
  await writer.waitForFunction(() => elsewhere.store.get().status === 'connected');
  console.log('Live streams, terminal and transfer cancellation, expiry, SQLite contention, registration races and browser permissions passed');
} catch (error) {
  console.error(await readFile(root + '/server.log', 'utf8'));
  throw error;
} finally {
  await browser?.close();
  for (const socket of sockets) socket.close();
  server.kill('SIGTERM');
  await new Promise(resolve => server.once('exit', resolve));
  await log.close();
  await rm(root, { recursive: true, force: true });
}
