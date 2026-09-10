// Docker native viewer bootstrap, authorization and obsolete socket callbacks.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, open, readFile, rm } from 'node:fs/promises';
import { chromium } from 'playwright-core';
import { createToken } from './token-fixture.mjs';

const root = await mkdtemp('/tmp/elsewhere-bootstrap-');
await mkdir(root + '/runtime', { mode: 0o700 });
const log = await open(root + '/server.log', 'w');
const origin = 'http://127.0.0.1:18447';
const server = spawn(process.env.ELSEWHERE_BINARY || '/src/target/release/elsewhere',
  ['--no-audio', '--no-rtc', '--no-tls', '--render-node', 'none', '--codecs', 'vp8', '--listen', '127.0.0.1:18447', '--socket-name', 'wayland-bootstrap'],
  { cwd: root, env: { ...process.env, HOME: root, XDG_CONFIG_HOME: root + '/config', XDG_RUNTIME_DIR: root + '/runtime' }, stdio: ['ignore', log.fd, log.fd] });
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const wait = async fn => { for (let i = 0; i < 200; i++) { if (await fn()) return; await delay(25); } throw Error('bootstrap condition timed out'); };
let browser, admin;
const api = (path, method = 'GET', body) => fetch(origin + path, { method, headers: { Authorization: 'Bearer ' + admin, 'Content-Type': 'application/json' }, ...(body && { body: JSON.stringify(body) }) });
const create = async (permissions, expires_at_ms) => {
  const response = await api('/api/tokens', 'POST', { label: 'Bootstrap check', permissions, expires_at_ms });
  assert.equal(response.status, 201); return response.json();
};
const revoke = async token => assert.equal((await api('/api/tokens/' + token.metadata.id, 'DELETE')).status, 204);
try {
  await wait(async () => { try { return (await fetch(origin)).ok; } catch { return false; } });
  admin = await createToken(root);
  browser = await chromium.launch({ executablePath: '/usr/bin/chromium', args: ['--no-sandbox'] });
  const connect = async (token, { id, hold = false, baseline = false } = {}) => {
    const context = await browser.newContext();
    await context.route('**/api/me', async route => { await delay(1500); await route.continue(); });
    await context.addInitScript(hold => {
      window.boot = { sockets: [], me: 0, held: [], hold, paintedAt: null };
      const fetch = window.fetch;
      window.fetch = (url, init) => { if (String(url).endsWith('/api/me')) boot.me++; return fetch(url, init); };
      const draw = CanvasRenderingContext2D.prototype.drawImage;
      CanvasRenderingContext2D.prototype.drawImage = function (...args) {
        const result = draw.apply(this, args);
        if (this.canvas.matches('canvas.stage')) boot.paintedAt ??= performance.now();
        return result;
      };
      const Socket = WebSocket;
      window.WebSocket = class extends Socket {
        constructor(...args) {
          super(...args); this.record = { at: performance.now(), sent: [], received: [] }; boot.sockets.push(this);
        }
        send(data) { this.record.sent.push(new Uint8Array(data)[0]); super.send(data); }
        set onmessage(handler) {
          this.deliver = handler;
          super.onmessage = event => {
            this.record.received.push(new Uint8Array(event.data)[0]);
            if (boot.hold) boot.held.push(() => handler(event)); else handler(event);
          };
        }
      };
      boot.release = () => { boot.hold = false; boot.held.splice(0).forEach(deliver => deliver()); };
      boot.staleGrants = socket => socket.deliver({ data: new Uint8Array([0x15, ...new TextEncoder().encode(JSON.stringify(['desktop.view', 'desktop.control', 'apps.launch', 'server.manage']))]).buffer });
    }, hold);
    const page = await context.newPage();
    if (baseline) await page.route('**/app.js', route => route.fulfill({ path: process.env.BASELINE_BUNDLE, contentType: 'text/javascript' }));
    await page.goto(origin + '/' + (id ? '?window=' + id : '') + (token ? '#token=' + token : ''));
    return page;
  };
  const owner = await connect(admin);
  await owner.waitForFunction(() => boot.paintedAt !== null);
  await owner.evaluate(() => elsewhere.spawn('foot --app-id=bootstrap-check'));
  await owner.waitForFunction(() => elsewhere.store.get().windows.some(w => w.app_id === 'bootstrap-check' && w.w > 0));
  const id = await owner.evaluate(() => elsewhere.store.get().windows.find(w => w.app_id === 'bootstrap-check').id);
  for (const windowId of [null, id]) {
    for (const baseline of process.env.BASELINE_BUNDLE ? [true, false] : [false]) {
      const page = await connect(admin, { id: windowId, baseline });
      await page.waitForFunction(() => boot.paintedAt !== null);
      const result = await page.evaluate(() => ({ meRequests: boot.me, socketAtMs: Math.round(boot.sockets[0].record.at), firstFrameAtMs: Math.round(boot.paintedAt), ...boot.sockets[0].record }));
      assert.equal(result.meRequests, baseline ? 1 : 0);
      assert.deepEqual(result.sent.slice(0, 2), [0x80, 0x81], 'AUTH precedes HELLO');
      if (baseline) assert(result.socketAtMs >= 1500, 'controlled HTTP delay gates baseline startup');
      else {
        assert.equal(result.received[0], 0x15, 'grants precede role, configuration and video');
        const permissions = await page.evaluate(() => elsewhere.store.get().permissions);
        assert(permissions.includes('desktop.control') && permissions.includes('tokens.manage'), 'full server-owned grants');
        await page.evaluate(() => { boot.hold = true; boot.sockets[0].close(); });
        await page.waitForFunction(() => boot.sockets.length === 2 && boot.held.length > 0);
        await page.evaluate(() => boot.staleGrants(boot.sockets[0]));
        assert.deepEqual(await page.evaluate(() => elsewhere.store.get().permissions), [], 'old connection cannot restore grants');
        await page.evaluate(() => boot.release());
        await page.waitForFunction(() => elsewhere.store.get().status === 'connected' && elsewhere.store.get().permissions.includes('desktop.control'));
        assert.equal(await page.evaluate(() => boot.me), 0, 'reconnect has no permission preflight');
        await page.evaluate(() => {
          const socket = boot.sockets.at(-1);
          Object.defineProperty(socket, 'readyState', { configurable: true, value: WebSocket.CLOSING });
          boot.staleGrants(socket);
          delete socket.readyState;
        });
        assert.deepEqual(await page.evaluate(() => elsewhere.store.get().permissions), permissions, 'closing current socket cannot apply grants');
        await page.evaluate(() => { elsewhere.dispose(); boot.staleGrants(boot.sockets.at(-1)); });
        assert.deepEqual(await page.evaluate(() => elsewhere.store.get().permissions), [], 'disposed viewer ignores grant callbacks');
      }
      console.log(JSON.stringify({ viewer: windowId ? 'window' : 'desktop', baseline, meRequests: result.meRequests, socketAtMs: result.socketAtMs, firstFrameAtMs: result.firstFrameAtMs, firstServerTags: result.received.slice(0, 5) }));
      await page.context().close();
    }
  }
  const restricted = await create(['desktop.view']);
  const reader = await connect(restricted.token, { hold: true });
  await reader.waitForFunction(() => boot.held.length > 0);
  assert.deepEqual(await reader.evaluate(() => elsewhere.store.get().permissions), []);
  for (const selector of ['#apps-toggle', '#terminal-toggle', '#power-toggle', '#clipboard-toggle']) assert.equal(await reader.locator(selector).count(), 0);
  await reader.evaluate(() => boot.release());
  await reader.waitForFunction(() => elsewhere.store.get().status === 'connected');
  assert.deepEqual(await reader.evaluate(() => elsewhere.store.get().permissions), ['desktop.view']);
  for (const selector of ['#apps-toggle', '#terminal-toggle', '#power-toggle', '#clipboard-toggle']) assert.equal(await reader.locator(selector).count(), 0);
  const victim = await create(['desktop.view', 'desktop.control']);
  const pending = await connect(victim.token, { hold: true });
  await pending.waitForFunction(() => boot.held.length > 0);
  await revoke(victim);
  await pending.waitForFunction(() => elsewhere.store.get().status === 'unauthorized');
  await pending.evaluate(() => { boot.release(); boot.staleGrants(boot.sockets[0]); });
  assert.deepEqual(await pending.evaluate(() => elsewhere.store.get().permissions), [], 'revoked bootstrap callbacks stay obsolete');
  const denied = await create([]);
  const expired = await create(['desktop.view'], Date.now() + 100);
  await delay(150);
  for (const [label, token, expected, retained] of [['missing', '', 'no-token', false], ['invalid', 'invalid', 'unauthorized', false], ['expired', expired.token, 'unauthorized', false], ['revoked', victim.token, 'unauthorized', false], ['denied', denied.token, 'unauthorized', true]]) {
    const page = await connect(token);
    await page.waitForFunction(expected => elsewhere.store.get().status === expected, expected);
    const state = await page.evaluate(() => ({ permissions: elsewhere.store.get().permissions, reason: elsewhere.store.get().reason, retained: [...Array(sessionStorage.length)].some((_, i) => sessionStorage.key(i).endsWith('token')) }));
    assert.deepEqual(state.permissions, []);
    assert.equal(state.retained, retained, label + ' token retention');
    if (label === 'denied') assert.match(state.reason, /does not allow desktop viewing/);
    else if (label !== 'missing') assert.equal(state.reason, 'Invalid or expired token');
    assert.equal(await page.evaluate(() => boot.me), 0);
    await page.context().close();
  }
  const deadlines = await owner.evaluate(async token => Promise.all([false, true].map(authenticate => new Promise((resolve, reject) => {
    const start = performance.now(), socket = new WebSocket(location.origin.replace('http:', 'ws:') + '/ws');
    const timeout = setTimeout(() => { socket.close(); reject(Error('authentication deadline did not close the socket')); }, 9000);
    socket.onopen = () => { if (authenticate) socket.send(new Uint8Array([0x80, ...new TextEncoder().encode(token)])); };
    socket.onclose = event => { clearTimeout(timeout); resolve({ authenticate, code: event.code, elapsed: performance.now() - start }); };
  }))), admin);
  for (const deadline of deadlines) assert(deadline.elapsed >= 4500 && deadline.elapsed < 9000, 'AUTH and HELLO retain their five-second deadlines');
  assert.equal(deadlines[0].code, 4001);
  console.log('restricted bootstrap, reconnect, obsolete callbacks, disposal, revocation, missing/invalid/expired/view-denied tokens passed');
} catch (error) {
  console.error(await readFile(root + '/server.log', 'utf8'));
  throw error;
} finally {
  await browser?.close();
  server.kill('SIGTERM');
  await new Promise(resolve => server.exitCode !== null || server.signalCode !== null ? resolve() : server.once('exit', resolve));
  await log.close();
  await rm(root, { recursive: true, force: true, maxRetries: 5 });
}
