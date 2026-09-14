// Docker: dbus-run-session -- node checks/semantic-elements.mjs; GTK 3 and PyQt6.
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
const exec = promisify(execFile);
import { mkdtemp, mkdir, open, readFile, writeFile, readdir, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createToken } from './token-fixture.mjs';
const accessibilityBus = async () => {
  const { stdout } = await exec('python3', ['-c', `import json
from gi.repository import Gio
session = Gio.bus_get_sync(Gio.BusType.SESSION, None)
address = session.call_sync('org.a11y.Bus', '/org/a11y/bus', 'org.a11y.Bus', 'GetAddress', None, None, 0, 1000, None).unpack()[0]
bus = Gio.DBusConnection.new_for_address_sync(address, Gio.DBusConnectionFlags.AUTHENTICATION_CLIENT | Gio.DBusConnectionFlags.MESSAGE_BUS_CONNECTION, None, None)
from gi.repository import GLib
pid = bus.call_sync('org.freedesktop.DBus', '/org/freedesktop/DBus', 'org.freedesktop.DBus', 'GetConnectionUnixProcessID', GLib.Variant('(s)', ('org.freedesktop.DBus',)), None, 0, 1000, None).unpack()[0]
print(json.dumps({'address': address, 'pid': pid}))`]);
  return JSON.parse(stdout);
};
let monitor;
const root = await mkdtemp('/tmp/elsewhere-semantic-');
await mkdir(root + '/runtime', { mode: 0o700 });
const log = await open(root + '/server.log', 'w');
const origin = 'http://127.0.0.1:18452';
const startupBus = await accessibilityBus();
const server = spawn(process.env.ELSEWHERE_BINARY || '/src/target/release/elsewhere',
  ['--no-audio', '--no-rtc', '--no-tls', '--elements', '--render-node', 'none', '--codecs', 'vp8', '--listen', '127.0.0.1:18452', '--screen-size', '800x600'],
  { cwd: root, env: { ...process.env, AT_SPI_BUS_ADDRESS: startupBus.address, HOME: root, SHELL: '/bin/bash', XDG_CONFIG_HOME: root + '/config', XDG_RUNTIME_DIR: root + '/runtime', QT_LINUX_ACCESSIBILITY_ALWAYS_ON: '1', GTK_A11Y: 'atspi' }, stdio: ['ignore', log.fd, log.fd] });
