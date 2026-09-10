// Docker: two native viewers, GTK clipboard owner, payload counts and observed-write races.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, open, readFile, writeFile, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { createToken } from './token-fixture.mjs';

// EXPECT_PAYLOAD_GETS=1 uses ELSEWHERE_BINARY for the measured baseline server and its embedded viewer.
const baseline = process.env.EXPECT_PAYLOAD_GETS === '1';
const root = await mkdtemp('/tmp/elsewhere-clipboard-sync-');
await mkdir(root + '/runtime', { mode: 0o700 });
const log = await open(root + '/server.log', 'w');
const origin = 'http://127.0.0.1:18449';
const errors = [];
const server = spawn(process.env.ELSEWHERE_BINARY || '/src/target/release/elsewhere',
  ['--no-audio', '--no-rtc', '--no-tls', '--render-node', 'none', '--codecs', 'vp8', '--listen', '127.0.0.1:18449'],
  { cwd: root, env: { ...process.env, HOME: root, XDG_CONFIG_HOME: root + '/config', XDG_RUNTIME_DIR: root + '/runtime' }, stdio: ['ignore', log.fd, log.fd] });
const serverExited = new Promise(resolve => {
  server.once('exit', resolve);
  server.once('error', error => { errors.push(error); resolve(); });
});
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const wait = async (label, fn) => { for (let i = 0; i < 300; i++) { const result = await fn(); if (result) return result; await delay(25); } throw Error(label + ' timed out'); };
const quote = s => "'" + s.replaceAll("'", "'\\''") + "'";
let browser, admin, serverOutput;
const viewers = new Set();
const api = (path, body) => fetch(origin + path, { method: body ? 'POST' : 'GET', headers: { Authorization: 'Bearer ' + admin, 'Content-Type': 'application/json' }, ...(body && { body: JSON.stringify(body) }) });
try {
  await wait('server', async () => { if (errors.length) throw errors[0]; try { return (await fetch(origin)).ok; } catch { return false; } });
  admin = await createToken(root);
  browser = await chromium.launch({ executablePath: '/usr/bin/chromium', args: ['--no-sandbox'] });
  const connect = async (token = admin, windowId = null) => {
    const context = await browser.newContext(), requests = [], controls = { holdWrite: false, release: null, closing: false };
    const viewer = { context, requests, controls, close: async () => {
      controls.closing = true;
      controls.release?.();
      let timeout;
      try {
        await Promise.race([
          context.unrouteAll({ behavior: 'wait' }),
          new Promise((_, reject) => { timeout = setTimeout(() => reject(Error('Clipboard route drain timed out')), 35000); }),
        ]);
      } finally { clearTimeout(timeout); await context.close(); viewers.delete(viewer); }
    } };
    viewers.add(viewer);
    await context.route('**/api/clipboard{,/state}', async route => {
      const recordError = error => {
        if (!controls.closing || !/Target page, context or browser has been closed|Route is already handled!/.test(error.message)) errors.push(error);
      };
      try {
        const request = route.request(), record = { path: new URL(request.url()).pathname, at: Date.now(), bytes: 0 };
        if (request.method() === 'GET') requests.push(record);
        await delay(100);
        const response = await route.fetch();
        const body = await response.body(); record.bytes = body.length;
        await delay(100);
        if (request.method() === 'PUT' && controls.holdWrite && !controls.closing) {
          controls.holdWrite = false;
          // Keep the closing check and hold assignment synchronous.
          controls.operation = JSON.parse(body).operation;
          await new Promise(resolve => { controls.release = resolve; });
        }
        if (request.method() === 'GET' && record.path === '/api/clipboard' && controls.holdRead && !controls.closing) {
          controls.holdRead = false;
          await new Promise(resolve => { controls.release = resolve; });
        }
        if (controls.closing) await route.fallback();
        else await route.fulfill({ response });
      } catch (error) {
        recordError(error);
        await route.abort().catch(async error => {
          recordError(error);
          await route.fallback().catch(recordError);
        });
      }
    });
    await context.addInitScript(() => {
      window.syncTest = { copies: [], drop: false };
      Object.defineProperty(navigator, 'clipboard', { value: {
        writeText: async text => { syncTest.copies.push({ text }); throw Error('controlled clipboard permission denial'); },
        write: async items => {
          const blob = await items[0].getType('image/png');
          syncTest.copies.push({ png: [...new Uint8Array(await blob.arrayBuffer())] });
          throw Error('controlled clipboard permission denial');
        },
      } });
      const Socket = WebSocket;
      window.WebSocket = class extends Socket {
        constructor(...args) { super(...args); syncTest.socket = this; }
        set onmessage(handler) { super.onmessage = event => { if (!(syncTest.drop && new Uint8Array(event.data)[0] === 7)) handler(event); }; }
      };
    });
    const page = await context.newPage();
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(origin + (windowId === null ? '/' : '/?window=' + windowId) + '#token=' + token);
    await page.waitForFunction(() => elsewhere.store.get().status === 'connected' && elsewhere.store.get().clipboardState.status === 'ready');
    viewer.page = page;
    return viewer;
  };
  const main = await connect(), other = await connect();
  const fixture = fileURLToPath(new URL('../../crates/elsewhere-compositor/checks/clipboard-source.py', import.meta.url));
  await api('/api/control', { op: 'spawn', cmd: ['env', 'GDK_BACKEND=wayland', 'python3', fixture, root].map(quote).join(' ') });
  const window = await wait('native clipboard owner', async () => (await (await api('/api/windows')).json()).find(w => w.title === 'clipboard-source'));
  const nativeCopy = async text => {
    await writeFile(root + '/native-copy', text);
    await api('/api/control', { id: window.id, op: 'activate' });
    await api('/api/input', { type: 'key', keys: 'ctrl+c' });
  };
  const panel = async (page, opened) => {
    const toggle = page.locator('#clipboard-toggle');
    if ((await toggle.getAttribute('aria-expanded')) === String(!opened)) await toggle.click();
  };
  const observation = page => page.evaluate(() => elsewhere.store.get().clipboardState.observation);
  const measure = async (kind, viewer, action, ready) => {
    await delay(250); viewer.requests.length = 0;
    const start = Date.now(); await action(); await ready();
    const confirmationMs = Date.now() - start;
    await delay(300);
    const records = viewer.requests, payload = records.filter(r => r.path === '/api/clipboard');
    const result = { kind, baseline, payloadGets: payload.length, payloadBytes: payload.reduce((sum, r) => sum + r.bytes, 0), metadataGets: records.length - payload.length, confirmationMs };
    console.log(JSON.stringify(result));
    assert(baseline ? result.payloadGets > 0 : result.payloadGets === 0, kind + ' payload reads');
  };
  let pngPayload;
  for (const opened of [false, true]) {
    await panel(main.page, opened);
    const before = await observation(main.page);
    const otherBefore = await observation(other.page);
    let png;
    await measure('local PNG panel ' + (opened ? 'open' : 'closed'), main, async () => {
      png = await main.page.evaluate(opened => {
        const canvas = document.createElement('canvas'); canvas.width = 120; canvas.height = 80;
        const context = canvas.getContext('2d'); context.fillStyle = opened ? '#409aad' : '#ad5940'; context.fillRect(0, 0, 120, 80);
        const bytes = Uint8Array.from(atob(canvas.toDataURL('image/png').split(',')[1]), c => c.charCodeAt(0));
        const data = new DataTransfer(); data.items.add(new File([bytes], 'image.png', { type: 'image/png' }));
        document.querySelector('canvas.stage').dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
        return [...bytes];
      }, opened);
    }, () => main.page.waitForFunction(before => {
      const state = elsewhere.store.get().clipboardState;
      return state.observation !== before && state.mime === 'image/png' && state.blob;
    }, before));
    pngPayload = png;
    await other.page.waitForFunction(({ before, png }) => elsewhere.store.get().clipboardState.observation !== before && JSON.stringify(syncTest.copies.filter(c => c.png).at(-1)?.png) === JSON.stringify(png), { before: otherBefore, png });
    assert.deepEqual(await other.page.evaluate(() => syncTest.copies.filter(c => c.png).at(-1).png), png, 'other viewer receives exact PNG despite browser write denial');
  }
  await panel(main.page, true);
  const localText = 'local editor contents\n'.repeat(4096);
  await measure('local editor text', main, () => main.page.evaluate(text => elsewhere.clipboard.write(text), localText),
    () => main.page.waitForFunction(text => elsewhere.store.get().clipboardState.text === text, localText));
  await panel(other.page, true);
  const nativeText = 'native clipboard contents\n'.repeat(4096);
  await measure('native live text', other, () => nativeCopy(nativeText),
    () => other.page.waitForFunction(text => elsewhere.store.get().clipboardState.text === text, nativeText));
  await main.page.waitForFunction(text => elsewhere.store.get().clipboardState.text === text, nativeText);
  assert.equal(await other.page.evaluate(() => syncTest.copies.filter(copy => 'text' in copy).at(-1).text), nativeText);
  // Recovery metadata still repairs a missed native clipboard event.
  await other.page.evaluate(() => { syncTest.drop = true; });
  await nativeCopy('missed clipboard event');
  await other.page.waitForFunction(() => elsewhere.store.get().clipboardState.text === 'missed clipboard event', null, { timeout: 6000 });
  await other.page.evaluate(() => { syncTest.drop = false; });
  if (!baseline) {
    const beginHeldWrite = async (viewer, text, missed = false) => {
      viewer.controls.holdWrite = true; viewer.controls.release = null;
      await viewer.page.evaluate(text => {
        syncTest.writeOutcome = null;
        elsewhere.clipboard.write(text).then(() => { syncTest.writeOutcome = 'ok'; }, error => { syncTest.writeOutcome = error.message; });
      }, text);
      await wait('held write response', () => viewer.controls.release);
      if (missed) await viewer.page.waitForFunction(operation => elsewhere.store.get().clipboardState.operation === operation, viewer.controls.operation);
      else await viewer.page.waitForFunction(text => elsewhere.store.get().clipboardState.text === text, text);
    };
    const lateCopies = page => page.evaluate(() => syncTest.copies.filter(c => 'text' in c).at(-1)?.text);
    await beginHeldWrite(main, 'write observed before its response');
    await nativeCopy('native replacement before response');
    await main.page.waitForFunction(() => elsewhere.store.get().clipboardState.text === 'native replacement before response');
    main.controls.release();
    await main.page.waitForFunction(() => syncTest.writeOutcome === 'ok');
    assert.equal(await lateCopies(main.page), 'native replacement before response', 'late write response must not restore superseded text');
    await beginHeldWrite(main, 'second delayed write');
    await other.page.evaluate(() => elsewhere.clipboard.write('other viewer replacement'));
    main.controls.release();
    await main.page.waitForFunction(() => syncTest.writeOutcome === 'ok');
    assert.equal(await lateCopies(main.page), 'other viewer replacement');
    await main.page.evaluate(() => { syncTest.drop = true; });
    main.requests.length = 0;
    await beginHeldWrite(main, 'missed event without replacement', true);
    main.controls.release();
    await main.page.waitForFunction(() => syncTest.writeOutcome === 'ok' && elsewhere.store.get().clipboardState.text === 'missed event without replacement');
    await delay(2200);
    assert.equal(main.requests.filter(r => r.path === '/api/clipboard').length, 0, 'metadata-confirmed local text survives the next recovery poll without a body GET');
    await beginHeldWrite(main, 'write confirmed by recovery poll', true);
    await main.page.evaluate(() => { syncTest.drop = false; });
    await nativeCopy('replacement after metadata confirmation');
    await main.page.waitForFunction(() => elsewhere.store.get().clipboardState.text === 'replacement after metadata confirmation');
    main.controls.release();
    await main.page.waitForFunction(() => syncTest.writeOutcome === 'ok');
    assert.equal(await lateCopies(main.page), 'replacement after metadata confirmation');
    await beginHeldWrite(main, 'confirmed before many concurrent copies');
    for (let i = 0; i < 70; i++) {
      const text = 'concurrent selection ' + i;
      const response = await fetch(origin + '/api/clipboard', { method: 'PUT', headers: { Authorization: 'Bearer ' + admin }, body: text });
      assert.equal(response.status, 202);
      await main.page.waitForFunction(text => elsewhere.store.get().clipboardState.text === text, text);
    }
    main.controls.release();
    await main.page.waitForFunction(() => syncTest.writeOutcome === 'ok');
    assert.equal(await lateCopies(main.page), 'concurrent selection 69');
    for (const dispose of [false, true]) {
      const viewer = await connect(); await panel(viewer.page, true);
      await beginHeldWrite(viewer, 'stale response ' + dispose);
      await viewer.page.evaluate(dispose => {
        if (dispose) elsewhere.dispose(); else syncTest.socket.close();
        syncTest.copies.length = 0;
      }, dispose);
      await viewer.page.waitForFunction(() => elsewhere.store.get().status !== 'connected');
      viewer.controls.release();
      await viewer.page.waitForFunction(() => syncTest.writeOutcome !== null);
      assert.notEqual(await viewer.page.evaluate(() => syncTest.writeOutcome), 'ok');
      assert.deepEqual(await viewer.page.evaluate(() => syncTest.copies), [], 'stale write response cannot copy after disconnect/disposal');
      await viewer.close();
    }
    const windowViewer = await connect(admin, window.id);
    await panel(windowViewer.page, true);
    await windowViewer.page.waitForFunction(() => elsewhere.store.get().clipboardState.text !== null);
    const windowBefore = await observation(windowViewer.page);
    await measure('window local PNG', windowViewer, () => windowViewer.page.evaluate(png => {
      const data = new DataTransfer(); data.items.add(new File([Uint8Array.from(png)], 'image.png', { type: 'image/png' }));
      document.querySelector('canvas.stage').dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
    }, pngPayload), () => windowViewer.page.waitForFunction(before => { const state = elsewhere.store.get(); return state.clipboardState.observation !== before && state.clipboardState.blob && state.clipboardState.source?.session === String(state.sessionId); }, windowBefore));
    await windowViewer.close();
    for (const dispose of [false, true]) {
      const viewer = await connect();
      viewer.controls.holdRead = true; viewer.controls.release = null;
      await fetch(origin + '/api/clipboard', { method: 'PUT', headers: { Authorization: 'Bearer ' + admin, 'Content-Type': 'image/png' }, body: Uint8Array.from(pngPayload) });
      await wait('held PNG read response', () => viewer.controls.release);
      await viewer.page.evaluate(dispose => {
        if (dispose) elsewhere.dispose(); else syncTest.socket.close();
        syncTest.copies.length = 0;
      }, dispose);
      await viewer.page.waitForFunction(() => elsewhere.store.get().status !== 'connected');
      viewer.controls.release();
      await delay(100);
      assert.deepEqual(await viewer.page.evaluate(() => syncTest.copies), [], 'stale body response cannot write the browser clipboard');
      assert.equal(await viewer.page.evaluate(() => elsewhere.store.get().clipboardState.blob), null);
      await viewer.close();
    }
    const writeOnlyToken = await createToken(root, ['desktop.view', 'clipboard.write']);
    // A write-only viewer has no metadata or payload reads and cannot copy into its browser clipboard.
    const context = await browser.newContext(), page = await context.newPage(), reads = [];
    page.on('pageerror', error => errors.push(error));
    page.on('request', request => { if (request.method() === 'GET' && new URL(request.url()).pathname.startsWith('/api/clipboard')) reads.push(request.url()); });
    await page.goto(origin + '/#token=' + writeOnlyToken);
    await page.waitForFunction(() => elsewhere.store.get().status === 'connected');
    await page.evaluate(() => elsewhere.clipboard.write('write-only clipboard selection'));
    await main.page.waitForFunction(() => elsewhere.store.get().clipboardState.text === 'write-only clipboard selection');
    assert.deepEqual(reads, [], 'write-only viewer performs no clipboard reads');
    await context.close();
    console.log('observed-before-response, native/other-viewer replacement, disconnect/dispose and write-only passed');
  }
  for (const { closeNow, method } of [
    { closeNow: true, method: 'GET' }, { closeNow: false, method: 'GET' },
    { closeNow: true, method: 'PUT' }, { closeNow: false, method: 'PUT' },
  ]) {
    const viewer = await connect();
    viewer.controls[method === 'GET' ? 'holdRead' : 'holdWrite'] = true;
    await viewer.page.evaluate(({ token, method }) => {
      fetch('/api/clipboard', { method, headers: { Authorization: 'Bearer ' + token }, ...(method === 'PUT' && { body: 'held teardown write' }) }).catch(() => {});
    }, { token: admin, method });
    await wait('clipboard response held during teardown', () => viewer.controls.release);
    if (closeNow) await viewer.close();
  }
  assert.deepEqual(errors, []);
  console.log('two-viewer native synchronization, permission denial and recovery polling passed');
} catch (error) {
  console.error(await readFile(root + '/server.log', 'utf8')); throw error;
} finally {
  try {
    const closed = await Promise.allSettled([...viewers].map(viewer => viewer.close()));
    for (const result of closed) if (result.status === 'rejected') errors.push(result.reason);
    await browser?.close().catch(error => errors.push(error));
  } finally {
    server.kill('SIGTERM');
    const timeout = setTimeout(() => server.kill('SIGKILL'), 5000);
    try { await serverExited; } finally { clearTimeout(timeout); }
    serverOutput = await readFile(root + '/server.log', 'utf8');
    await log.close();
    await rm(root, { recursive: true, force: true, maxRetries: 5 });
  }
}
if (errors.length) console.error(serverOutput);
assert.deepEqual(errors, [], 'clipboard route and page errors');
