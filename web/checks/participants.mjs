// Docker live desktop membership, approval and pointer check.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, open, readFile, rm } from 'node:fs/promises';
import { chromium } from 'playwright-core';
import { createToken } from './token-fixture.mjs';
import { AUTH, HELLO, SESSION, ROSTER, ROLE, POINTER_POSITION, CURSOR, VIDEO, TAKE_CONTROL, HANDOFF, REQUEST_CONTROL, CANCEL_CONTROL, APPROVE_CONTROL, DECLINE_CONTROL, MOTION_ABS } from '../src/protocol.js';

const root = await mkdtemp('/tmp/elsewhere-participants-');
await mkdir(root + '/runtime', { mode: 0o700 });
const log = await open(root + '/server.log', 'w');
const origin = 'http://127.0.0.1:18450';
const server = spawn(process.env.ELSEWHERE_BINARY || '/src/target/release/elsewhere',
  ['--no-audio', '--no-rtc', '--no-tls', '--render-node', 'none', '--codecs', 'vp8', '--listen', '127.0.0.1:18450', '--screen-size', '802x600'],
  { cwd: root, env: { ...process.env, HOME: root, XDG_CONFIG_HOME: root + '/config', XDG_RUNTIME_DIR: root + '/runtime' }, stdio: ['ignore', log.fd, log.fd] });
