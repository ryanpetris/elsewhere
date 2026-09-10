// Docker: type preview and unsaved pasted text into a native multiline field.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, open, readFile, writeFile, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { createToken } from './token-fixture.mjs';
import { INPUT, SET_CLIPBOARD, PASTE_CLIPBOARD } from '../src/protocol.js';

const root = await mkdtemp('/tmp/elsewhere-clipboard-type-');
await mkdir(root + '/runtime', { mode: 0o700 });
const log = await open(root + '/server.log', 'w');
const origin = 'http://127.0.0.1:18450';
const server = spawn(process.env.ELSEWHERE_BINARY || '/src/target/release/elsewhere',
  ['--no-audio', '--no-rtc', '--no-tls', '--render-node', 'none', '--codecs', 'vp8', '--listen', '127.0.0.1:18450'],
  { cwd: root, env: { ...process.env, HOME: root, XDG_CONFIG_HOME: root + '/config', XDG_RUNTIME_DIR: root + '/runtime' }, stdio: ['ignore', log.fd, log.fd] });
let launchError;
const exited = new Promise(resolve => { server.once('exit', resolve); server.once('error', error => { launchError = error; resolve(); }); });
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const wait = async (label, fn) => { for (let i = 0; i < 300; i++) { if (launchError) throw launchError; if (await fn()) return; await delay(25); } throw Error(label + ' timed out'); };
const quote = s => "'" + s.replaceAll("'", "'\\''") + "'";
let browser, admin;
const api = (path, body) => fetch(origin + path, { method: body ? 'POST' : 'GET', headers: { Authorization: 'Bearer ' + admin, 'Content-Type': 'application/json' }, ...(body && { body: JSON.stringify(body) }) });
try {
  await wait('server', async () => { try { return (await fetch(origin)).ok; } catch { return false; } });
  admin = await createToken(root);
  const seed = 'Hello, WORLD!\nSecond line: 42?\n', draft = 'Edited DRAFT:\nLine 2\tDone!';
  await writeFile(root + '/seed', seed);
  const fixture = fileURLToPath(new URL('../../crates/elsewhere-compositor/checks/clipboard-type.py', import.meta.url));
  assert((await api('/api/control', { op: 'spawn', cmd: ['env', 'GDK_BACKEND=wayland', 'python3', fixture, root].map(quote).join(' ') })).ok);
  let native;
  await wait('native field', async () => { native = (await (await api('/api/windows')).json()).find(w => w.title === 'clipboard-type'); return native; });
  await api('/api/control', { id: native.id, op: 'activate' });
  await api('/api/input', { type: 'key', keys: 'ctrl+c' });
  browser = await chromium.launch({ executablePath: '/usr/bin/chromium', args: ['--no-sandbox'] });
  const connect = async token => {
    const context = await browser.newContext({ permissions: ['clipboard-read', 'clipboard-write'] });
    context.setDefaultTimeout(10000);
    const page = await context.newPage();
    const packets = [], writes = [], errors = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('request', request => { if (request.method() === 'PUT' && new URL(request.url()).pathname === '/api/clipboard') writes.push(request.url()); });
    page.on('websocket', socket => socket.on('framesent', ({ payload }) => { if (Buffer.isBuffer(payload)) packets.push(payload); }));
    await page.goto(origin + '/#token=' + token);
    await page.waitForFunction(() => elsewhere.store.get().status === 'connected');
    await page.locator('#clipboard-toggle').click();
    await page.waitForFunction(seed => elsewhere.store.get().clipboardState.text === seed, seed);
    return { context, page, packets, writes, errors };
  };
  const main = await connect(admin), page = main.page;
  await page.getByRole('button', { name: 'Type Text', exact: true }).click();
  await wait('preview typed', async () => await readFile(root + '/typed', 'utf8') === seed);
  assert(await page.locator('canvas.stage').evaluate(element => document.activeElement === element));
  await page.locator('#clipboard-toggle').click();
  await page.getByRole('button', { name: 'Edit', exact: true }).click();
  await page.evaluate(text => navigator.clipboard.writeText(text), draft);
  const editor = page.getByRole('textbox', { name: 'Clipboard Text', exact: true });
  await editor.fill('');
  await editor.press('Control+v');
  await wait('local paste', async () => await editor.inputValue() === draft);
  await page.getByRole('button', { name: 'Type Text', exact: true }).click();
  await wait('draft typed', async () => await readFile(root + '/typed', 'utf8') === seed + draft);
  assert(await page.locator('canvas.stage').evaluate(element => document.activeElement === element));
  assert.equal(await (await api('/api/clipboard')).text(), seed);
  const inputs = main.packets.filter(packet => packet[0] === INPUT).map(packet => JSON.parse(packet.subarray(1).toString()));
  assert.deepEqual(inputs, [{ type: 'text', text: seed }, { type: 'text', text: draft }]);
  assert.equal(main.packets.filter(packet => [SET_CLIPBOARD, PASTE_CLIPBOARD].includes(packet[0])).length, 0);
  assert.equal(main.writes.length, 0);
  const readonly = await connect(await createToken(root, ['desktop.view', 'clipboard.read']));
  assert(await readonly.page.getByRole('button', { name: 'Type Text', exact: true }).isDisabled());
  await readonly.page.getByRole('button', { name: 'Type Text', exact: true }).dispatchEvent('click');
  assert.equal(readonly.packets.filter(packet => packet[0] === INPUT).length, 0);
  assert.equal(await readFile(root + '/typed', 'utf8'), seed + draft);
  assert.deepEqual(main.errors.concat(readonly.errors), []);
  console.log('clipboard typing: preview, unsaved local paste, native capitals/punctuation/newlines/tabs, focus, exact single sends, unchanged clipboard and denied control passed');
} catch (error) {
  console.error(await readFile(root + '/server.log', 'utf8'));
  throw error;
} finally {
  await browser?.close();
  server.kill('SIGTERM');
  let timer;
  await Promise.race([exited, new Promise(resolve => { timer = setTimeout(resolve, 5000); })]);
  clearTimeout(timer);
  if (server.exitCode === null && server.signalCode === null) { server.kill('SIGKILL'); await exited; }
  await log.close();
  await rm(root, { recursive: true, force: true });
}
