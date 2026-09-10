// Docker: built binary and viewer, Chromium, foot and xmessage. Exercises the real compositor and streams.
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
      '--exec', 'foot --app-id=display-initial', ...(initialKiosk ? ['--kiosk'] : [])],
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
      await wait('initial window', async () => (await windows()).some(w => w.app_id === 'display-initial'));
      const first = (await windows()).find(w => w.app_id === 'display-initial');
      assert.equal(first.fullscreen, initialKiosk);
      assert.deepEqual(await settings(), { kiosk: initialKiosk, resolution: { mode: 'fixed', width: 1024, height: 768 } });
      assert.equal((await request('/api/display', { kiosk: !initialKiosk }, spectatorToken)).status, 403);
      for (const patch of [{ resolution: { mode: 'fixed', width: 801, height: 600 } }, { resolution: { mode: 'fixed', width: 8194, height: 600 } }, { kiosk: true, resolution: { mode: 'fixed', width: 0, height: 600 } }]) {
        assert.equal((await request('/api/display', patch)).status, 400);
        assert.equal((await settings()).kiosk, initialKiosk);
      }
      if (initialKiosk) {
        await settings({ kiosk: false });
        await wait('startup kiosk exit maximizes', async () => { const w = await window(first.id); return w.maximized && !w.fullscreen && w.y >= w.decoration && w.h + w.decoration === 768; });
        await control(first.id, 'unmaximize');
        await wait('startup kiosk unmaximize stays in work area', async () => { const w = await window(first.id); return !w.maximized && w.y + w.h <= 768; });
        console.log('startup kiosk exit and unmaximize stay within decorated work area');
        continue;
      }

      await control(0, 'spawn', { cmd: 'xmessage -name display-x11 -geometry 300x180 display-check > xmessage.log 2>&1' });
      await wait('X11 window', async () => (await windows()).some(w => w.x11));
      const x11 = (await windows()).find(w => w.x11);
      await control(x11.id, 'maximize');
      await wait('X11 maximized', async () => (await window(x11.id)).maximized);
      await control(x11.id, 'minimize');
      await wait('X11 minimized', async () => (await window(x11.id)).minimized);
      const before = await window(first.id);
      await settings({ kiosk: true });
      await wait('existing windows kiosk', async () => (await windows()).every(w => w.fullscreen));
      assert((await window(x11.id)).minimized, 'kiosk preserves minimized state');
      await control(0, 'spawn', { cmd: 'foot --app-id=display-new' });
      await wait('new kiosk window', async () => (await windows()).some(w => w.app_id === 'display-new' && w.fullscreen));
      const added = (await windows()).find(w => w.app_id === 'display-new');
      await control(0, 'spawn', { cmd: 'xmessage -name display-born-x11 -geometry 300x180 kiosk > born-x11.log 2>&1' });
      await wait('new kiosk X11', async () => (await windows()).some(w => w.x11 && w.id !== x11.id && w.fullscreen));
      const bornX11 = (await windows()).find(w => w.x11 && w.id !== x11.id);
      await settings({ kiosk: false });
      await wait('restore floating geometry', async () => { const w = await window(first.id); return !w.fullscreen && !w.maximized && ['x', 'y', 'w', 'h'].every(key => w[key] === before[key]); });
      await wait('new kiosk window maximized', async () => { const w = await window(added.id); return w.maximized && !w.fullscreen && w.h + w.decoration === 768; });
      assert((await window(x11.id)).maximized && (await window(x11.id)).minimized);
      for (const id of [added.id, bornX11.id]) {
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
      await page.getByRole('button', { name: 'Show controls', exact: true }).waitFor();
      await page.waitForTimeout(300);
      assert.equal(await page.evaluate(() => elsewhere.store.get().stream.width), 1024, 'fixed resolution survives chrome changes');
      await page.getByRole('button', { name: 'Show controls', exact: true }).click();
      await page.getByRole('button', { name: 'Terminal', exact: true }).click();
      const terminal = page.getByRole('region', { name: 'Terminal', exact: true });
      await terminal.getByRole('status').filter({ hasText: 'Connected' }).waitFor();
      await terminal.locator('textarea').focus();
      await page.keyboard.type('DISPLAY_CHECK=kept'); await page.keyboard.press('Enter');
      await page.keyboard.press('Control+Alt+Shift+h');
      await page.getByRole('button', { name: 'Show controls', exact: true }).waitFor();
      assert.equal(await terminal.isVisible(), false);
      await page.getByRole('button', { name: 'Show controls', exact: true }).click();
      await terminal.locator('textarea').focus();
      await page.keyboard.type('printf "$DISPLAY_CHECK" > terminal-state'); await page.keyboard.press('Enter');
      await wait('hidden terminal keeps shell', async () => (await readFile(root + '/terminal-state', 'utf8').catch(() => '')) === 'kept');
      await terminal.getByRole('button', { name: 'Close terminal', exact: true }).click();
      await page.getByRole('button', { name: 'Settings', exact: true }).click();
      await page.getByRole('checkbox', { name: 'Kiosk mode' }).click();
      await page.waitForFunction(() => elsewhere.store.get().display.kiosk);
      await page.getByRole('checkbox', { name: 'Kiosk mode' }).click();
      await page.waitForFunction(() => !elsewhere.store.get().display.kiosk);
      await page.getByLabel('Desktop resolution').selectOption('1280x720');
      await page.getByRole('button', { name: 'Apply resolution' }).click();
      await page.waitForFunction(() => elsewhere.store.get().stream?.width === 1280 && elsewhere.store.get().stream?.height === 720 && elsewhere.store.get().stream?.scale === 1);
      await page.keyboard.press('Escape');

      const other = await context.newPage();
      await other.setViewportSize({ width: 800, height: 650 });
      await other.goto(origin + '/#token=' + token);
      await other.waitForFunction(() => elsewhere.store.get().display?.resolution.width === 1280 && elsewhere.store.get().role === 'participant');
      await other.getByRole('button', { name: 'Take control', exact: true }).click();
      await other.waitForFunction(() => elsewhere.store.get().role === 'controller' && elsewhere.store.get().stream?.width === 1280);
      await settings({ resolution: { mode: 'auto' } });
      await other.waitForFunction(() => {
        const s = elsewhere.store.get(); const box = document.querySelector('.viewer-stage').getBoundingClientRect();
        return s.display?.resolution.mode === 'auto' && s.stream?.scale === devicePixelRatio && Math.abs(s.stream.width / s.stream.scale - box.width) <= 2 && Math.abs(s.stream.height / s.stream.scale - box.height) <= 2;
      });
      await page.waitForFunction(() => elsewhere.store.get().display?.resolution.mode === 'auto');
      await settings({ resolution: { mode: 'fixed', width: 1024, height: 768 } });
      await other.waitForFunction(() => elsewhere.store.get().stream?.width === 1024);
      await page.getByRole('button', { name: 'Take control', exact: true }).click();
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
      console.error(await readFile(root + '/xmessage.log', 'utf8').catch(() => ''));
      console.error(await readFile(root + '/born-x11.log', 'utf8').catch(() => ''));
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