const delay = ms => new Promise(r => setTimeout(r, ms));
const wait = async (label, condition) => { for (let i = 0; i < 400; i++) { if (await condition()) return; await delay(25); } throw Error(label + ' timed out'); };
let admin, browser;
const sockets = [];
const api = (path, method = 'GET', body) => fetch(origin + path, { method, headers: { Authorization: 'Bearer ' + admin, 'Content-Type': 'application/json' }, ...(body && { body: JSON.stringify(body) }) });
const create = async permissions => (await api('/api/tokens', 'POST', { label: 'Participants fixture', permissions })).json();
const send = (s, tag, values = []) => {
  const b = new Uint8Array(1 + values.length * 8), dv = new DataView(b.buffer); b[0] = tag;
  values.forEach((v, i) => dv.setBigUint64(1 + i * 8, BigInt(v), true)); s.socket.send(b);
};
const own = s => s.roster?.sessions.find(member => member.id === s.id);
const connect = async token => {
  const socket = new WebSocket(origin.replace('http', 'ws') + '/ws');
  socket.binaryType = 'arraybuffer';
  const s = { socket, positions: 0, frames: 0, closed: false };
  sockets.push(s);
  socket.onmessage = ({ data }) => {
    const b = new Uint8Array(data), dv = new DataView(data);
    if (b[0] === SESSION) s.id = dv.getBigUint64(1, true).toString();
    if (b[0] === ROLE) s.role = b[1];
    if (b[0] === ROSTER) s.roster = JSON.parse(new TextDecoder().decode(b.subarray(1)));
    if (b[0] === CURSOR) s.cursor = b;
    if (b[0] === POINTER_POSITION) { s.pointer = [1, 9, 17, 25].map(i => dv.getFloat64(i, true)); s.positions++; }
    if (b[0] === VIDEO) s.frames++;
  };
  socket.onclose = () => { s.closed = true; };
  await wait('socket', () => socket.readyState === WebSocket.OPEN);
  socket.send(new Uint8Array([AUTH, ...new TextEncoder().encode(token)]));
  socket.send(new Uint8Array([HELLO, ...new TextEncoder().encode(JSON.stringify({ codecs: ['vp8'] }))]));
  await wait('roster', () => !!own(s));
  return s;
};
const decide = (controller, target, approve = true, request = own(target).request) => send(controller, approve ? APPROVE_CONTROL : DECLINE_CONTROL, [target.id, request.id, request.epoch]);
try {
  await wait('server', async () => { try { return (await fetch(origin)).ok; } catch { return false; } });
  admin = await createToken(root);
  const a = await connect(admin), b = await connect(admin);
  const eligible = await create(['desktop.view', 'desktop.control']);
  const c = await connect(eligible.token);
  const readonly = await create(['desktop.view']);
  const reader = await connect(readonly.token);
  await wait('four members', () => sockets.every(s => s.roster.sessions.length === 4));
  assert(sockets.every(s => s.roster.controller === a.id));
  assert.equal(own(reader).can_control, false);
  for (const member of a.roster.sessions) assert.deepEqual(Object.keys(member).sort(), ['can_control', 'id', 'label', 'request', 'result']);
  send(reader, REQUEST_CONTROL); send(reader, TAKE_CONTROL); send(b, TAKE_CONTROL);
  await delay(150);
  assert.equal(a.roster.controller, a.id); assert.equal(own(reader).request, null);
  send(b, REQUEST_CONTROL);
  await wait('request', () => !!own(b).request);
  const first = own(b).request;
  send(b, REQUEST_CONTROL); await delay(50); assert.deepEqual(own(b).request, first);
  send(b, CANCEL_CONTROL, [first.id, first.epoch]);
  await wait('cancel', () => own(b).result === 'cancelled');
  decide(a, b, true, first); await delay(100); assert.equal(a.roster.controller, a.id);
  send(b, REQUEST_CONTROL); await wait('second request', () => !!own(b).request);
  decide(a, b, false); await wait('decline', () => own(b).result === 'declined');
  send(b, REQUEST_CONTROL); await wait('third request', () => !!own(b).request);
  const approved = own(b).request;
  decide(a, b); await wait('approval', () => sockets.every(s => s.roster.controller === b.id));
  assert.equal(a.role, 1); assert.equal(b.role, 2); assert.equal(own(b).result, 'approved');
  send(b, HANDOFF, [a.id]); await wait('direct handoff', () => b.roster.controller === a.id);
  decide(a, b, true, approved); await delay(100); assert.equal(a.roster.controller, a.id);
  send(c, REQUEST_CONTROL); await wait('revoked request', () => !!own(c).request);
  const revokedRequest = own(c).request;
  assert.equal((await api('/api/tokens/' + eligible.metadata.id, 'DELETE')).status, 204);
  await wait('revocation', () => c.closed && a.roster.sessions.length === 3);
  decide(a, c, true, revokedRequest); await delay(100); assert.equal(a.roster.controller, a.id);
  send(b, REQUEST_CONTROL); await wait('expiry request', () => !!own(b).request);
  const started = Date.now();
  while (own(b).request && Date.now() - started < 32_000) await delay(100);
  assert.equal(own(b).result, 'expired');
  console.log('Request expiry ms:', Date.now() - started);
  const motion = (x, y) => { const bytes = new Uint8Array(9), dv = new DataView(bytes.buffer); bytes[0] = MOTION_ABS; dv.setFloat32(1, x, true); dv.setFloat32(5, y, true); a.socket.send(bytes); };
  assert.equal((await api('/api/input', 'POST', { type: 'move', x: 400, y: 300 })).status, 202);
  await wait('pointer', () => reader.pointer?.[0] === 400 && reader.pointer?.[1] === 300);
  assert.deepEqual(reader.pointer, [400, 300, 802, 600]);
  const before = reader.positions;
  for (let i = 0; i < 1000; i++) motion(i % 800, i % 600);
  await wait('last pointer', () => reader.pointer[0] === 199 && reader.pointer[1] === 399);
  console.log('Pointer updates for 1000 movements:', reader.positions - before);
  assert(reader.positions - before < 35);
  browser = await chromium.launch({ executablePath: '/usr/bin/chromium', args: ['--no-sandbox'] });
  const page = await browser.newPage({ viewport: { width: 1100, height: 750 } });
  await page.goto(origin + '/#token=' + readonly.token);
  await page.waitForFunction(() => elsewhere.store.get().status === 'connected' && elsewhere.store.get().roster);
  await page.getByRole('button', { name: 'Windows and Statistics', exact: true }).click();
  await page.getByRole('button', { name: /^Participants/ }).click();
  await page.getByRole('dialog', { name: 'Participants' }).waitFor();
  assert.match(await page.getByRole('dialog').innerText(), /You/);
  assert.equal(await page.getByRole('button', { name: 'Request Control', exact: true }).count(), 0);
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  motion(400, 300);
  await page.locator('[data-observer-pointer]').waitFor();
  await page.waitForFunction(() => elsewhere.store.get().observerPointer?.x === 400);
  for (const viewport of [{ width: 1100, height: 750 }, { width: 520, height: 900 }]) {
    await page.setViewportSize(viewport);
    for (const [x, y] of [[0, 0], [801, 0], [801, 599], [0, 599], [400, 300]]) {
      motion(x, y);
      await page.waitForFunction(({ x, y }) => elsewhere.store.get().observerPointer?.x === x && elsewhere.store.get().observerPointer?.y === y, { x, y });
      const error = await page.evaluate(() => {
        const canvas = document.querySelector('canvas.stage').getBoundingClientRect();
        const cursor = document.querySelector('[data-observer-pointer]').getBoundingClientRect();
        const { cursorImage: image, observerPointer: p } = elsewhere.store.get();
        const kx = canvas.width / p.width, ky = canvas.height / p.height;
        return Math.max(Math.abs(cursor.x + image.hx * kx - (canvas.x + p.x * kx)),
          Math.abs(cursor.y + image.hy * ky - (canvas.y + p.y * ky)),
          Math.abs(cursor.width - image.width * kx));
      });
      assert(error < 1, 'observer cursor error below one CSS pixel: ' + error);
    }
  }
  await page.getByRole('button', { name: /^Participants/ }).click();
  await page.keyboard.press('Shift+Tab');
  assert.equal(await page.evaluate(() => document.activeElement.textContent), 'Close');
  await page.keyboard.press('Escape');
  assert.match(await page.evaluate(() => document.activeElement.getAttribute('aria-label')), /^Participants/);
  await page.evaluate(() => elsewhere.setTouchMouse(true));
  await page.waitForTimeout(500);
  const cdp = await page.context().newCDPSession(page);
  const box = await page.locator('canvas.stage').boundingBox();
  const finger = (fraction, id) => ({ x: box.x + box.width * fraction, y: box.y + box.height / 2, id });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [finger(.3, 1), finger(.5, 2)] });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [finger(.3, 1), finger(.7, 2)] });
  await page.waitForFunction(() => document.querySelector('canvas.stage').style.transform.includes('scale('), null, { timeout: 2000 });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  assert.match(await page.locator('canvas.stage').evaluate(c => c.style.transform), /scale\(1\.99|scale\(2/, 'gesture must zoom the canvas');
  const zoomError = await page.evaluate(() => {
    const canvas = document.querySelector('canvas.stage').getBoundingClientRect();
    const cursor = document.querySelector('[data-observer-pointer]').getBoundingClientRect();
    const { cursorImage: image, observerPointer: p } = elsewhere.store.get();
    const kx = canvas.width / p.width, ky = canvas.height / p.height;
    return Math.max(Math.abs(cursor.x + image.hx * kx - (canvas.x + p.x * kx)),
      Math.abs(cursor.y + image.hy * ky - (canvas.y + p.y * ky)));
  });
  assert(zoomError < 1, 'pinch zoom pointer error: ' + zoomError);
  await page.reload();
  await page.waitForFunction(() => elsewhere.store.get().observerPointer?.x === 400 && elsewhere.store.get().roster);
  console.log('Pointer corner/center error below one CSS pixel in landscape and portrait; keyboard focus and reload replay passed');
  assert.equal((await api('/api/control', 'POST', { op: 'spawn', cmd: 'foot --app-id=participant-cursor --override=mouse.hide-when-typing=yes' })).status, 202);
  let terminal;
  await wait('cursor terminal', async () => { terminal = (await (await api('/api/windows')).json()).find(w => w.app_id === 'participant-cursor'); return terminal; });
  await api('/api/control', 'POST', { op: 'activate', id: terminal.id });
  await wait('focused terminal', async () => { terminal = (await (await api('/api/windows')).json()).find(w => w.id === terminal.id); return terminal?.focused && terminal.w > 100 && terminal.h > 100; });
  await api('/api/input', 'POST', { type: 'move', x: 0, y: 0 });
  await page.waitForFunction(() => elsewhere.store.get().observerPointer?.x === 0);
  const outsideCursor = await page.evaluate(() => elsewhere.store.get().cursorImage?.url);
  await api('/api/input', 'POST', { type: 'move', x: terminal.x + terminal.w / 2, y: terminal.y + terminal.h / 2 });
  await page.waitForFunction(url => elsewhere.store.get().cursorImage?.url && elsewhere.store.get().cursorImage.url !== url, outsideCursor);
  await api('/api/input', 'POST', { type: 'key', keys: 'a' });
  await page.waitForFunction(() => elsewhere.store.get().cursorImage === null);
  assert.equal(await page.locator('[data-observer-pointer]').count(), 0);
  await page.reload();
  await page.waitForFunction(() => elsewhere.store.get().status === 'connected' && elsewhere.store.get().observerPointer);
  assert.equal(await page.locator('[data-observer-pointer]').count(), 0, 'hidden cursor replay');
  await api('/api/input', 'POST', { type: 'move', x: terminal.x + terminal.w / 2 + 10, y: terminal.y + terminal.h / 2 });
  await page.locator('[data-observer-pointer]').waitFor();
  console.log('Native cursor hide, hidden reconnect and visible shape restoration passed');
  send(b, REQUEST_CONTROL); await wait('request before election', () => !!own(b).request);
  a.socket.close(); await wait('deterministic reassignment', () => b.roster.controller === b.id);
  assert.equal(own(b).result, 'controller_changed', 'election does not claim approval');
  await page.waitForFunction(id => elsewhere.store.get().roster.controller === id, b.id);
  console.log('Roster agreement, grants, request/cancel/decline/approval, stale decisions, revocation, deterministic reassignment and observer replay passed');
} catch (error) { console.error((await readFile(root + '/server.log', 'utf8')).split('\n').slice(-15).join('\n')); throw error; }
finally {
  for (const { socket } of sockets) socket.close();
  await browser?.close();
  if (server.exitCode === null) { server.kill('SIGTERM'); await new Promise(r => server.once('exit', r)); }
  await log.close(); await rm(root, { recursive: true, force: true });
}
