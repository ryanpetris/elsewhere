// Docker: native binary, C compiler, libwayland-dev, wayland-protocols and plasma-wayland-protocols.
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, open, readFile, writeFile, rm } from 'node:fs/promises';
import { createToken } from './token-fixture.mjs';

const root = await mkdtemp('/tmp/elsewhere-bounds-');
const origin = 'http://127.0.0.1:8098';
const wait = async (label, predicate) => {
  for (let n = 0; n < 150; n++) { if (await predicate()) return; await new Promise(resolve => setTimeout(resolve, 50)); }
  throw new Error(label + ' timed out');
};
try {
  for (const [name, path] of [['xdg-shell', 'stable/xdg-shell/xdg-shell.xml'], ['xdg-decoration', 'unstable/xdg-decoration/xdg-decoration-unstable-v1.xml'], ['server-decoration', '../plasma-wayland-protocols/server-decoration.xml']]) {
    const xml = '/usr/share/wayland-protocols/' + path;
    execFileSync('wayland-scanner', ['client-header', xml, `${root}/${name}-client-protocol.h`]);
    execFileSync('wayland-scanner', ['private-code', xml, `${root}/${name}-protocol.c`]);
  }
  execFileSync('cc', ['-I' + root, '/src/crates/elsewhere-compositor/checks/bounds-client.c', root + '/xdg-shell-protocol.c', root + '/xdg-decoration-protocol.c', root + '/server-decoration-protocol.c', '-lwayland-client', '-o', root + '/client']);
  for (const kiosk of [false, true]) for (const initial of ['server', 'client']) {
    const home = `${root}/${kiosk}-${initial}`;
    await mkdir(home + '/runtime', { recursive: true, mode: 0o700 });
    const log = await open(home + '/server.log', 'w');
    const trace = home + '/bounds', command = home + '/command';
    const server = spawn(process.env.ELSEWHERE_BINARY || '/src/target/release/elsewhere', ['--no-audio', '--no-rtc', '--no-tls', '--render-node', 'none', '--codecs', 'vp8',
      '--listen', '127.0.0.1:8098', '--screen-size', '800x600', '--socket-name', 'wayland-bounds',
      '--exec', `${root}/client ${command} ${initial} > ${trace}`, ...(kiosk ? ['--kiosk'] : [])],
    { env: { ...process.env, HOME: home, XDG_CONFIG_HOME: home + '/config', XDG_RUNTIME_DIR: home + '/runtime' }, stdio: ['ignore', log.fd, log.fd] });
    try {
      await wait('server', async () => { try { return (await fetch(origin)).ok; } catch { return false; } });
      const token = await createToken(home);
      const request = async (path, body) => {
        const response = await fetch(origin + path, { method: body === undefined ? 'GET' : path === '/api/display' ? 'PATCH' : 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
        assert(response.ok, await response.clone().text()); return response.status === 202 ? null : response.json();
      };
      const records = async () => { try { return (await readFile(trace, 'utf8')).trim().split('\n').filter(Boolean).map(line => line.split(' ').map(Number)); } catch { return []; } };
      await wait('initial configure', async () => (await records()).length > 0);
      assert.deepEqual((await records())[0], [800, kiosk || initial === 'client' ? 600 : 568, initial === 'client' ? 1 : 2], 'initial bounds follow decoration and fullscreen state');
      const windows = await request('/api/windows');
      const id = windows.find(w => w.title === 'bounds-fixture').id;
      const expectChange = async (act, expected, every = false) => {
        const count = (await records()).length;
        await act();
        await wait('configured bounds ' + expected, async () => { const rows = await records(); return rows.length > count && JSON.stringify(rows.at(-1)) === JSON.stringify(expected); });
        if (every) for (const row of (await records()).slice(count).filter(row => row[2] === expected[2])) assert.deepEqual(row, expected, 'decoration mode and bounds change together');
      };
      await expectChange(() => request('/api/display', { resolution: { mode: 'fixed', width: 1024, height: 768 } }), [1024, kiosk || initial === 'client' ? 768 : 736, initial === 'client' ? 1 : 2]);
      if (kiosk) await expectChange(() => request('/api/display', { kiosk: false }), [1024, initial === 'client' ? 768 : 736, initial === 'client' ? 1 : 2]);
      for (const mode of initial === 'server' ? ['client', 'server'] : ['server', 'client']) {
        await expectChange(() => writeFile(command, mode), [1024, mode === 'client' ? 768 : 736, mode === 'client' ? 1 : 2], true);
      }
      const decor = initial === 'client' ? 1 : 2;
      await expectChange(() => request('/api/control', { id, op: 'fullscreen' }), [1024, 768, decor]);
      await expectChange(() => request('/api/control', { id, op: 'unfullscreen' }), [1024, initial === 'client' ? 768 : 736, decor]);
      for (const fill of ['floating', 'maximize', 'fullscreen']) {
        await request('/api/control', { id, op: 'unmaximize' });
        if (fill !== 'floating') await request('/api/control', { id, op: fill });
        await request('/api/control', { id, op: 'minimize' });
        await wait('minimized', async () => (await request('/api/windows')).find(w => w.id === id).minimized);
        for (const mode of initial === 'server' ? ['client', 'server'] : ['server', 'client']) {
          await expectChange(() => writeFile(command, mode), [1024, fill === 'fullscreen' || mode === 'client' ? 768 : 736, mode === 'client' ? 1 : 2], true);
          assert((await request('/api/windows')).find(w => w.id === id).minimized, 'decoration changes keep filled and floating windows minimized');
        }
        await expectChange(() => request('/api/display', { resolution: { mode: 'fixed', width: 800, height: 600 } }), [800, fill === 'fullscreen' || initial === 'client' ? 600 : 568, decor]);
        assert((await request('/api/windows')).find(w => w.id === id).minimized, 'resolution changes keep windows minimized');
        await request('/api/control', { id, op: 'unminimize' });
        if (fill === 'fullscreen') await request('/api/control', { id, op: 'unfullscreen' });
        await expectChange(() => request('/api/display', { resolution: { mode: 'fixed', width: 1024, height: 768 } }), [1024, initial === 'client' ? 768 : 736, decor]);
      }
      if (initial === 'client') await expectChange(() => writeFile(command, 'server'), [1024, 736, 2], true);
      await expectChange(() => writeFile(command, 'kde-client'), [1024, 768, 1], true);
      await expectChange(() => writeFile(command, 'kde-release'), [1024, 736, 2], true);
      console.log(`Wayland bounds passed with kiosk ${kiosk ? 'on' : 'off'} and initial ${initial} decorations`);
    } catch (error) { console.error(await readFile(trace, 'utf8').catch(() => ''), await readFile(home + '/server.log', 'utf8')); throw error; }
    finally { server.kill('SIGTERM'); await new Promise(resolve => server.once('exit', resolve)); await log.close(); }
  }
} finally { await rm(root, { recursive: true, force: true }); }
