import { createToken } from './token-fixture.mjs';
// Docker rig: release binary, GTK 3, Python GObject bindings and Chromium. No GPU required.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp, mkdir, open, readFile, writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {setTimeout as sleep} from 'node:timers/promises';
import {AUTH, HELLO, ROLE, NOTICE, FILE_RESULT, DRAG, TOUCH, POINTER_LOCK, POINTER_LOCK_LOST} from '../src/protocol.js';

const root = await mkdtemp('/tmp/elsewhere-drag-');
await mkdir(root + '/runtime', {mode: 0o700});
const log = await open(root + '/server.log', 'w');
const origin = 'http://127.0.0.1:8099';
const desktop = spawn(process.env.ELSEWHERE_BINARY || '/src/target/release/elsewhere', [
  '--no-audio', '--no-rtc', '--no-tls', '--render-node', 'none', '--codecs', 'vp8',
  '--listen', '127.0.0.1:8099', '--socket-name', 'wayland-drag-check',
], {env: {...process.env, HOME: root, XDG_CONFIG_HOME: root + '/config', XDG_RUNTIME_DIR: root + '/runtime'},
  stdio: ['ignore', log.fd, log.fd], detached: true});
const exited = new Promise(resolve => desktop.once('exit', resolve));
let token, socket;
const packets = [];
const wait = async (fn, description, ms = 6000) => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const result = await fn();
    if (result) return result;
    await sleep(30);
  }
  throw Error('Timed out: ' + description);
};
const records = async name => {
  try { return (await readFile(`${root}/${name}.jsonl`, 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse); }
  catch (e) { if (e.code === 'ENOENT') return []; throw e; }
};
const api = async (path, body) => {
  const response = await fetch(origin + '/api/' + path, {method: body ? 'POST' : 'GET',
    headers: {Authorization: 'Bearer ' + token, 'Content-Type': 'application/json'}, body: body && JSON.stringify(body)});
  assert(response.ok, path + ': ' + await response.clone().text());
  const text = await response.text();
  return text ? JSON.parse(text) : null;
};
const input = body => api('input', body);
const move = (x, y) => input({type: 'move', x, y});
const button = pressed => input({type: 'button', button: 'left', pressed});
const json = (type, value) => socket.send(Buffer.concat([Buffer.from([type]), Buffer.from(JSON.stringify(value))]));
const quote = s => "'" + s.replaceAll("'", "'\\''") + "'";
const touch = (kind, x, y) => {
  const packet = Buffer.alloc(11); packet[0] = TOUCH; packet[1] = kind; packet[2] = 1;
  packet.writeFloatLE(x, 3); packet.writeFloatLE(y, 7); socket.send(packet);
};
try {
  await wait(async () => {
    try { return (await fetch(origin)).ok; }
    catch { return false; }
  }, 'server startup');
  token = await createToken(root);
  socket = new WebSocket(origin.replace('http', 'ws') + '/ws');
  socket.binaryType = 'arraybuffer';
  socket.addEventListener('message', ({data}) => packets.push(Buffer.from(data)));
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
  socket.send(Buffer.concat([Buffer.from([AUTH]), Buffer.from(token)]));
  socket.send(Buffer.from([HELLO, ...new TextEncoder().encode(JSON.stringify({ codecs: ["vp8"], quality: "very-low" }))]));
  await wait(() => packets.some(p => p[0] === ROLE && p[1] === 2), 'controller');
  const fixture = fileURLToPath(new URL('../../crates/elsewhere-compositor/checks/drag-client.py', import.meta.url));
  const windows = {};
  for (const [name, backend, x, y] of [
    ['x-source', 'x11', 20, 70], ['x-target', 'x11', 380, 70],
    ['w-source', 'wayland', 20, 340], ['w-target', 'wayland', 380, 340],
  ]) {
    await writeFile(`${root}/${name}.mode`, 'accept');
    await api('control', {op: 'spawn', cmd: ['env', 'GDK_BACKEND=' + backend, 'python3', fixture, name, root].map(quote).join(' ')});
    const w = await wait(async () => (await api('windows')).find(w => w.title === name), name);
    assert.equal(w.x11, backend === 'x11');
    await api('control', {id: w.id, op: 'move', x, y});
    windows[name] = {...w, x, y};
  }
  await sleep(300);
  const point = name => [windows[name].x + 100, windows[name].y + 90];
  let sequence = 0;
  const native = async (source, target, via = []) => {
    const payload = `file:///tmp/drag-${++sequence}.txt\r\n`;
    await writeFile(root + '/payload', payload);
    const count = (await records(target)).filter(r => r.kind === 'received').length;
    const begins = (await records(source)).filter(r => r.kind === 'begin').length;
    const [x, y] = point(source);
    await move(x, y); await sleep(100); await button(true); await sleep(100); await move(x + 30, y); await sleep(150);
    await wait(async () => (await records(source)).filter(r => r.kind === 'begin').length > begins, source + ' begins drag');
    for (const name of [...via, target]) {
      const [tx, ty] = point(name);
      for (let i = 0; i < 6; i++) { await move(tx + i, ty); await sleep(100); }
    }
    await button(false);
    const data = await wait(async () => (await records(target)).filter(r => r.kind === 'received')[count], `${source} -> ${target}`);
    assert.equal(data.data, payload);
    console.log(`${source} -> ${target}${via.length ? ' via ' + via.join(', ') : ''}: exact payload`);
    await sleep(150);
  };
  await native('x-source', 'x-target');
  await native('w-source', 'w-target');
  await native('w-source', 'x-target');
  await native('x-source', 'w-target');
  await native('x-source', 'x-target', ['x-target', 'w-target']);

  await api('control', {op: 'spawn', cmd: 'foot --title=HiddenDropFocus sleep 1000'});
  const hidden = await wait(async () => (await api('windows')).find(w => w.title === 'HiddenDropFocus'), 'hidden input fixture');
  await api('control', {op: 'movetoworkspace', id: hidden.id, workspace: 2});
  await wait(async () => (await api('windows')).find(w => w.id === hidden.id)?.workspace === 2, 'hidden input workspace');

  const browserDrop = async (target, mode = 'accept', cancel = false) => {
    await writeFile(`${root}/${target}.mode`, mode);
    const count = (await records(target)).filter(r => r.kind === 'received').length;
    const batch = 'drag' + ++sequence;
    const payload = 'browser payload ' + sequence;
    const start = packets.length;
    // Refusal follows an accepting Wayland target in the same drag.
    await move(...point(mode === 'refuse' ? 'w-target' : target));
    await api('control', {op: 'focus', id: hidden.id});
    await wait(async () => (await api('windows')).find(w => w.id === hidden.id)?.focused, 'hidden focus before desktop drop');
    json(DRAG, {op: 'start'}); await sleep(200);
    if (mode === 'refuse') { await move(...point(target)); await sleep(200); }
    const response = await fetch(`${origin}/api/drop/${batch}/sample.txt`, {method: 'PUT', headers: {Authorization: 'Bearer ' + token}, body: payload});
    assert(response.ok);
    json(DRAG, {op: 'drop', batch, names: ['sample.txt']});
    if (cancel) { await sleep(100); json(DRAG, {op: 'cancel', batch}); }
    if (mode === 'refuse' || cancel) {
      await wait(() => packets.slice(start).some(p => p[0] === FILE_RESULT && p.subarray(1).toString().includes(batch)), 'fallback result');
      await sleep(300);
      assert.equal((await records(target)).filter(r => r.kind === 'received').length, count);
      assert(!packets.slice(start).some(p => p[0] === NOTICE && p.subarray(1).toString().includes('Copied to')));
    } else {
      const record = await wait(async () => (await records(target)).filter(r => r.kind === 'received')[count], 'browser payload');
      const uri = record.data.trim().split(/\r?\n/)[0];
      assert.equal(await readFile(fileURLToPath(uri), 'utf8'), payload);
      await wait(() => packets.slice(start).some(p => p[0] === NOTICE && p.subarray(1).toString().includes('Copied to')), 'accepted notice');
      assert(!packets.slice(start).some(p => p[0] === FILE_RESULT && p.subarray(1).toString().includes(batch)));
    }
    console.log(`browser -> ${target} ${cancel ? 'cancel' : mode}: delivery and outcome agree`);
    await writeFile(`${root}/${target}.mode`, 'accept');
  };
  await browserDrop('w-target');
  await browserDrop('x-target');
  await browserDrop('x-target', 'refuse');
  await browserDrop('x-target', 'delay');
  await browserDrop('x-target', 'accept', true);

  // Normal pointer and touch input still reaches both backends after their drag grabs end.
  for (const name of ['x-target', 'w-target']) {
    const n = (await records(name)).filter(r => r.kind === 'press').length;
    await move(...point(name)); await button(true); await button(false);
    await wait(async () => (await records(name)).filter(r => r.kind === 'press').length > n, name + ' click after drag');
    const touches = (await records(name)).filter(r => r.kind === 'touch').length;
    touch(0, ...point(name)); await sleep(100); touch(2, ...point(name));
    await wait(async () => (await records(name)).filter(r => r.kind === 'touch').length >= touches + 2, name + ' touch delivery');
    assert.deepEqual((await records(name)).filter(r => r.kind === 'touch').slice(touches).map(r => r.event), ['touch-begin', 'touch-end']);
    console.log(name + ': pointer and touch delivery');
  }
  // Client-requested grabs preserve the originating surface and serial on both backends.
  for (const name of ['x-source', 'w-source']) {
    const current = async () => (await api('windows')).find(w => w.id === windows[name].id);
    for (const mode of ['move', 'resize']) {
      const before = await current();
      await writeFile(`${root}/${name}.mode`, mode);
      await move(before.x + 100, before.y + 90); await sleep(100); await button(true); await sleep(150);
      await move(before.x + 140, before.y + 110); await sleep(150); await button(false);
      await wait(async () => {
        const after = await current();
        return mode === 'move' ? after.x === before.x + 40 && after.y === before.y + 20
          : after.w === before.w + 40 && after.h === before.h + 20;
      }, name + ' client ' + mode);
    }
    await writeFile(`${root}/${name}.mode`, 'accept');
    const before = await current();
    assert(before.decoration > 0);
    touch(0, before.x + 40, before.y - 16); await sleep(100);
    touch(1, before.x + 70, before.y - 1); await sleep(100);
    touch(2, before.x + 70, before.y - 1);
    await wait(async () => { const w = await current(); return w.x === before.x + 30 && w.y === before.y + 15; }, name + ' touch title-bar move');
    console.log(name + ': client move/resize and touch title-bar move');
  }
  await input({type: 'click', button: 'right', x: 100, y: 90, window: windows['w-target'].id});
  await wait(async () => (await api('windows')).find(w => w.id === windows['w-target'].id).popups.length, 'Wayland popup grab');
  touch(0, ...point('x-target')); await sleep(100); touch(2, ...point('x-target'));
  await wait(async () => !(await api('windows')).find(w => w.id === windows['w-target'].id).popups.length, 'outside touch dismisses popup');
  console.log('Wayland popup dismissed by touch on X11');
  await writeFile(root + '/lock.html', '<title>Pointer Lock check</title><button style="width:100%;height:200px" onclick="document.body.requestPointerLock()">Lock pointer</button>');
  await api('control', {op: 'spawn', cmd: ['chromium', '--no-sandbox', '--ozone-platform=wayland', '--no-first-run', '--user-data-dir=' + root + '/chromium', '--app=file://' + root + '/lock.html'].map(quote).join(' ')});
  const lockWindow = await wait(async () => (await api('windows')).find(w => w.title === 'Pointer Lock check'), 'pointer-lock client');
  await sleep(500); // Chromium maps its window before the page is ready for input.
  const start = packets.length;
  await input({type: 'click', x: 80, y: 100, window: lockWindow.id});
  await wait(() => packets.slice(start).some(p => p[0] === POINTER_LOCK && p[1] === 1), 'client pointer lock');
  const releaseStart = packets.length;
  socket.send(Buffer.from([POINTER_LOCK_LOST]));
  await wait(() => packets.slice(releaseStart).some(p => p[0] === POINTER_LOCK && p[1] === 0), 'browser releases client pointer lock');
  console.log('client pointer lock activates and releases');
  // Workspace changes cancel native input even when the grabbed window lost keyboard focus.
  const workspace = async n => {
    await api('control', {op: 'switchworkspace', workspace: n});
    await wait(async () => (await api('workspaces')).active === n, 'workspace ' + n);
  };
  for (const name of ['x-source', 'w-source']) {
    const id = windows[name].id;
    const current = async () => (await api('windows')).find(w => w.id === id);
    for (const mode of ['move', 'resize']) {
      await api('control', {id, op: 'activate'});
      await writeFile(`${root}/${name}.mode`, mode);
      const before = await current();
      await move(before.x + 100, before.y + 90); await sleep(80); await button(true); await sleep(120);
      await move(before.x + 140, before.y + 110);
      await wait(async () => { const w = await current(); return mode === 'move' ? w.x !== before.x : w.w !== before.w; }, 'live ' + mode);
      if (mode === 'move') {
        await api('control', {id: windows['w-target'].id, op: 'focus'});
        await api('control', {id, op: 'movetoworkspace', workspace: 2});
        await wait(async () => (await current()).workspace === 2, 'unfocused grabbed root move');
      } else await workspace(2);
      await sleep(100); const hidden = await current();
      await move(before.x + 230, before.y + 200); await button(false); await sleep(150);
      const after = await current();
      assert.deepEqual([after.x, after.y, after.w, after.h], [hidden.x, hidden.y, hidden.w, hidden.h], name + ' hidden grab is cancelled');
      await api('control', {id, op: 'movetoworkspace', workspace: 1}); await workspace(1);
    }
    await writeFile(`${root}/${name}.mode`, 'accept');
    await api('control', {id, op: 'activate'});
    const before = await current();
    touch(0, before.x + 40, before.y - 16); await sleep(80);
    touch(1, before.x + 60, before.y - 6); await sleep(100);
    await workspace(2); const hidden = await current();
    touch(1, before.x + 150, before.y + 100); touch(2, before.x + 150, before.y + 100); await sleep(100);
    const after = await current(); assert.deepEqual([after.x, after.y], [hidden.x, hidden.y], 'touch grab ends on switch');
    await workspace(1);
  }
  await api('control', {op: 'spawn', cmd: `GDK_BACKEND=wayland python3 /src/web/checks/workspace-native.py ${quote(root + '/hidden')} HiddenDialogOwner`});
  const hiddenOwner = await wait(async () => (await api('windows')).find(w => w.title === 'HiddenDialogOwner' && w.w > 0), 'hidden dialog owner');
  await api('control', {id: hiddenOwner.id, op: 'movetoworkspace', workspace: 2});
  await api('control', {id: windows['w-target'].id, op: 'activate'});
  await input({type: 'click', button: 'right', x: 100, y: 90, window: windows['w-target'].id});
  await wait(async () => (await api('windows')).find(w => w.id === windows['w-target'].id).popups.length, 'workspace popup');
  await writeFile(root + '/hidden.command', 'dialog');
  await wait(async () => (await api('windows')).find(w => w.title === 'HiddenDialogOwner Dialog' && w.workspace === 2), 'dialog mapped behind visible popup');
  await sleep(200);
  assert((await api('windows')).find(w => w.id === windows['w-target'].id).popups.length, 'hidden dialog preserves unrelated popup grab');

  await workspace(2);
  await wait(async () => !(await api('windows')).find(w => w.id === windows['w-target'].id).popups.length, 'switch dismisses popup');
  await workspace(1);

  // A native drag over an accepting target must cancel, not drop, when switching.
  const source = 'w-target', target = 'x-target';
  await api('control', {id: windows[source].id, op: 'activate'});
  const receivedBefore = (await records(target)).filter(r => r.kind === 'received').length;
  const beginBefore = (await records(source)).filter(r => r.kind === 'begin').length;
  const [sx, sy] = point(source);
  await move(sx, sy); await button(true); await sleep(100); await move(sx + 35, sy);
  await wait(async () => (await records(source)).filter(r => r.kind === 'begin').length > beginBefore, 'workspace drag starts');
  for (let i = 0; i < 4; i++) { await move(...point(target)); await sleep(100); }
  await workspace(2); await button(false); await sleep(250);
  assert.equal((await records(target)).filter(r => r.kind === 'received').length, receivedBefore, 'switch cannot commit native drag');
  await workspace(1);
  await api('control', {id: lockWindow.id, op: 'activate'});
  const relock = packets.length;
  await input({type: 'click', x: 80, y: 100, window: lockWindow.id});
  await wait(() => packets.slice(relock).some(p => p[0] === POINTER_LOCK && p[1] === 1), 'lock before inactive move');
  await api('control', {id: windows['w-target'].id, op: 'focus'});
  const unlock = packets.length;
  await api('control', {id: lockWindow.id, op: 'movetoworkspace', workspace: 2});
  await wait(() => packets.slice(unlock).some(p => p[0] === POINTER_LOCK && p[1] === 0), 'unfocused hidden lock released');
  assert.equal((await api('workspaces')).active, 1);
  console.log('Workspace switch/move ends native pointer, touch, popup, drag-and-drop, and unfocused pointer-lock ownership.');
  console.log('drag-and-drop checks passed');
} catch (error) {
  console.error('Artifacts: ' + root);
  throw error;
} finally {
  socket?.close();
  try { process.kill(-desktop.pid, 'SIGTERM'); } catch {}
  await exited;
  await log.close();
}