const browserStates = new Map();
const fixture = createServer(async (request, response) => {
  const kind = new URL(request.url, 'http://fixture').searchParams.get('kind');
  if (request.method === 'POST') {
    let body = ''; for await (const chunk of request) body += chunk;
    browserStates.set(kind, JSON.parse(body)); response.end('ok'); return;
  }
  response.setHeader('Content-Type', 'text/html');
  response.end(`<!doctype html><title>Semantic ${kind}</title>
    <button onclick="record({clicks: state.clicks + 1})">Commit</button>
    <label><input type="checkbox" onchange="record({checked: this.checked})">Subscribed</label>
    <input id="message" aria-label="Message" oninput="record({text: this.value})">
    <button disabled onclick="record({disabled_clicked: true})">Disabled</button>
    <button onclick="record({wrong: true})">Duplicate</button><button onclick="record({wrong: true})">Duplicate</button>
    <button id="later" disabled>Later</button><button onclick="setTimeout(() => later.disabled = false, 350)">Schedule</button>
    <script>let state = {clicks: 0, checked: false, text: ''}; function record(values) { Object.assign(state, values); fetch('/?kind=${kind}', {method: 'POST', body: JSON.stringify(state)}); } record({}); setInterval(() => { if (state.text !== document.getElementById('message').value) record({text: document.getElementById('message').value}); }, 50);</script>`);
});
await new Promise(resolve => fixture.listen(18453, '127.0.0.1', resolve));
let token;
const api = async (path, method = 'GET', body, auth = token) => {
  const response = await fetch(origin + path, { method, headers: { Authorization: 'Bearer ' + auth, 'Content-Type': 'application/json' }, ...(body !== undefined && { body: JSON.stringify(body) }) });
  return { status: response.status, body: await response.json().catch(() => null) };
};
const wait = async (label, fn) => { for (let i = 0; i < 100; i++) { if (await fn()) return; await new Promise(r => setTimeout(r, 100)); } throw Error(label + ' timed out'); };
try {
  await wait('server', async () => { try { return (await fetch(origin)).ok; } catch { return false; } });
  token = await createToken(root);
  assert.equal(await (await fetch(origin + '/skill/reference.md')).text(), await readFile('/src/skills/elsewhere/reference.md', 'utf8'));
  for (const kind of (process.env.SEMANTIC_TOOLKITS || 'gtk,qt,chromium,firefox').split(',')) {
    const stateFile = root + '/' + kind + '.json';
    let cmd = `QT_QPA_PLATFORM=xcb python3 /src/web/checks/semantic-elements-native.py ${kind} ${stateFile}`;
    if (kind === 'chromium') cmd = `chromium --no-sandbox --ozone-platform=wayland --force-renderer-accessibility --no-first-run --user-data-dir=${root}/chromium http://127.0.0.1:18453/?kind=chromium`;
    if (kind === 'firefox') {
      await mkdir(root + '/firefox');
      await writeFile(root + '/firefox/user.js', 'user_pref("accessibility.force_disabled", -1);\nuser_pref("browser.shell.checkDefaultBrowser", false);\nuser_pref("browser.startup.homepage_override.mstone", "ignore");\n');
      cmd = `MOZ_DISABLE_CONTENT_SANDBOX=1 firefox --no-remote --profile ${root}/firefox http://127.0.0.1:18453/?kind=firefox`;
    }
    assert.equal((await api('/api/control', 'POST', { op: 'spawn', cmd })).status, 202);
    let win;
    await wait(kind + ' window', async () => { win = (await api('/api/windows')).body.find(w => w.title.startsWith('Semantic ' + kind)); return win; });
    const path = `/api/windows/${win.id}/elements`;
    const ready = await api(path + '/wait', 'POST', { target: { role: 'button', name: 'Commit' }, condition: 'present', timeout_ms: 3000 });
    assert.equal(ready.body.matched, true, JSON.stringify(ready));
    let tree;
    await wait(kind + ' accessibility', async () => { tree = await api(path); return tree.body.elements?.some(e => e.name === 'Commit') && !tree.body.truncated; });
    assert.equal(tree.status, 200); assert.equal(tree.body.truncated, false);
    const element = name => { const found = tree.body.elements.find(e => e.name === name); assert(found, name); return found; };
    const invoke = e => api(path + '/action', 'POST', { target: { reference: e.reference }, action: e.actions[0] || commit.actions[0] });
    const state = async () => browserStates.get(kind) || JSON.parse(await readFile(stateFile, 'utf8'));
    const commit = element('Commit');
    assert.equal(commit.enabled, true); assert.equal(commit.checked, null); assert(commit.actions.length);
    const actionStarted = Date.now();
    const clicked = await invoke(commit);
    const actionMs = Date.now() - actionStarted; assert.equal(clicked.status, 200, JSON.stringify({clicked, commit}));
    await wait('native click', async () => (await state()).clicks === 1);
    assert.equal((await invoke(element('Subscribed'))).status, 200);
    await wait('native toggle', async () => (await state()).checked);
    const edited = await api(path + '/text', 'POST', { target: { reference: element('Message').reference }, text: 'Semantic 😀😀 ✓' });
    if (kind === 'chromium') { assert.equal(element('Message').editable, false); assert.equal(edited.body.code, 'unsupported'); assert.equal((await state()).text, ''); }
    else if (kind === 'firefox' && edited.body.code === 'uncertain') { assert.equal((await state()).text, ''); console.log('Firefox acknowledged text but did not apply it; readback returned uncertain'); }
    else { assert.equal(edited.status, 200, JSON.stringify({edited, target: element('Message')})); await wait('native text', async () => (await state()).text === 'Semantic 😀😀 ✓'); }
    if (kind === 'gtk' || kind === 'qt') {
      assert.equal((await invoke(element('Sticky'))).status, 200);
      await wait('native toggle button', async () => (await state()).sticky);
      const sticky = await api(path + '/wait', 'POST', { target: { reference: element('Sticky').reference }, condition: 'checked', timeout_ms: 1000 });
      assert.equal(sticky.body.matched, true, JSON.stringify(sticky));
      const secret = await api(path + '/text', 'POST', { target: { reference: element('Secret').reference }, text: 'fixture-secret' });
      assert.equal(secret.status, 200, JSON.stringify(secret));
      await wait('native masked text', async () => (await state()).secret === 'fixture-secret');
    }
    const message = element('Message');
    assert.equal((await api('/api/input', 'POST', { type: 'click', window: win.id, x: message.x + message.w / 2, y: message.y + message.h / 2 })).status, 202);
    const focused = await api(path + '/wait', 'POST', { target: { reference: message.reference }, condition: 'focused', timeout_ms: 1000 });
    assert.equal(focused.body.matched, true, JSON.stringify(focused));
    assert.equal((await invoke(element('Disabled'))).body.code, 'disabled');
    assert.equal((await api(path + '/action', 'POST', { target: { role: element('Duplicate').role, name: 'Duplicate' }, action: element('Duplicate').actions[0] })).body.code, 'ambiguous');
    assert.equal((await api(path + '/action', 'POST', { target: { reference: commit.reference }, action: 'nonexistent' })).body.code, 'unsupported');
    const pending = api(path + '/wait', 'POST', { target: { role: element('Later').role, name: 'Later' }, condition: 'enabled', timeout_ms: 3000 });
    assert.equal((await invoke(element('Schedule'))).status, 200);
    const result = await pending;
    assert.equal(result.status, 200, JSON.stringify(result)); assert.equal(result.body.matched, true); assert(result.body.attempts >= 2);
    const timeout = await api(path + '/wait', 'POST', { target: { role: 'push button', name: 'Missing' }, condition: 'present', timeout_ms: 250 });
    assert.equal(timeout.body.matched, false); assert.equal(timeout.body.last_error, null); assert(timeout.body.elapsed_ms >= 240 && timeout.body.elapsed_ms < 1000);
    const inapplicable = await api(path + '/wait', 'POST', { target: { reference: commit.reference }, condition: 'checked', timeout_ms: 150 });
    assert.equal(inapplicable.body.matched, false); assert.equal(inapplicable.body.last_error.code, 'state_unavailable');
    const checkedWait = await api(path + '/wait', 'POST', { target: { reference: element('Subscribed').reference }, condition: 'checked', timeout_ms: 1000 });
    assert.equal(checkedWait.body.matched, true);
    await api('/api/control', 'POST', { id: win.id, op: 'move', x: 20, y: 30 });
    assert.equal((await invoke(commit)).status, 200);
    await wait('reference after movement', async () => (await state()).clicks === 2);
    if (win.decoration > 0) {
      tree = await api(path);
      assert.equal((await invoke(element('Maximize'))).status, 200);
      await wait('semantic decoration maximize', async () => (await api('/api/windows')).body.find(w => w.id === win.id)?.maximized);
      tree = await api(path);
      assert.equal((await invoke(element('Restore'))).status, 200);
      await wait('semantic decoration restore', async () => !(await api('/api/windows')).body.find(w => w.id === win.id)?.maximized);
      tree = await api(path);
    }
    const snapshot = await fetch(origin + `/api/windows/${win.id}/snapshot.png`, { headers: { Authorization: 'Bearer ' + token } });
    assert.equal(snapshot.status, 200);
    await writeFile(root + '/' + kind + '.png', Buffer.from(await snapshot.arrayBuffer()));
    if (kind === 'gtk') {
      assert.equal((await invoke(element('Open menu'))).status, 200);
      await wait('native popup', async () => { const page = await api(path); const popup = page.body.elements?.find(e => e.name === 'Popup commit'); if (!popup) return false; tree = page; return true; });
      assert.equal((await invoke(element('Popup commit'))).status, 200);
      await wait('native popup action', async () => (await state()).popup);
      tree = await api(path);
      assert.equal((await invoke(element('Twin window'))).status, 200);
      let twin;
      await wait('same-process twin', async () => { twin = (await api('/api/windows')).body.find(w => w.title === win.title && w.id !== win.id); return twin; });
      assert.equal(twin.pid, win.pid);
      assert.equal((await api(path + '/action', 'POST', { target: { reference: commit.reference }, action: commit.actions[0] })).body.code, 'ambiguous_window');
      await api('/api/control', 'POST', { id: twin.id, op: 'close' });
      await wait('twin closed', async () => !(await api('/api/windows')).body.some(w => w.id === twin.id));
      tree = await api(path);
      const reader = (await api('/api/tokens', 'POST', { label: 'Semantic reader', permissions: ['desktop.view'] })).body;
      const writer = (await api('/api/tokens', 'POST', { label: 'Semantic writer', permissions: ['desktop.control'] })).body;
      assert.equal((await api(path + '/action', 'POST', { target: { reference: commit.reference }, action: commit.actions[0] }, reader.token)).status, 403);
      assert.equal((await api(path, 'GET', undefined, writer.token)).status, 403);
      assert.equal((await api(path + '/action', 'POST', { target: { reference: commit.reference }, action: commit.actions[0] }, writer.token)).status, 200);
      await wait('control-only semantic action', async () => (await state()).clicks === 3);
      const missing = { target: { role: 'button', name: 'Never present' }, condition: 'present', timeout_ms: 300000 };
      const holds = Array.from({ length: 48 }, () => api(path + '/wait', 'POST', missing, reader.token));
      const controller = new AbortController();
      const disconnected = fetch(origin + path + '/wait', { method: 'POST', headers: { Authorization: 'Bearer ' + reader.token, 'Content-Type': 'application/json' }, body: JSON.stringify(missing), signal: controller.signal }).catch(e => e.name);
      await new Promise(r => setTimeout(r, 200));
      assert.equal((await api(path)).status, 200);
      controller.abort(); await disconnected;
      assert.equal((await api(path + '/text', 'POST', { target: { reference: element('Message').reference }, text: 'Concurrent controller' }, writer.token)).status, 200);
      await wait('controller text during waits', async () => (await state()).text === 'Concurrent controller');
      assert.equal((await api('/api/tokens/' + reader.metadata.id, 'DELETE')).status, 204);
      assert((await Promise.all(holds)).every(r => r.status === 401));
      const another = (await api('/api/tokens', 'POST', { label: 'Semantic revocation', permissions: ['desktop.view'] })).body;
      const pending = api(path + '/wait', 'POST', missing, another.token);
      await new Promise(r => setTimeout(r, 200));
      const revokeStart = Date.now();
      assert.equal((await api('/api/tokens/' + another.metadata.id, 'DELETE')).status, 204);
      assert.equal((await pending).status, 401); assert(Date.now() - revokeStart < 1000);
      const expiring = (await api('/api/tokens', 'POST', { label: 'Semantic expiry', permissions: ['desktop.view'], expires_at_ms: Date.now() + 500 })).body;
      assert.equal((await api(path + '/wait', 'POST', missing, expiring.token)).status, 401);
      assert.equal((await api(path + '/wait', 'POST', { ...missing, timeout_ms: 300001 })).status, 400);
      const heldKey = (await api('/api/tokens', 'POST', { label: 'Semantic MCP', permissions: ['desktop.view'] })).body;
      const mcp = (method, params, id, session, auth = token) => fetch(origin + '/mcp', { method: 'POST', headers: { Authorization: 'Bearer ' + auth, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...(session && { 'Mcp-Session-Id': session }) }, body: JSON.stringify({ jsonrpc: '2.0', ...(id !== undefined && { id }), method, params }) });
      const init = await mcp('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'semantic-check', version: '1' } }, 1);
      const session = init.headers.get('mcp-session-id'); assert(session); await init.text();
      await (await mcp('notifications/initialized', {}, undefined, session)).text();
      const read = await mcp('tools/call', { name: 'elements', arguments: { window: win.id } }, 2, session);
      assert.match(await read.text(), /Commit/);
      const toolResult = async response => {
        const body = await response.text();
        const data = body.split('\n').find(line => line.startsWith('data:') && line.slice(5).trim());
        const packet = JSON.parse(data ? data.slice(5) : body);
        assert(packet.result && !packet.result.isError, body);
        return packet.result;
      };
      await toolResult(await mcp('tools/call', { name: 'element_action', arguments: { window: win.id, target: { reference: element('Subscribed').reference }, action: element('Subscribed').actions[0] } }, 4, session));
      await wait('MCP native checkbox action', async () => (await state()).checked === false);
      await toolResult(await mcp('tools/call', { name: 'element_text', arguments: { window: win.id, target: { reference: element('Message').reference }, text: 'MCP ✓' } }, 5, session));
      await wait('MCP native text action', async () => (await state()).text === 'MCP ✓');
      const limitedSession = async auth => {
        const response = await mcp('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'semantic-grants', version: '1' } }, 1, null, auth);
        const id = response.headers.get('mcp-session-id'); assert(id); await response.text();
        await (await mcp('notifications/initialized', {}, undefined, id, auth)).text(); return id;
      };
      const viewSession = await limitedSession(heldKey.token);
      const denied = await mcp('tools/call', { name: 'element_action', arguments: { window: win.id, target: { reference: element('Subscribed').reference }, action: element('Subscribed').actions[0] } }, 2, viewSession, heldKey.token);
      assert.match(await denied.text(), /permission denied/);
      const controlSession = await limitedSession(writer.token);
      await toolResult(await mcp('tools/call', { name: 'element_text', arguments: { window: win.id, target: { reference: element('Message').reference }, text: 'Control-only MCP' } }, 2, controlSession, writer.token));
      await wait('MCP control-only text action', async () => (await state()).text === 'Control-only MCP');
      assert.equal((await state()).checked, false, 'denied MCP action cannot toggle the control');
      const held = Array.from({ length: 48 }, () => api(path + '/wait', 'POST', missing, heldKey.token));
      const cancelled = mcp('tools/call', { name: 'element_wait', arguments: { window: win.id, ...missing } }, 3, session).then(r => r.text());
      await new Promise(r => setTimeout(r, 200));
      assert.equal((await api(path)).status, 200);
      assert.equal((await mcp('notifications/cancelled', { requestId: 3, reason: 'fixture cancellation' }, undefined, session)).status, 202);
      await Promise.race([cancelled, new Promise((_, reject) => setTimeout(() => reject(new Error('MCP cancellation did not finish promptly')), 1000))]);
      assert.equal((await api(path)).status, 200);
      await api('/api/tokens/' + heldKey.metadata.id, 'DELETE');
      assert((await Promise.all(held)).every(r => r.status === 401));
      console.log('49 concurrent long waits, controller read/text, HTTP disconnect and MCP cancellation passed');
      const peerState = root + '/peer.json';
      await api('/api/control', 'POST', { op: 'spawn', cmd: `python3 /src/web/checks/semantic-elements-native.py gtk ${peerState}` });
      let peer;
      await wait('independent application window', async () => { peer = (await api('/api/windows')).body.find(w => w.title === win.title && w.pid !== win.pid); return peer; });
      const peerPath = `/api/windows/${peer.id}/elements`;
      await wait('independent accessibility tree', async () => (await api(peerPath)).body.elements?.some(e => e.name === 'Commit'));
      const peerMessage = (await api(peerPath)).body.elements.find(e => e.name === 'Message');
      process.kill(win.pid, 'SIGSTOP');
      try {
        const stalledWaits = Array.from({ length: 32 }, () => api(path + '/wait', 'POST', { ...missing, timeout_ms: 1000 }));
        const stalledActions = Array.from({ length: 4 }, () => api(path + '/action', 'POST', { target: { reference: commit.reference }, action: commit.actions[0] }, writer.token));
        await new Promise(r => setTimeout(r, 300));
        const healthyStarted = Date.now();
        const peerWaits = Array.from({ length: 16 }, () => api(peerPath + '/wait', 'POST', { target: { role: 'button', name: 'Commit' }, condition: 'present', timeout_ms: 3000 }));
        assert.equal((await api(peerPath + '/text', 'POST', { target: { reference: peerMessage.reference }, text: 'Independent window' })).status, 200);
        assert(Date.now() - healthyStarted < 1500, 'healthy mutation must not wait for stalled mutation scans');
        assert((await Promise.all(peerWaits)).every(r => r.body.matched), 'healthy window progresses while another application is stalled');
        assert((await Promise.all(stalledWaits)).every(r => !r.body.matched && r.body.last_error?.code === 'tree_timeout'));
        const stalled = await api(path + '/wait', 'POST', { ...missing, timeout_ms: 300 });
        assert.equal(stalled.body.matched, false); assert.equal(stalled.body.last_error.code, 'tree_timeout');
        const blockedAction = api(path + '/action', 'POST', { target: { reference: commit.reference }, action: commit.actions[0] }, writer.token);
        await new Promise(r => setTimeout(r, 100));
        assert.equal((await api('/api/tokens/' + writer.metadata.id, 'DELETE')).status, 204);
        assert.equal((await blockedAction).status, 401);
        assert((await Promise.all(stalledActions)).every(r => r.status === 401));
      } finally { process.kill(win.pid, 'SIGCONT'); }
      await new Promise(r => setTimeout(r, 200));
      assert.equal((await state()).clicks, 3);
      assert.equal((await api(`/api/windows/${win.id}/snapshot.png`)).status, 200);
      await api('/api/control', 'POST', { id: peer.id, op: 'close' });
      console.log('independent windows, unresponsive accessibility deadline, pre-dispatch revocation and native snapshot passed');
      const fixtureWindow = async behavior => {
        const file = root + '/' + behavior + '.json';
        await api('/api/control', 'POST', { op: 'spawn', cmd: `python3 /src/web/checks/semantic-elements-native.py gtk ${file} ${behavior}` });
        let window;
        await wait(behavior + ' fixture window', async () => { window = (await api('/api/windows')).body.find(w => w.title === 'Semantic gtk ' + behavior); return window; });
        const path = `/api/windows/${window.id}/elements`;
        let tree;
        await wait(behavior + ' fixture tree', async () => { tree = await api(path); return tree.body.elements?.some(e => e.name === 'Message'); });
        return { window, path, tree, file };
      };
      const slow = await fixtureWindow('slow'), healthy = await fixtureWindow('healthy');
      const slowToken = (await api('/api/tokens', 'POST', { label: 'Slow application', permissions: ['desktop.control'] })).body;
      const slowEntry = slow.tree.body.elements.find(e => e.name === 'Message');
      const heldEdits = Array.from({ length: 4 }, (_, i) => api(slow.path + '/text', 'POST', { target: { reference: slowEntry.reference }, text: 'slow ' + i }, slowToken.token));
      await new Promise(r => setTimeout(r, 600));
      const exactTarget = healthy.tree.body.elements.find(e => e.name === 'Commit');
      const began = performance.now();
      const exactAction = api(healthy.path + '/action', 'POST', { target: { role: exactTarget.role, name: exactTarget.name }, action: exactTarget.actions[0] }).then(result => ({ result, elapsed: performance.now() - began }));
      const healthyEdit = await api(path + '/text', 'POST', { target: { reference: element('Message').reference }, text: 'Healthy during dispatch' });
      assert.equal(healthyEdit.status, 200);
      assert(performance.now() - began < 1000, 'a slow application must not occupy every mutation slot');
      const actionResult = await exactAction;
      assert.equal(actionResult.result.status, 200);
      assert(actionResult.elapsed < 1000, 'a slow application must not delay healthy actions');
      await api('/api/tokens/' + slowToken.metadata.id, 'DELETE');
      const edits = await Promise.all(heldEdits);
      assert(edits.filter(r => r.status === 401).length >= 2, JSON.stringify(edits));
      assert.equal(JSON.parse(await readFile(healthy.file, 'utf8')).wrong, undefined);
      for (const fixture of [slow, healthy]) await api('/api/control', 'POST', { id: fixture.window.id, op: 'close' });
      console.log('slow dispatch isolation passed', Math.round(actionResult.elapsed), 'ms');
      const deferred = await fixtureWindow('deferred');
      const deferredEntry = deferred.tree.body.elements.find(e => e.name === 'Message');
      const deferredCommit = deferred.tree.body.elements.find(e => e.name === 'Commit');
      const pendingEdit = api(deferred.path + '/text', 'POST', { target: { reference: deferredEntry.reference }, text: 'deferred update' });
      await wait('deferred text readback', async () => JSON.parse(await readFile(deferred.file, 'utf8')).waiting);
      const pendingAction = api(deferred.path + '/action', 'POST', { target: { role: deferredCommit.role, name: deferredCommit.name }, action: deferredCommit.actions[0] });
      assert.equal((await pendingEdit).status, 200);
      assert.equal((await pendingAction).body.code, 'ambiguous', 'queued selection must see the duplicate created before admission');
      const deferredState = JSON.parse(await readFile(deferred.file, 'utf8'));
      assert.equal(deferredState.clicks, 0);
      assert.equal(deferredState.wrong, undefined);
      await api('/api/control', 'POST', { id: deferred.window.id, op: 'close' });
      console.log('same-application queued selection observes post-admission tree');
      const idleTimings = [];
      for (let i = 0; i < 7; i++) { const start = performance.now(); assert.equal((await api(path)).status, 200); idleTimings.push(performance.now() - start); }
      idleTimings.sort((a, b) => a - b);
      assert(idleTimings[3] < 80, 'idle reads must not wait for a 100 ms scheduling tick: ' + idleTimings);
      console.log('idle read median', Math.round(idleTimings[3]), 'ms');
      const resources = async () => {
        const status = await readFile(`/proc/${server.pid}/status`, 'utf8');
        return { fds: (await readdir(`/proc/${server.pid}/fd`)).length, threads: Number(status.match(/^Threads:\s+(\d+)/m)[1]), rssKiB: Number(status.match(/^VmRSS:\s+(\d+)/m)[1]) };
      };
      const bus = await accessibilityBus();
      monitor = spawn('dbus-monitor', ['--address', bus.address, "type='method_call'"], { stdio: ['ignore', 'pipe', 'ignore'] });
      let calls = 0, partial = '';
      monitor.stdout.on('data', chunk => { const lines = (partial + chunk).split('\n'); partial = lines.pop(); calls += lines.filter(line => line.startsWith('method call ')).length; });
      await new Promise(r => setTimeout(r, 100));
      const measure = async (count, target) => {
        await new Promise(r => setTimeout(r, 200));
        calls = 0;
        const results = await Promise.all(Array.from({ length: count }, () => api(path + '/wait', 'POST', { target, condition: 'enabled', timeout_ms: 1200 })));
        assert(results.every(r => r.status === 200 && !r.body.matched));
        await new Promise(r => setTimeout(r, 100));
        return { calls, attempts: results.reduce((sum, r) => sum + r.body.attempts, 0) };
      };
      for (const target of [missing.target, { reference: element('Disabled').reference }]) {
        const single = await measure(1, target);
        const shared = await measure(48, target);
        assert(single.calls > 0);
        assert(shared.attempts > single.attempts * 20, JSON.stringify({single, shared}));
        assert(shared.calls < single.calls * 3, 'concurrent waits share expensive observations: ' + JSON.stringify({single, shared}));
        console.log('shared observation calls', target, {single, shared});
      }
      const quiet = async () => {
        await new Promise(r => setTimeout(r, 400));
        calls = 0;
        await new Promise(r => setTimeout(r, 400));
        assert.equal(calls, 0, 'cancelled request must stop server-side accessibility polling');
      };
      const loneController = new AbortController();
      calls = 0;
      const lone = fetch(origin + path + '/wait', { method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body: JSON.stringify(missing), signal: loneController.signal }).catch(e => e.name);
      await wait('HTTP polling started', async () => calls > 0);
      loneController.abort(); await lone;
      await quiet();
      const loneMcp = mcp('tools/call', { name: 'element_wait', arguments: { window: win.id, ...missing } }, 90, session).then(r => r.text());
      await wait('MCP polling started', async () => calls > 0);
      assert.equal((await mcp('notifications/cancelled', { requestId: 90 }, undefined, session)).status, 202);
      await Promise.race([loneMcp, new Promise((_, reject) => setTimeout(() => reject(new Error('MCP cancellation did not finish promptly')), 1000))]);
      await quiet();
      console.log('HTTP disconnect and MCP cancellation stop polling with token still live');
      calls = 0;
      const cpu = async pid => { const fields = (await readFile(`/proc/${pid}/stat`, 'utf8')).split(') ')[1].split(' '); return Number(fields[11]) + Number(fields[12]); };
      const ticks = Number((await exec('getconf', ['CLK_TCK'])).stdout.trim());
      const initialCpu = await cpu(server.pid), initialBusCpu = await cpu(bus.pid), started = Date.now();
      const samples = [];
      let reads = 0;
      for (let batch = 0; batch < 3; batch++) {
        for (let i = 0; i < 10; i++) { const r = await api(path + '/wait', 'POST', { ...missing, timeout_ms: 150 }); assert.equal(r.body.matched, false); reads += r.body.attempts; }
        samples.push(await resources());
      }
      assert(samples.at(-1).fds <= samples[0].fds + 2);
      assert(samples.at(-1).threads <= samples[0].threads + 2);
      assert(samples.at(-1).rssKiB <= samples[0].rssKiB + 16384);
      assert(calls > reads, 'D-Bus monitor captured real method calls');
      console.log('30 bounded waits', reads, 'wait attempts;', calls, 'D-Bus calls;', Date.now() - started, 'ms;', (await cpu(server.pid) - initialCpu) / ticks, 'server CPU sec;', (await cpu(bus.pid) - initialBusCpu) / ticks, 'bus CPU sec; resource samples', samples);
      monitor.kill('SIGTERM'); await new Promise(r => monitor.once('exit', r)); monitor = null;
      assert.equal((await invoke(element('Replace commit'))).status, 200);
      await wait('stale object reference', async () => (await invoke(commit)).body?.code === 'stale');
      tree = await api(path);
      const liveCommit = element('Commit');
      assert.equal((await invoke(element('Large tree'))).status, 200);
      await wait('truncated native tree', async () => (await api(path)).body.truncated);
      assert.equal((await api(path + '/action', 'POST', { target: { role: liveCommit.role, name: liveCommit.name }, action: liveCommit.actions[0] })).body.code, 'incomplete_tree');
      for (let i = 0; i < 9; i++) assert.equal((await api(path)).status, 200);
      assert.equal((await invoke(liveCommit)).status, 200);
      await wait('reference beyond truncated prefix', async () => (await state()).clicks === 4);
      console.log('destroyed target rejected; reference beyond truncated prefix works after nine large reads');
      console.log('permission separation, control-only action, wait revocation and expiry passed');
    }
    assert.equal((await state()).wrong, undefined); assert.equal((await state()).disabled_clicked, undefined);
    console.log(kind, kind === 'chromium' ? 'native actions and explicit unsupported text' : kind === 'firefox' ? 'native actions and verified text outcome' : 'native actions and text replacement', 'checked state, disabled/ambiguous/unsupported rejection and bounded wait passed', result.body.elapsed_ms, 'ms', result.body.attempts, 'reads; action', actionMs, 'ms');
    await api('/api/control', 'POST', { id: win.id, op: 'close' });
    if (kind === 'gtk') {
      await wait('application closed', async () => !(await api('/api/windows')).body.some(w => w.id === win.id));
      await api('/api/control', 'POST', { op: 'spawn', cmd });
      let restarted;
      await wait('application restarted', async () => { restarted = (await api('/api/windows')).body.find(w => w.title === win.title); return restarted; });
      assert.notEqual(restarted.pid, win.pid);
      assert.equal((await api(`/api/windows/${restarted.id}/elements/action`, 'POST', { target: { reference: commit.reference }, action: commit.actions[0] })).body.code, 'stale');
      await api('/api/control', 'POST', { id: restarted.id, op: 'close' });
    }
  }
  await api('/api/control', 'POST', { op: 'spawn', cmd: 'foot --title=Semantic-unsupported sleep 60' });
  let unsupported;
  await wait('unsupported application', async () => { unsupported = (await api('/api/windows')).body.find(w => w.title === 'Semantic-unsupported'); return unsupported; });
  const unsupportedPath = `/api/windows/${unsupported.id}/elements`;
  const absent = { target: { role: 'button', name: 'Never present' }, action: 'click' };
  assert.equal((await api(unsupportedPath + '/action', 'POST', absent)).body.code, 'unsupported');
  const bus = await accessibilityBus();
  process.kill(bus.pid, 'SIGTERM');
  await wait('bus transport interruption', async () => (await api(unsupportedPath + '/action', 'POST', absent)).body?.code === 'bus_unavailable');
  const interrupted = await api(unsupportedPath + '/wait', 'POST', { target: absent.target, condition: 'present', timeout_ms: 300 });
  assert.equal(interrupted.body.matched, false); assert.equal(interrupted.body.last_error.code, 'bus_unavailable');
  assert.equal((await api(unsupportedPath + '/action', 'POST', { target: { role: 'push button', name: 'Maximize' }, action: 'activate' })).status, 200);
  await wait('decoration without bus', async () => (await api('/api/windows')).body.find(w => w.id === unsupported.id)?.maximized);
  await api('/api/control', 'POST', { id: unsupported.id, op: 'close' });
  console.log('unsupported application, interrupted bus and compositor decoration remain distinguishable');
} catch (error) { console.error(error); console.error(await api('/api/windows').catch(() => null)); console.error((await readFile(root + '/server.log', 'utf8')).split('\n').slice(-10).join('\n')); throw error; }
finally {
  if (monitor && monitor.exitCode === null) { monitor.kill('SIGTERM'); await new Promise(r => monitor.once('exit', r)); }
  if (server.exitCode === null) { server.kill('SIGTERM'); await new Promise(r => server.once('exit', r)); }
  fixture.closeAllConnections(); await new Promise(resolve => fixture.close(resolve));
  await log.close();
  if (!process.env.KEEP_FIXTURE) await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); else console.log(root);
}
