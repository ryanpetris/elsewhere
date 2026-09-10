// Docker rig: current binary, Python GI and GTK 3. Exercises real Wayland and X11 clients.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, open, readFile, rm } from 'node:fs/promises';
import { createToken } from './token-fixture.mjs';

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const wait = async (label, predicate) => {
  for (let n = 0; n < 200; n++) { if (await predicate()) return; await pause(50); }
  throw new Error(label + ' timed out');
};
for (const kiosk of [false, true]) {
  const root = await mkdtemp('/tmp/elsewhere-restore-');
  await mkdir(root + '/runtime', { mode: 0o700 });
  const log = await open(root + '/server.log', 'w');
  const origin = 'http://127.0.0.1:8097';
  const server = spawn(process.env.ELSEWHERE_BINARY || '/src/target/release/elsewhere', [
    '--no-audio', '--no-rtc', '--no-tls', '--render-node', 'none', '--codecs', 'vp8',
    '--listen', '127.0.0.1:8097', '--screen-size', '1024x768', '--socket-name', 'wayland-restore',
    ...(kiosk ? ['--kiosk'] : []),
  ], { cwd: root, env: { ...process.env, HOME: root, XDG_CONFIG_HOME: root + '/config', XDG_RUNTIME_DIR: root + '/runtime' }, stdio: ['ignore', log.fd, log.fd] });
  try {
    await wait('server', async () => { try { return (await fetch(origin)).ok; } catch { return false; } });
    const token = await createToken(root);
    const api = (path, body) => fetch(origin + path, {
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { method: path === '/api/display' ? 'PATCH' : 'POST', body: JSON.stringify(body) }),
    });
    const settings = async body => assert.equal((await api('/api/display', body)).status, 200);
    const control = async (id, op, args = {}) => assert.equal((await api('/api/control', { id, op, ...args })).status, 202);
    const windows = async () => (await (await api('/api/windows')).json());
    const info = async id => (await windows()).find(w => w.id === id);
    const geometry = w => [w.x, w.y, w.w, w.h];
    const restored = async (id, expected, label) => {
      let matches = 0;
      await wait(label, async () => {
        const w = await info(id);
        matches = !w.maximized && !w.fullscreen && w.y >= w.decoration && geometry(w).every((v, i) => v === expected[i]) ? matches + 1 : 0;
        return matches >= 2;
      });
    };
    const targets = [];
    for (const backend of ['wayland', 'x11']) for (const kind of ['small', 'large', 'minimum']) {
      const minimum = kind === 'minimum', title = `restore-${backend}-${kind}`;
      await control(0, 'spawn', { cmd: `GDK_BACKEND=${backend} GTK_CSD=0 /usr/bin/python3 /src/crates/elsewhere-compositor/checks/restore-client.py ${title} ${minimum ? '900 650' : '1 1'} ${kind === 'small' ? '400 300' : '900 650'}` });
      let window;
      await wait(title, async () => { window = (await windows()).find(w => w.title === title); return window?.w > 0; });
      assert.equal(window.x11, backend === 'x11');
      targets.push({ id: window.id, backend, minimum, kind });
    }
    if (kiosk) {
      await settings({ kiosk: false });
      await wait('kiosk exit maximizes', async () => (await windows()).every(w => w.maximized && !w.fullscreen));
    } else {
      for (const target of targets) {
        const { id } = target;
        await control(id, 'move', { x: 50, y: 60 });
        await wait('floating placement', async () => { const w = await info(id); return w.x === 50 && w.y === 60; });
        const before = target.before = geometry(await info(id));
        await control(id, 'maximize');
        await wait('maximize', async () => (await info(id)).maximized);
        await control(id, 'unmaximize');
        await wait('original floating geometry', async () => { const w = await info(id); return !w.maximized && geometry(w).every((v, i) => v === before[i]); });
        await control(id, 'maximize');
        await wait('maximize before shrink', async () => (await info(id)).maximized);
      }
    }
    await settings({ resolution: { mode: 'fixed', width: 800, height: 600 } });
    for (const { id, backend, minimum, kind, before } of targets) {
      await control(id, 'unmaximize');
      const expected = minimum ? [0, 32, 900, 650] : !kiosk && kind === 'small' ? before : [0, 32, 800, 568];
      await restored(id, expected, 'restored geometry');
      await control(id, 'fullscreen');
      await wait('fullscreen', async () => (await info(id)).fullscreen);
      await control(id, 'unfullscreen');
      await restored(id, expected, 'fullscreen restores floating geometry');
      console.log({ kiosk, backend, kind, geometry: expected });
    }
    const layouts = new Map((await windows()).map(w => [w.id, geometry(w)]));
    await settings({ kiosk: true });
    await wait('kiosk before shrink', async () => (await windows()).every(w => w.fullscreen));
    await settings({ resolution: { mode: 'fixed', width: 640, height: 480 } });
    await settings({ kiosk: false });
    for (const { id, minimum } of targets) {
      const saved = layouts.get(id);
      const fits = saved[0] + saved[2] <= 640 && saved[1] + saved[3] <= 480;
      const expected = minimum ? [0, 32, 900, 650] : fits ? saved : [0, 32, 640, 448];
      await restored(id, expected, 'kiosk exit restores the saved floating layout within the work area');
    }
  } catch (error) {
    console.error((await readFile(root + '/server.log', 'utf8')).split('\n').slice(-15).join('\n'));
    throw error;
  } finally {
    server.kill('SIGTERM');
    await new Promise(resolve => { if (server.exitCode !== null || server.signalCode !== null) resolve(); else server.once('exit', resolve); });
    await log.close();
    await rm(root, { recursive: true, force: true, maxRetries: 5 });
  }
}
console.log('Wayland and X11 restore within the work area, preserve fitting geometry and honor oversized minimums');
