import { createToken } from './token-fixture.mjs';
// Run in the Docker rig with nginx, OpenSSL, Chromium, foot and a current Elsewhere binary.
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, open, readFile, writeFile, rm } from 'node:fs/promises';
import { chromium } from 'playwright-core';

const root = await mkdtemp('/tmp/elsewhere-prefix-');
const origin = 'https://127.0.0.1:8499';
const instances = [
  { name: 'alice', prefix: '/elsewhere/alice', port: 8091, udp: 50901 },
  { name: 'bob', prefix: '/elsewhere/bob', port: 8092, udp: 50902, strip: true },
  { name: 'root', prefix: '', port: 8093, udp: 50903 },
];
const processes = [], logs = [];
const contents = path => readFile(path, 'utf8').catch(() => '');
const wait = async (label, predicate) => {
  for (let i = 0; i < 400; i++) {
    if (await predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error(label + ' timed out');
};
const start = async (command, args, cwd, env = process.env) => {
  const log = await open(cwd + '/process.log', 'w');
  logs.push(log);
  const child = spawn(command, args, { cwd, env, stdio: ['ignore', log.fd, log.fd] });
  processes.push(child);
  return child;
};
let browser;
try {
  for (const instance of instances) {
    const dir = instance.dir = root + '/' + instance.name;
    await mkdir(dir);
    await mkdir(dir + '/runtime', { mode: 0o700 });
    await mkdir(dir + '/files');
    await start(process.env.ELSEWHERE_BINARY || '/src/target/release/elsewhere', [
      '--no-audio', '--no-tls', '--render-node', 'none', '--codecs', 'vp8', '--screen-size', '640x480',
      '--listen', `127.0.0.1:${instance.port}`, '--socket-name', 'wayland-prefix', '--files-dir', dir + '/files',
      '--rtc-addr', '127.0.0.1', '--rtc-port', String(instance.udp),
      ...(instance.prefix ? ['--url-prefix', instance.prefix + '/'] : []),
      ...(instance.strip ? ['--proxy-strips-prefix'] : []),
    ], dir, { ...process.env, SHELL: '/bin/bash', XDG_CONFIG_HOME: dir + '/config', XDG_RUNTIME_DIR: dir + '/runtime' });
    const backend = `http://127.0.0.1:${instance.port}`;
    await wait(instance.name + ' startup', async () => {
      try { return (await fetch(backend + (instance.strip ? '' : instance.prefix) + '/')).ok; } catch { return false; }
    });
    instance.token = await createToken(dir);
    assert.ok(instance.token);
    assert.equal(await contents(dir + '/config/elsewhere/cert.pem'), '', '--no-tls needs no HTTPS certificate');
    if (instance.prefix && !instance.strip) {
      const redirect = await fetch(backend + instance.prefix + '?window=1', { redirect: 'manual' });
      assert.equal(redirect.status, 308);
      assert.equal(redirect.headers.get('location'), instance.prefix + '/?window=1');
      assert.equal((await fetch(backend + '/api/windows')).status, 404);
    }
  }
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=localhost',
    '-keyout', root + '/key.pem', '-out', root + '/cert.pem'], { stdio: 'ignore' });
  await writeFile(root + '/nginx.conf', `
    daemon off;
    pid ${root}/nginx.pid;
    error_log ${root}/nginx-error.log;
    events {}
    http {
      access_log off;
      client_body_temp_path ${root}/body;
      proxy_temp_path ${root}/proxy;
      map $http_upgrade $connection_upgrade { default upgrade; '' close; }
      server {
        listen 127.0.0.1:8499 ssl;
        ssl_certificate ${root}/cert.pem;
        ssl_certificate_key ${root}/key.pem;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection $connection_upgrade;
        proxy_set_header Host $host;
        proxy_read_timeout 1h;
        proxy_buffering off;
        proxy_request_buffering off;
        client_max_body_size 4m;
        ${instances.map(i => `
          ${i.prefix ? `location = ${i.prefix} { return 308 ${i.prefix}/$is_args$args; }` : ''}
          location ${i.prefix}/ { proxy_pass http://127.0.0.1:${i.port}${i.strip ? '/' : ''}; }
        `).join('')}
      }
    }
  `);
  await start('nginx', ['-p', root, '-c', root + '/nginx.conf'], root);
  browser = await chromium.launch({ executablePath: '/usr/bin/chromium', headless: true, args: ['--no-sandbox'] });
  const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1100, height: 850 } });
  await wait('nginx', async () => { try { return (await context.request.get(origin)).ok(); } catch { return false; } });
  const errors = [];
  context.on('page', page => page.on('pageerror', error => errors.push(error.message)));
  await context.addInitScript(() => {
    const Original = RTCPeerConnection;
    window.peers = [];
    window.RTCPeerConnection = class extends Original { constructor(...args) { super(...args); peers.push(this); } };
  });
  for (const instance of instances) {
    const { prefix, token, name, dir } = instance;
    const base = origin + prefix;
    const auth = { Authorization: 'Bearer ' + token };
    assert.equal((await context.request.get(base + '/api/windows')).status(), 401);
    const page = instance.page = await context.newPage();
    const paths = [], sockets = [];
    page.on('request', request => { if (request.url().startsWith(origin)) paths.push(new URL(request.url()).pathname); });
    page.on('websocket', socket => sockets.push(new URL(socket.url()).pathname));
    // Exercise fragment login for Alice, and the token form for the other instances.
    await page.goto(base + '/' + (name === 'alice' ? '#token=' + token : ''));
    if (name !== 'alice') {
      await page.getByPlaceholder('token', { exact: true }).fill(token);
      await page.getByRole('button', { name: 'Connect', exact: true }).click();
    }
    await page.waitForFunction(() => window.elsewhere?.store.get().role === 'controller');
    await page.waitForFunction(() => elsewhere.store.get().stats.frames > 0);
    assert.equal(await page.evaluate(() => location.hash), '');
    assert.equal(await page.evaluate(() => document.baseURI), base + '/');
    const key = `elsewhere${prefix ? ':' + prefix : ''}.token`;
    assert.equal(await page.evaluate(key => sessionStorage.getItem(key), key), token);
    await page.evaluate(() => elsewhere.setCaptureOnClick(true));
    assert.equal(await page.evaluate(key => localStorage.getItem(key), key.replace(/token$/, 'captureOnClick')), '1');
    await page.evaluate(name => elsewhere.clipboard.write(name), name);
    assert.equal(await page.evaluate(() => elsewhere.clipboard.read()), name);
    assert.ok(await page.evaluate(async () => (await elsewhere.snapshot(null)).size) > 0);
    const filePath = `${base}/api/files/probe.txt?path=${encodeURIComponent(dir + '/files')}`;
    const body = name.repeat(400000);
    assert.equal((await context.request.put(filePath, { headers: auth, data: body })).status(), 201);
    assert.equal(await (await context.request.get(filePath, { headers: auth })).text(), body);
    assert.equal((await context.request.delete(filePath, { headers: auth })).status(), 204);
    assert.ok((await context.request.get(base + '/skill/SKILL.md')).ok());
    const initialize = await context.request.post(base + '/mcp', { headers: { ...auth, Accept: 'application/json, text/event-stream' },
      data: { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'prefix-check', version: '1' } } } });
    assert.ok(initialize.ok(), `MCP initialize: ${initialize.status()} ${await initialize.text()}`);
    assert.match(await initialize.text(), /"serverInfo"/);
    const session = initialize.headers()['mcp-session-id'];
    const mcpHeaders = { ...auth, Accept: 'application/json, text/event-stream', ...(session ? { 'Mcp-Session-Id': session } : {}) };
    const initialized = await context.request.post(base + '/mcp', { headers: mcpHeaders, data: { jsonrpc: '2.0', method: 'notifications/initialized' } });
    assert.ok(initialized.ok());
    const tools = await context.request.post(base + '/mcp', { headers: mcpHeaders, data: { jsonrpc: '2.0', id: 2, method: 'tools/list' } });
    assert.ok(tools.ok(), `MCP tools: ${tools.status()} ${await tools.text()}`);
    assert.match(await tools.text(), /"tools"/);
    await page.getByRole('button', { name: 'Terminal', exact: true }).click();
    const terminal = page.getByRole('region', { name: 'Terminal', exact: true });
    await terminal.getByRole('status').filter({ hasText: 'Connected' }).waitFor();
    await terminal.locator('textarea').focus();
    await page.keyboard.type(`printf terminal-ok > ${dir}/terminal-result`);
    await page.keyboard.press('Enter');
    await wait('terminal command', async () => await contents(dir + '/terminal-result') === 'terminal-ok');
    await page.getByRole('button', { name: 'Terminal', exact: true }).click();
    await page.evaluate(name => elsewhere.spawn('foot --app-id=prefix-' + name), name);
    await page.waitForFunction(name => elsewhere.store.get().windows.some(w => w.app_id === 'prefix-' + name), name);
    const popupPromise = page.waitForEvent('popup');
    await page.getByRole('button', { name: 'Open in its own window', exact: true }).first().click({ force: true });
    const popup = instance.popup = await popupPromise;
    await popup.waitForFunction(() => window.elsewhere?.store.get().stats.frames > 0);
    assert.equal(new URL(popup.url()).pathname, prefix + '/');
    assert.equal(await popup.evaluate(key => sessionStorage.getItem(key), key), token);
    assert.equal(await page.evaluate(() => elsewhere.pip.supported), true, 'rig supports document PiP');
    await page.getByRole('button', { name: 'Picture-in-picture', exact: true }).first().click();
    await page.waitForFunction(() => documentPictureInPicture.window?.document.querySelector('iframe')?.contentWindow.elsewhere?.store.get().stats.frames > 0);
    assert.equal(await page.evaluate(() => new URL(documentPictureInPicture.window.document.querySelector('iframe').src).pathname), prefix + '/');
    await page.evaluate(() => elsewhere.pip.close());
    await page.evaluate(() => elsewhere.setTransport('webrtc'));
    await page.waitForFunction(() => elsewhere.store.get().videoVia === 'webrtc');
    const remote = await page.evaluate(() => peers.at(-1).remoteDescription.sdp);
    assert.match(remote, new RegExp(`a=candidate:.* 127\\.0\\.0\\.1 ${instance.udp} `));
    await page.evaluate(() => peers.at(-1).close());
    await page.waitForFunction(() => elsewhere.store.get().videoVia === 'websocket');
    await page.evaluate(() => elsewhere.setTransport('websocket'));
    assert.ok(sockets.includes(prefix + '/ws'));
    assert.ok(sockets.includes(prefix + '/ws/terminal'));
    assert.ok(paths.every(path => path === '/favicon.ico' || path.startsWith(prefix + '/')), JSON.stringify(paths));
    console.log(name + ': HTTPS, assets, auth, API, uploads, MCP, terminal, window popup, PiP, WebRTC and fallback passed');
  }
  const [alice, bob] = instances;
  for (const instance of [alice, bob]) {
    await instance.page.getByRole('button', { name: 'Broadcasts', exact: true }).click();
  }
  await alice.page.getByRole('button', { name: 'Add preset', exact: true }).click();
  const preset = alice.page.getByRole('form', { name: 'Broadcast preset' });
  await preset.getByLabel('Name', { exact: true }).fill('Shared broadcast check');
  await preset.getByLabel('Ingest URL').fill('rtmp://127.0.0.1:19399/live');
  await preset.getByLabel('Stream key').fill('browser-secret-sentinel');
  await preset.getByRole('button', { name: 'Save preset' }).click();
  await bob.page.getByText('Shared broadcast check', { exact: true }).waitFor();
  assert.equal(await bob.page.evaluate(() => Object.keys(localStorage).filter(k => k.startsWith('elsewhere.broadcastPreset.')).length), 1);
  const participant = await context.newPage();
  await participant.goto(origin + alice.prefix + '/');
  await participant.getByPlaceholder('token', { exact: true }).fill(alice.token);
  await participant.getByRole('button', { name: 'Connect', exact: true }).click();
  await participant.waitForFunction(() => window.elsewhere?.store.get().role === 'participant');
  await participant.getByRole('button', { name: 'Broadcasts', exact: true }).click();
  await participant.route('**/api/broadcasts/start', route => route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ error: 'Invalid test destination.' }) }));
  await participant.getByRole('button', { name: 'Start', exact: true }).click();
  await participant.getByRole('alert').filter({ hasText: 'Invalid test destination.' }).waitFor();
  await participant.unroute('**/api/broadcasts/start');
  let failPoll = true;
  await participant.route('**/api/broadcasts', route => failPoll ? route.fulfill({ status: 502, contentType: 'text/plain', body: 'Upstream unavailable' }) : route.continue());
  await participant.getByRole('alert').filter({ hasText: 'Broadcast request failed (HTTP 502).' }).waitFor();
  assert.equal(await participant.getByRole('alert').filter({ hasText: 'Invalid test destination.' }).count(), 1);
  failPoll = false;
  await wait('broadcast polling recovers', async () => await participant.getByRole('alert').filter({ hasText: 'Broadcast request failed' }).count() === 0);
  await participant.unroute('**/api/broadcasts');
  await participant.getByRole('button', { name: 'Start', exact: true }).click();
  const authAlice = { Authorization: 'Bearer ' + alice.token };
  await wait('participant starts broadcast', async () => (await (await context.request.get(origin + alice.prefix + '/api/broadcasts', { headers: authAlice })).json()).length === 1);
  assert.equal((await (await context.request.get(origin + bob.prefix + '/api/broadcasts', { headers: { Authorization: 'Bearer ' + bob.token } })).json()).length, 0);
  await participant.getByRole('button', { name: 'Stop', exact: true }).click();
  await wait('participant stops broadcast', async () => (await (await context.request.get(origin + alice.prefix + '/api/broadcasts', { headers: authAlice })).json())[0].state === 'stopped');
  await participant.close();
  await bob.page.getByRole('button', { name: 'Edit', exact: true }).click();
  assert.equal(await bob.page.getByRole('form', { name: 'Broadcast preset' }).getByLabel('Stream key').inputValue(), 'browser-secret-sentinel');
  await bob.page.getByRole('form', { name: 'Broadcast preset' }).getByLabel('Name', { exact: true }).fill('Shared edited preset');
  await bob.page.getByRole('button', { name: 'Save preset', exact: true }).click();
  await alice.page.getByText('Shared edited preset', { exact: true }).waitFor();
  await alice.page.getByRole('button', { name: 'Remove', exact: true }).click();
  await wait('preset removed in other instance', async () => await bob.page.getByText('Shared edited preset', { exact: true }).count() === 0);
  console.log('Broadcast presets share across instance paths; participant broadcast start/stop and host-specific status passed');

  assert.notEqual(await alice.popup.evaluate(() => window.name), await bob.popup.evaluate(() => window.name));
  assert.ok(!alice.popup.isClosed() && !bob.popup.isClosed(), 'both instance popups remain open');
  assert.equal(await alice.page.evaluate(() => elsewhere.clipboard.read()), 'alice');
  assert.equal(await bob.page.evaluate(() => elsewhere.clipboard.read()), 'bob');
  assert.equal((await context.request.get(origin + bob.prefix + '/api/windows', { headers: { Authorization: 'Bearer ' + alice.token } })).status(), 401);
  await alice.page.evaluate(() => elsewhere.setCaptureOnClick(false));
  await bob.page.reload();
  await bob.page.waitForFunction(() => window.elsewhere?.store.get().status === 'connected');
  assert.equal(await bob.page.evaluate(() => elsewhere.store.get().captureOnClick), true);
  // Same-tab navigation must not inherit another instance's token.
  await alice.page.goto(origin + bob.prefix + '/');
  await alice.page.waitForFunction(() => window.elsewhere?.store.get().status === 'no-token');
  assert.deepEqual(errors, []);
  console.log('prefix isolation and unprefixed compatibility passed');
} catch (error) {
  console.error(error);
  for (const instance of instances) console.error(instance.name, (await contents(instance.dir + '/process.log')).split('\n').slice(-12).join('\n'));
  console.error(await contents(root + '/nginx-error.log'));
  throw error;
} finally {
  await browser?.close();
  for (const child of processes.reverse()) {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM');
      await new Promise(resolve => child.once('exit', resolve));
    }
  }
  for (const log of logs) await log.close();
  await rm(root, { recursive: true, force: true, maxRetries: 5 });
}
