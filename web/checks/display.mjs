// Docker: built binary and viewer, Chromium, Python GI and GTK 3. Exercises the real compositor and streams.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, open, readFile, rm } from 'node:fs/promises';
import { chromium } from 'playwright-core';
import { createToken } from './token-fixture.mjs';

const binary = process.env.ELSEWHERE_BINARY || '/src/target/release/elsewhere';
const origin = 'http://127.0.0.1:8096';
const browser = await chromium.launch({ executablePath: '/usr/bin/chromium', args: ['--no-sandbox'] });
const wait = async (label, predicate) => {
  for (let n = 0; n < 300; n++) { if (await predicate()) return; await new Promise(resolve => setTimeout(resolve, 50)); }
  throw new Error(label + ' timed out');
};
try {
  for (const initialKiosk of [false, true]) {
    const root = await mkdtemp('/tmp/elsewhere-display-');
    await mkdir(root + '/runtime', { mode: 0o700 });
    const log = await open(root + '/server.log', 'w');
    const server = spawn(binary, ['--no-audio', '--no-rtc', '--no-tls', '--render-node', 'none', '--codecs', 'vp8',
      '--listen', '127.0.0.1:8096', '--screen-size', '1024x768', '--socket-name', 'wayland-display',
      '--exec', 'GDK_BACKEND=wayland GTK_CSD=0 /usr/bin/python3 /src/crates/elsewhere-compositor/checks/restore-client.py display-initial 1 1 900 650', ...(initialKiosk ? ['--kiosk'] : [])],
    { cwd: root, env: { ...process.env, HOME: root, XDG_CONFIG_HOME: root + '/config', XDG_RUNTIME_DIR: root + '/runtime' }, stdio: ['ignore', log.fd, log.fd] });
    let context;
    try {
      await wait('server', async () => { try { return (await fetch(origin)).ok; } catch { return false; } });
      const token = await createToken(root);
      const spectatorToken = await createToken(root, ['desktop.view']);
      const request = async (path, body, credential = token) => fetch(origin + path, {
        method: body === undefined ? 'GET' : path === '/api/display' ? 'PATCH' : 'POST',
        headers: { Authorization: 'Bearer ' + credential, 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const settings = async patch => { const response = await request('/api/display', patch); assert.equal(response.status, 200, await response.clone().text()); return response.json(); };
      const windows = async () => (await request('/api/windows')).json();
      const window = async id => (await windows()).find(w => w.id === id);
      const control = async (id, op, args = {}) => { assert.equal((await request('/api/control', { id, op, ...args })).status, 202); };
      const outputSize = async () => {
        const response = await request('/api/screenshot.png');
        assert.equal(response.status, 200);
        const png = Buffer.from(await response.arrayBuffer());
        return [png.readUInt32BE(16), png.readUInt32BE(20)];
      };
      const popupResize = async (ids, kiosk, pendingFill) => {
        const states = new Map(await Promise.all(ids.map(async id => [id, await window(id)])));
        for (const mode of ['fixed', 'auto']) {
          await settings({ resolution: mode === 'fixed' ? { mode, width: 1024, height: 768 } : { mode } });
          const output = await outputSize();
          for (const id of ids) {
            if (!kiosk) {
              const state = states.get(id);
              if (state.maximized) await control(id, 'maximize');
              if (state.fullscreen) await control(id, 'fullscreen');
              await wait('popup initial window state', async () => { const w = await window(id); return w.maximized === state.maximized && w.fullscreen === state.fullscreen; });
            }
            const popupContext = await browser.newContext({ viewport: { width: 600, height: 450 }, deviceScaleFactor: 2 });
            try {
              const page = await popupContext.newPage();
              const errors = []; page.on('pageerror', error => errors.push(error.message));
              await page.goto(origin + '/?window=' + id + '#token=' + token);
              await page.waitForFunction(() => elsewhere.store.get().stats.frames > 0);
              const before = await window(id);
              if (pendingFill) process.kill(before.pid, 'SIGSTOP');
              try {
                if (pendingFill) await control(id, pendingFill);
                await page.setViewportSize({ width: before.w === 700 ? 740 : 700, height: 540 });
                await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
                if (pendingFill) await page.waitForTimeout(350);
              } finally { if (pendingFill) process.kill(before.pid, 'SIGCONT'); }
              const box = await page.locator('.viewer-stage').boundingBox();
              const expected = [Math.round(box.width), Math.round(box.height)];
              if (kiosk) {
                await page.waitForTimeout(400);
                const w = await window(id);
                assert(w.fullscreen && !w.minimized);
                assert.deepEqual([w.x, w.y, w.w, w.h], [before.x, before.y, before.w, before.h], 'popup resize preserves kiosk fullscreen geometry');
              } else {
                assert.notDeepEqual(expected, [before.w, before.h], 'popup stage must request a different application size');
                await wait('popup resizes application to CSS stage size', async () => {
                  const w = await window(id);
                  return !w.maximized && !w.fullscreen && w.w === expected[0] && w.h === expected[1] && w.x >= 0 && w.y >= w.decoration && w.x + w.w <= output[0] && w.y + w.h <= output[1];
                });
              }
              assert.deepEqual(await outputSize(), output, 'window popup resize never resizes the desktop output');
              assert.deepEqual(errors, []);
            } finally { await popupContext.close(); }
          }
        }
        await settings({ resolution: { mode: 'fixed', width: 1024, height: 768 } });
        console.log(`Popup resize passed with kiosk ${kiosk ? 'on' : 'off'}${pendingFill ? ` and pending ${pendingFill}` : ''}, fixed and auto resolution, and HiDPI CSS sizing`);
      };
      await wait('initial window', async () => (await windows()).some(w => w.title === 'display-initial'));
      const first = (await windows()).find(w => w.title === 'display-initial');
      assert.equal(first.fullscreen, initialKiosk);
      assert.deepEqual(await settings(), { kiosk: initialKiosk, resolution: { mode: 'fixed', width: 1024, height: 768 } });
      assert.equal((await request('/api/display', { kiosk: !initialKiosk }, spectatorToken)).status, 403);
      for (const patch of [{ resolution: { mode: 'fixed', width: 801, height: 600 } }, { resolution: { mode: 'fixed', width: 8194, height: 600 } }, { kiosk: true, resolution: { mode: 'fixed', width: 0, height: 600 } }]) {
        assert.equal((await request('/api/display', patch)).status, 400);
        assert.equal((await settings()).kiosk, initialKiosk);
      }
      await control(0, 'spawn', { cmd: 'GDK_BACKEND=x11 GTK_CSD=0 /usr/bin/python3 /src/crates/elsewhere-compositor/checks/restore-client.py display-x11 1 1 300 180' });
      await wait('X11 window', async () => (await windows()).some(w => w.x11 && w.title === 'display-x11'));
      const x11 = (await windows()).find(w => w.x11 && w.title === 'display-x11');
      if (initialKiosk) {
        await popupResize([first.id, x11.id], true);
        await settings({ kiosk: false });
        await wait('startup kiosk exit maximizes', async () => { const w = await window(first.id); return w.maximized && !w.fullscreen && w.y >= w.decoration && w.h + w.decoration === 768; });
        await popupResize([first.id, x11.id], false);
        await control(first.id, 'maximize');
        await wait('startup window maximized before restore', async () => (await window(first.id)).maximized);
        await control(first.id, 'unmaximize');
        await wait('startup kiosk unmaximize stays in work area', async () => { const w = await window(first.id); return !w.maximized && w.y + w.h <= 768; });
        console.log('startup kiosk exit and unmaximize stay within decorated work area');
        continue;
      }

      for (const [id, other] of [[first.id, x11.id], [x11.id, first.id]]) {
        await control(other, 'activate');
        await wait('other window focused', async () => (await window(other)).focused);
        const order = (await windows()).map(w => [w.id, w.z, w.focused]);
        await control(id, 'resize', { w: 400, h: 300 });
        await wait('floating resize', async () => { const w = await window(id); return w.w === 400 && w.h === 300; });
        assert.deepEqual((await windows()).map(w => [w.id, w.z, w.focused]), order, 'floating resize preserves stacking and focus');
      }
      for (const backend of ['wayland', 'x11']) {
        const title = 'display-limits-' + backend;
        await control(0, 'spawn', { cmd: `GDK_BACKEND=${backend} GTK_CSD=0 /usr/bin/python3 /src/crates/elsewhere-compositor/checks/restore-client.py ${title} 800 600 900 650 950 700` });
        await wait('limited window has committed its initial size and hints', async () => (await windows()).some(w => w.title === title && w.w >= 800 && w.h >= 600));
        const limited = (await windows()).find(w => w.title === title);
        await control(limited.id, 'move', { x: 600, y: 500 });
        await control(limited.id, 'resize', { w: 400, h: 300 });
        await wait('minimum size and positioning', async () => {
          const w = await window(limited.id);
          return w.w === 800 && w.h === 600 && w.x >= 0 && w.y >= w.decoration && w.x + w.w <= 1024 && w.y + w.h <= 768;
        });
        await control(limited.id, 'resize', { w: 1200, h: 900 });
        await wait('maximum size and positioning', async () => {
          const w = await window(limited.id);
          return w.w === 950 && w.h === 700 && w.x >= 0 && w.y >= w.decoration && w.x + w.w <= 1024 && w.y + w.h <= 768;
        });
        await control(limited.id, 'close');
        await wait('limited window closed', async () => !(await window(limited.id)));
      }
      console.log('Floating resize preserves stacking and respects Wayland and X11 client size limits');
      await popupResize([first.id, x11.id], false);
      for (const op of ['maximize', 'fullscreen']) await popupResize([first.id], false, op);
      for (const op of ['maximize', 'fullscreen']) {
        for (const id of [first.id, x11.id]) await control(id, op);
        await wait(op, async () => (await windows()).every(w => op === 'maximize' ? w.maximized : w.fullscreen));
        await popupResize([first.id, x11.id], false);
      }
      await control(x11.id, 'maximize');
      await wait('X11 maximized', async () => (await window(x11.id)).maximized);
      await control(x11.id, 'minimize');
      await wait('X11 minimized', async () => (await window(x11.id)).minimized);
      const before = await window(first.id);
      await settings({ kiosk: true });
      await wait('existing windows kiosk', async () => (await windows()).every(w => w.fullscreen));
      assert((await window(x11.id)).minimized, 'kiosk preserves minimized state');
      await control(0, 'spawn', { cmd: 'GDK_BACKEND=wayland GTK_CSD=0 /usr/bin/python3 /src/crates/elsewhere-compositor/checks/restore-client.py display-new 1 1 900 650' });
      await wait('new kiosk window', async () => (await windows()).some(w => w.title === 'display-new' && w.fullscreen));
      const added = (await windows()).find(w => w.title === 'display-new');
      await control(0, 'spawn', { cmd: 'GDK_BACKEND=x11 GTK_CSD=0 /usr/bin/python3 /src/crates/elsewhere-compositor/checks/restore-client.py display-born-x11 1 1 300 180' });
      await wait('new kiosk X11', async () => (await windows()).some(w => w.x11 && w.title === 'display-born-x11' && w.fullscreen));
      const bornX11 = (await windows()).find(w => w.x11 && w.title === 'display-born-x11');
      await popupResize([added.id, bornX11.id], true);
      await settings({ kiosk: false });
      await wait('restore floating geometry', async () => { const w = await window(first.id); return !w.fullscreen && !w.maximized && ['x', 'y', 'w', 'h'].every(key => w[key] === before[key]); });
      await wait('new kiosk window maximized', async () => { const w = await window(added.id); return w.maximized && !w.fullscreen && w.h + w.decoration === 768; });
      assert((await window(x11.id)).maximized && (await window(x11.id)).minimized);
      await popupResize([added.id, bornX11.id], false);
      for (const id of [added.id, bornX11.id]) {
        await control(id, 'maximize');
        await wait('kiosk-created window maximized before restore', async () => (await window(id)).maximized);
        await control(id, 'unmaximize');
        await wait('new kiosk window unmaximize stays in work area', async () => { const w = await window(id); return !w.maximized && !w.fullscreen && w.y >= w.decoration && w.y + w.h <= 768; });
      }
      await settings({ kiosk: true });
      await wait('fullscreen before stopped client', async () => (await window(first.id)).fullscreen);
      process.kill(first.pid, 'SIGSTOP');
      try {
        await settings({ kiosk: false }); await settings({ kiosk: true });
        await new Promise(resolve => setTimeout(resolve, 150));
      } finally { process.kill(first.pid, 'SIGCONT'); }
      await new Promise(resolve => setTimeout(resolve, 150));
      await settings({ kiosk: false });
      await wait('floating after stopped client', async () => !(await window(first.id)).fullscreen);
      const resumed = await window(first.id);
      assert.deepEqual([resumed.w, resumed.h], [before.w, before.h], 'rapid kiosk toggles preserve pending normal size');
      await control(first.id, 'fullscreen');
      await wait('independent fullscreen', async () => (await window(first.id)).fullscreen);
      await settings({ kiosk: true }); await settings({ kiosk: false });
      await wait('preserved independent fullscreen', async () => (await window(first.id)).fullscreen);

      context = await browser.newContext({ viewport: { width: 1000, height: 800 }, deviceScaleFactor: 2 });
      const page = await context.newPage();
      const errors = []; page.on('pageerror', error => errors.push(error.message));
      await page.goto(origin + '/#token=' + token);
      await page.waitForFunction(() => elsewhere.store.get().stream?.width === 1024 && elsewhere.store.get().display);
      await page.locator('#hide-controls').click();
      await page.getByRole('button', { name: 'Show Controls', exact: true }).waitFor();
      await page.waitForTimeout(300);
      assert.equal(await page.evaluate(() => elsewhere.store.get().stream.width), 1024, 'fixed resolution survives chrome changes');
      await page.getByRole('button', { name: 'Show Controls', exact: true }).click();
      await page.getByRole('button', { name: 'Terminal', exact: true }).click();
      const terminal = page.getByRole('region', { name: 'Terminal', exact: true });
      await terminal.getByRole('status').filter({ hasText: 'Connected' }).waitFor();
      await terminal.locator('textarea').focus();
      await page.keyboard.type('DISPLAY_CHECK=kept'); await page.keyboard.press('Enter');
      await page.keyboard.press('Control+Alt+Shift+h');
      await page.getByRole('button', { name: 'Show Controls', exact: true }).waitFor();
      assert.equal(await terminal.isVisible(), false);
      await page.getByRole('button', { name: 'Show Controls', exact: true }).click();
      await terminal.locator('textarea').focus();
      await page.keyboard.type('printf "$DISPLAY_CHECK" > terminal-state'); await page.keyboard.press('Enter');
      await wait('hidden terminal keeps shell', async () => (await readFile(root + '/terminal-state', 'utf8').catch(() => '')) === 'kept');
      await terminal.getByRole('button', { name: 'Close Terminal', exact: true }).click();
      await page.getByRole('button', { name: 'Settings', exact: true }).click();
      await page.getByRole('checkbox', { name: 'Kiosk Mode' }).click();
      await page.waitForFunction(() => elsewhere.store.get().display.kiosk);
      await page.getByRole('checkbox', { name: 'Kiosk Mode' }).click();
      await page.waitForFunction(() => !elsewhere.store.get().display.kiosk);
      await page.getByLabel('Desktop Resolution').selectOption('1280x720');
      await page.getByRole('button', { name: 'Apply Resolution' }).click();
      await page.waitForFunction(() => elsewhere.store.get().stream?.width === 1280 && elsewhere.store.get().stream?.height === 720 && elsewhere.store.get().stream?.scale === 1);
      await page.keyboard.press('Escape');

      const other = await context.newPage();
      await other.setViewportSize({ width: 800, height: 650 });
      await other.goto(origin + '/#token=' + token);
      await other.waitForFunction(() => elsewhere.store.get().display?.resolution.width === 1280 && elsewhere.store.get().role === 'participant');
      await other.getByRole('button', { name: 'Take Control', exact: true }).click();
      await other.waitForFunction(() => elsewhere.store.get().role === 'controller' && elsewhere.store.get().stream?.width === 1280);
      await settings({ resolution: { mode: 'auto' } });
      await other.waitForFunction(() => {
        const s = elsewhere.store.get(); const box = document.querySelector('.viewer-stage').getBoundingClientRect();
        return s.display?.resolution.mode === 'auto' && s.stream?.scale === devicePixelRatio && Math.abs(s.stream.width / s.stream.scale - box.width) <= 2 && Math.abs(s.stream.height / s.stream.scale - box.height) <= 2;
      });
      await page.waitForFunction(() => elsewhere.store.get().display?.resolution.mode === 'auto');
      await settings({ resolution: { mode: 'fixed', width: 1024, height: 768 } });
      await other.waitForFunction(() => elsewhere.store.get().stream?.width === 1024);
      await page.getByRole('button', { name: 'Take Control', exact: true }).click();
      await page.waitForFunction(() => elsewhere.store.get().role === 'controller' && elsewhere.store.get().stream?.width === 1024);
      await Promise.all(Array.from({ length: 96 }, () => settings({ kiosk: false })));
      await settings({ resolution: { mode: 'fixed', width: 1024, height: 770 } });
      await page.waitForFunction(() => elsewhere.store.get().display?.resolution.height === 770);
      await other.waitForFunction(() => elsewhere.store.get().display?.resolution.height === 770);
      await page.reload();
      await page.waitForFunction(() => elsewhere.store.get().display?.resolution.height === 770);
      assert.deepEqual(errors, []);
      console.log('kiosk layout restoration, minimized X11, new windows, permissions, validation, live resolution, HiDPI auto, handoff and replay passed');
    } catch (error) {
      console.error((await readFile(root + '/server.log', 'utf8')).split('\n').slice(-12).join('\n'));
      console.error(error);
      throw error;
    } finally {
      await context?.close();
      const exited = new Promise(resolve => server.once('exit', resolve));
      if (server.exitCode === null) { server.kill('SIGTERM'); const kill = setTimeout(() => server.kill('SIGKILL'), 2000); await exited; clearTimeout(kill); }
      await log.close(); await rm(root, { recursive: true, force: true });
    }
  }
} finally { await browser.close(); }
