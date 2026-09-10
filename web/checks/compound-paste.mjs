// Docker native PNG/file consumption and socket ownership; headed Chromium, Xvfb, xdotool and xmessage.
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, open, readFile, writeFile, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { createToken } from './token-fixture.mjs';

const root = await mkdtemp('/tmp/elsewhere-compound-paste-');
await mkdir(root + '/runtime', { mode: 0o700 });
const log = await open(root + '/server.log', 'w');
const origin = 'http://127.0.0.1:18448';
const server = spawn(process.env.ELSEWHERE_BINARY || '/src/target/release/elsewhere',
  ['--no-audio', '--no-rtc', '--no-tls', '--render-node', 'none', '--codecs', 'vp8', '--listen', '127.0.0.1:18448'],
  { cwd: root, env: { ...process.env, HOME: root, XDG_CONFIG_HOME: root + '/config', XDG_RUNTIME_DIR: root + '/runtime' }, stdio: ['ignore', log.fd, log.fd] });
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const wait = async (label, fn) => { for (let i = 0; i < 300; i++) { const result = await fn(); if (result) return result; await delay(25); } throw Error(label + ' timed out'); };
const quote = s => "'" + s.replaceAll("'", "'\\''") + "'";
let browser, admin, focusWindow;
const api = (path, body, token = admin, method = body ? 'POST' : 'GET') => fetch(origin + path, { method, headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, ...(body && { body: JSON.stringify(body) }) });
const records = async name => (await readFile(root + '/' + name + '.jsonl', 'utf8').catch(() => '')).trim().split('\n').filter(Boolean).map(JSON.parse);
const received = async name => (await records(name)).filter(r => r.kind === 'received');
const pasteCount = async name => (await records(name)).filter(r => r.kind === 'paste').length;
const errors = [];
try {
  await wait('server', async () => { try { return (await fetch(origin)).ok; } catch { return false; } });
  admin = await createToken(root);
  browser = await chromium.launch({ executablePath: '/usr/bin/chromium', headless: false, args: ['--no-sandbox'] });
  const connect = async (token = admin, { baseline = false, windowId = null, latency = 0 } = {}) => {
    const context = await browser.newContext();
    await context.route('**/api/**', async route => {
      const request = route.request(), path = new URL(request.url()).pathname;
      if (request.method() === 'GET' || !/^\/api\/(drop\/|clipboard(?:\/files)?$|input$)/.test(path)) return route.continue();
      await delay(latency);
      const response = await route.fetch();
      await delay(latency);
      await route.fulfill({ response });
    });
    await context.addInitScript(latency => {
      const Socket = WebSocket;
      window.pasteTest = { requests: [], packets: [], held: [], hold: false, epoch: '0', latency };
      const fetch = window.fetch;
      window.fetch = (url, init) => {
        if (init?.method && init.method !== 'GET') pasteTest.requests.push({ path: String(url), method: init.method, at: Date.now() });
        return fetch(url, init);
      };
      window.WebSocket = class extends Socket {
        constructor(...args) {
          super(...args); pasteTest.socket = this;
          this.addEventListener('message', ({ data }) => {
            if (typeof data !== 'string' && new Uint8Array(data)[0] === 8) pasteTest.epoch = new DataView(data).getBigUint64(3, true).toString();
          });
        }
        set onmessage(handler) {
          super.onmessage = event => { if (!(pasteTest.dropRole && new Uint8Array(event.data)[0] === 8)) handler(event); };
        }
        send(data) {
          if (!(data instanceof Blob)) return super.send(data);
          data.arrayBuffer().then(buffer => {
            pasteTest.packets.push([...new Uint8Array(buffer)]);
            const deliver = () => { if (this.readyState === Socket.OPEN) super.send(buffer); };
            if (pasteTest.hold) pasteTest.held.push(deliver); else setTimeout(deliver, latency);
          });
        }
      };
      pasteTest.release = () => { pasteTest.hold = false; pasteTest.held.splice(0).forEach(deliver => deliver()); };
      pasteTest.raw = bytes => Socket.prototype.send.call(pasteTest.socket, new Uint8Array(bytes));
    }, latency);
    const page = await context.newPage(); page.on('pageerror', e => errors.push(e.message));
    if (baseline) await page.route('**/app.js', route => route.fulfill({ path: process.env.BASELINE_BUNDLE, contentType: 'text/javascript' }));
    await page.goto(origin + '/' + (windowId ? '?window=' + windowId : '') + '#token=' + token);
    await page.waitForFunction(() => elsewhere.store.get().status === 'connected');
    return page;
  };
  const owner = await connect();
  const fixture = fileURLToPath(new URL('../../crates/elsewhere-compositor/checks/paste-client.py', import.meta.url));
  const windows = {};
  for (const backend of ['wayland', 'x11']) {
    const name = 'paste-' + backend;
    await api('/api/control', { op: 'spawn', cmd: ['env', 'GDK_BACKEND=' + backend, 'python3', fixture, name, root].map(quote).join(' ') });
    windows[backend] = await wait(name, async () => (await (await api('/api/windows')).json()).find(w => w.title === name));
  }
  const image = await owner.evaluate(() => { const canvas = document.createElement('canvas'); canvas.width = 2; canvas.height = 3; return canvas.toDataURL('image/png').split(',')[1]; });
  const imageHash = createHash('sha256').update(Buffer.from(image, 'base64')).digest('hex');
  const activate = async (page, backend = 'wayland') => {
    await page.bringToFront();
    if (!new URL(page.url()).searchParams.has('window')) {
      await page.evaluate(() => elsewhere.takeControl());
      await page.waitForFunction(() => elsewhere.store.get().role === 'controller');
    }
    await api('/api/control', { id: windows[backend].id, op: 'activate' });
    await page.locator('canvas.stage').focus(); await delay(100);
  };
  const paste = async (page, files = null, shift = false, holdModifier = false) => {
    await writeFile(root + '/mime', files ? 'text/uri-list' : 'image/png');
    return page.evaluate(({ image, files, shift, holdModifier }) => {
      const canvas = document.querySelector('canvas.stage'), data = new DataTransfer();
      if (files) for (const file of files) data.items.add(new File([file.text], file.name));
      else data.items.add(new File([Uint8Array.from(atob(image), c => c.charCodeAt(0))], 'image.png', { type: 'image/png' }));
      const event = (type, code, extra) => canvas.dispatchEvent(new KeyboardEvent(type, { code, bubbles: true, cancelable: true, ...extra }));
      const modifier = shift ? 'ShiftLeft' : 'ControlLeft', key = shift ? 'Insert' : 'KeyV', extra = shift ? { shiftKey: true } : { ctrlKey: true };
      const at = Date.now();
      event('keydown', modifier, extra); event('keydown', key, extra);
      canvas.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
      event('keyup', key, extra); if (!holdModifier) event('keyup', modifier, {});
      return at;
    }, { image, files, shift, holdModifier });
  };
  for (const backend of ['wayland', 'x11']) for (const windowMode of [false, true]) {
    for (const baseline of process.env.BASELINE_BUNDLE ? [true, false] : [false]) {
      const page = await connect(admin, { baseline, windowId: windowMode ? windows[backend].id : null, latency: 200 });
      await activate(page, backend);
      for (const files of [null, [{ name: 'same.txt', text: 'first' }, { name: 'same.txt', text: 'second' }]]) {
        const name = 'paste-' + backend, before = (await received(name)).length, keys = await pasteCount(name);
        await page.evaluate(() => { pasteTest.requests = []; pasteTest.packets = []; });
        const start = await paste(page, files, !!files);
        const receipt = await wait('native paste', async () => (await received(name))[before]);
        await delay(250);
        assert.equal(await pasteCount(name), keys + 1, 'exactly one paste chord');
        const held = new Map((await records(name)).filter(r => r.kind === 'key').map(r => [r.code, r.pressed]));
        assert([...held.values()].every(pressed => !pressed), 'paste leaves no keys or modifiers held');
        if (files) {
          assert.deepEqual(receipt.files.map(f => f.text), ['first', 'second']);
          assert.equal(new Set(receipt.files.map(f => f.name)).size, 2, 'collision-renamed saved names');
        } else assert.equal(receipt.sha256, imageHash, 'exact native PNG receipt');
        const chain = await page.evaluate(() => ({ http: pasteTest.requests.filter(r => /\/api\/(?:drop\/|clipboard(?:\/files)?$|input$)/.test(r.path)), compound: pasteTest.packets.length }));
        assert.equal(chain.http.length + chain.compound, (files ? 2 : 0) + (baseline ? 2 : 1));
        assert.equal(chain.http.filter(r => r.path === '/api/input').length, baseline ? 1 : 0);
        console.log(JSON.stringify({ backend, windowMode, baseline, kind: files ? 'files' : 'png', operations: chain.http.length + chain.compound, applicationPasteMs: Math.round(receipt.at - start) }));
      }
      await page.context().close();
    }
  }
  await activate(owner);
  const name = 'paste-wayland';
  const clipboardState = async () => (await api('/api/clipboard/state')).json();
  const clipboardOnly = async action => {
    const before = await clipboardState(), count = await pasteCount(name);
    await action();
    await wait('clipboard-only installation', async () => (await clipboardState()).observation !== before.observation);
    await delay(250); assert.equal(await pasteCount(name), count, 'clipboard write cannot inject input');
  };
  const participant = await connect();
  await clipboardOnly(() => paste(participant));
  const captured = await participant.evaluate(() => pasteTest.packets.at(-1));
  captured[1] |= 1; // A shared bearer and a forged paste flag do not identify the controller's socket.
  const epoch = await owner.evaluate(() => pasteTest.epoch);
  const forged = Buffer.from(captured); forged.writeBigUInt64LE(BigInt(epoch), 2);
  await clipboardOnly(() => participant.evaluate(bytes => pasteTest.raw(bytes), [...forged]));
  const writable = await (await api('/api/tokens', { label: 'Paste writer', permissions: ['desktop.view', 'clipboard.write', 'files.upload'] })).json();
  const writer = await connect(writable.token);
  await clipboardOnly(() => paste(writer, [{ name: 'write-only.txt', text: 'no browse or control required' }]));
  assert.equal((await api('/api/files?path=@transfer', null, writable.token)).status, 403);
  const stolen = await writer.evaluate(() => pasteTest.packets.at(-1));
  const beforeStolen = await clipboardState();
  await participant.evaluate(bytes => pasteTest.raw(bytes), stolen);
  await participant.getByText('Clipboard paste failed: permission denied', { exact: true }).waitFor();
  assert.equal((await clipboardState()).observation, beforeStolen.observation, 'another token cannot name the staged batch');
  // Hold a complete operation while control leaves and returns. Its old tenure remains ineligible.
  await activate(owner);
  await owner.evaluate(() => { pasteTest.hold = true; });
  await paste(owner);
  await owner.waitForFunction(() => pasteTest.held.length === 1);
  await activate(participant); await activate(owner);
  await clipboardOnly(() => owner.evaluate(() => pasteTest.release()));
  await owner.getByText('Clipboard updated; paste skipped because control or window focus changed.', { exact: true }).waitFor();
  // A missed tenure update recovers from the skipped paste, without executing its stale chord.
  for (const missedPromotionOnly of [false, true]) {
    if (!missedPromotionOnly) await owner.evaluate(() => { pasteTest.dropRole = true; });
    await activate(participant);
    if (missedPromotionOnly) {
      await owner.waitForFunction(() => elsewhere.store.get().role === 'participant');
      await owner.evaluate(() => { pasteTest.dropRole = true; });
    }
    await owner.evaluate(() => elsewhere.takeControl()); await delay(150);
    await owner.evaluate(() => { pasteTest.dropRole = false; });
    await clipboardOnly(() => paste(owner));
    await owner.waitForFunction(() => elsewhere.store.get().role === 'controller');
    const recovered = (await received(name)).length;
    await paste(owner);
    await wait('paste after missed role recovery', async () => (await received(name)).length === recovered + 1);
  }
  for (const shift of [false, true]) {
    const before = (await received(name)).length, count = await pasteCount(name);
    await paste(owner, null, shift, true);
    await wait('paste with physically held modifier', async () => (await received(name)).length === before + 1);
    await owner.evaluate(shift => document.querySelector('canvas.stage').dispatchEvent(new KeyboardEvent('keyup', { code: shift ? 'ShiftLeft' : 'ControlLeft', bubbles: true })), shift);
    await delay(150);
    assert.equal(await pasteCount(name), count + 1);
    const held = new Map((await records(name)).filter(r => r.kind === 'key').map(r => [r.code, r.pressed]));
    assert([...held.values()].every(pressed => !pressed), 'held modifier release leaves no stuck input');
  }
  // Partial uploads must not install or paste a partial selection.
  await owner.route('**/api/drop/**/bad.txt', route => route.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"controlled upload failure"}' }));
  const beforeFailure = await clipboardState(), failureKeys = await pasteCount(name);
  await paste(owner, [{ name: 'good.txt', text: 'staged' }, { name: 'bad.txt', text: 'failed' }]);
  await owner.getByText('Some files could not be uploaded.', { exact: true }).waitFor();
  await delay(300);
  assert.equal((await clipboardState()).observation, beforeFailure.observation);
  assert.equal(await pasteCount(name), failureKeys);
  // Cancellation and control changes during the staging upload are checked before selection submission.
  for (const cancel of [false, true]) {
    const page = await connect(); await activate(page);
    let release, started = false;
    const gate = new Promise(resolve => { release = resolve; });
    await page.route('**/api/drop/**', async route => { started = true; await gate; await route.continue().catch(() => {}); });
    const before = await clipboardState(), keys = await pasteCount(name);
    await paste(page, [{ name: 'pending.txt', text: 'pending upload' }]);
    await wait('held staging upload', () => started);
    if (cancel) await page.evaluate(() => elsewhere.cancelUpload());
    else { await activate(participant); await activate(page); }
    release();
    if (cancel) { await delay(400); assert.equal((await clipboardState()).observation, before.observation); }
    else await wait('clipboard after upload handoff', async () => (await clipboardState()).observation !== before.observation);
    await delay(250); assert.equal(await pasteCount(name), keys);
    await page.context().close();
  }
  const deniedToken = await (await api('/api/tokens', { label: 'Paste denied', permissions: ['desktop.view', 'desktop.control'] })).json();
  const denied = await connect(deniedToken.token); await activate(denied);
  const beforeDenied = await clipboardState(), deniedKeys = await pasteCount(name);
  await denied.evaluate(bytes => pasteTest.raw(bytes), [...forged]);
  await denied.getByText('Clipboard paste failed: permission denied', { exact: true }).waitFor();
  assert.equal((await clipboardState()).observation, beforeDenied.observation); assert.equal(await pasteCount(name), deniedKeys);
  await denied.context().close();
  const victim = await (await api('/api/tokens', { label: 'Pending paste', permissions: ['desktop.view', 'desktop.control', 'clipboard.write'] })).json();
  const revoked = await connect(victim.token); await activate(revoked);
  await revoked.evaluate(() => { pasteTest.hold = true; });
  const beforeRevoke = await clipboardState(), revokeKeys = await pasteCount(name);
  await paste(revoked); await revoked.waitForFunction(() => pasteTest.held.length === 1);
  assert.equal((await api('/api/tokens/' + victim.metadata.id, null, admin, 'DELETE')).status, 204);
  await revoked.waitForFunction(() => elsewhere.store.get().status === 'unauthorized');
  await revoked.evaluate(() => pasteTest.release()); await delay(250);
  assert.equal((await clipboardState()).observation, beforeRevoke.observation); assert.equal(await pasteCount(name), revokeKeys);
  await revoked.context().close();
  const windowPage = await connect(admin, { windowId: windows.wayland.id }); await activate(windowPage);
  const cdp = await windowPage.context().newCDPSession(windowPage);
  await windowPage.evaluate(() => { document.title = 'Elsewhere paste focus'; });
  await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: false });
  const chromeWindow = await wait('window viewer native title', () => {
    try { return execFileSync('xdotool', ['search', '--onlyvisible', '--name', 'Elsewhere paste focus|paste-wayland'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim().split('\n')[0]; }
    catch { return null; }
  });
  execFileSync('xdotool', ['windowfocus', chromeWindow]);
  await windowPage.waitForFunction(() => document.hasFocus());
  let releaseWindowUpload, windowUploadStarted = false;
  const windowUpload = new Promise(resolve => { releaseWindowUpload = resolve; });
  await windowPage.route('**/api/drop/**', async route => { windowUploadStarted = true; await windowUpload; await route.continue(); });
  await paste(windowPage, [{ name: 'window-focus.txt', text: 'clipboard only' }]);
  await wait('window staging upload', () => windowUploadStarted);
  focusWindow = spawn('xmessage', ['-title', 'Elsewhere paste other window', 'Focus check'], { stdio: 'ignore' });
  const otherWindow = await wait('other native browser-desktop window', () => {
    try { return execFileSync('xdotool', ['search', '--onlyvisible', '--name', '^Elsewhere paste other window$'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim().split('\n')[0]; }
    catch { return null; }
  });
  execFileSync('xdotool', ['windowfocus', otherWindow]);
  await windowPage.waitForFunction(() => !document.hasFocus());
  await clipboardOnly(async () => { releaseWindowUpload(); });
  await windowPage.getByText('Paste skipped because the window viewer lost focus.', { exact: true }).waitFor();
  focusWindow.kill(); focusWindow = null;
  await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true });
  await activate(windowPage);
  await windowPage.evaluate(() => { pasteTest.hold = true; });
  await paste(windowPage); await windowPage.waitForFunction(() => pasteTest.held.length === 1);
  await api('/api/control', { id: windows.x11.id, op: 'activate' });
  const xKeys = await pasteCount('paste-x11');
  await clipboardOnly(() => windowPage.evaluate(() => pasteTest.release()));
  assert.equal(await pasteCount('paste-x11'), xKeys, 'pending window paste cannot hit another focused application');
  await windowPage.context().close();
  // A disconnected or disposed socket cannot submit its delayed image on the next connection.
  for (const dispose of [false, true]) {
    const page = await connect(); await activate(page);
    await page.evaluate(() => { pasteTest.hold = true; });
    const before = await clipboardState(), keys = await pasteCount(name);
    await paste(page); await page.waitForFunction(() => pasteTest.held.length === 1);
    await page.evaluate(dispose => { if (dispose) elsewhere.dispose(); else pasteTest.socket.close(); }, dispose);
    if (!dispose) await page.waitForFunction(() => elsewhere.store.get().status === 'connected' && pasteTest.socket.readyState === WebSocket.OPEN);
    await page.evaluate(() => pasteTest.release()); await delay(350);
    assert.equal((await clipboardState()).observation, before.observation); assert.equal(await pasteCount(name), keys);
    await page.context().close();
  }
  assert.deepEqual(errors, []);
  console.log('shared-token participant, forged paste flag, write-only files, control tenure, partial failure, disconnect and disposal passed');
} catch (error) {
  console.error(await readFile(root + '/server.log', 'utf8')); throw error;
} finally {
  focusWindow?.kill(); await browser?.close(); server.kill('SIGTERM'); await log.close(); await rm(root, { recursive: true, force: true });
}
