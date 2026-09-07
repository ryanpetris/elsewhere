// Run in Docker with Chromium, foot, the audio stack and a mounted release build.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, open, readFile, rm } from 'node:fs/promises';
import { chromium } from 'playwright-core';

const root = await mkdtemp('/tmp/elsewhere-terminal-');
await mkdir(root + '/runtime', { mode: 0o700 });
const log = await open(root + '/server.log', 'w');
const origin = 'http://127.0.0.1:8097';
const server = spawn(process.env.ELSEWHERE_BINARY || '/src/target/release/elsewhere', [
  '--no-rtc', '--no-tls', '--render-node', 'none', '--codec', 'vp8', '--listen', '127.0.0.1:8097', '--socket-name', 'wayland-terminal',
], { cwd: root, env: { ...process.env, HOME: root, SHELL: '/bin/bash', XDG_CONFIG_HOME: root + '/config', XDG_RUNTIME_DIR: root + '/runtime' },
  stdio: ['ignore', log.fd, log.fd] });
const contents = path => readFile(path, 'utf8').catch(() => null);
const wait = async (label, predicate) => {
  for (let i = 0; i < 400; i++) { if (await predicate()) return; await new Promise(resolve => setTimeout(resolve, 50)); }
  throw new Error(label + ' timed out');
};
let browser;
try {
  await wait('server startup', async () => { try { return (await fetch(origin)).ok && !!await contents(root + '/config/elsewhere/token'); } catch { return false; } });
  const token = (await contents(root + '/config/elsewhere/token')).trim();
  const viewerToken = (await contents(root + '/config/elsewhere/viewer-token')).trim();
  browser = await chromium.launch({ executablePath: '/usr/bin/chromium', headless: true, args: ['--no-sandbox'] });
  const page = await browser.newPage({ viewport: { width: 1100, height: 850 } });
  await page.addInitScript(() => {
    const Original = window.WebSocket;
    window.terminalBytes = 0;
    window.desktopKeys = 0;
    window.WebSocket = class extends Original {
      constructor(...args) {
        super(...args);
        if (String(args[0]).endsWith('/ws/terminal')) this.addEventListener('message', event => {
          if (event.data instanceof ArrayBuffer) terminalBytes += event.data.byteLength;
        });
      }
      send(data) {
        if (new URL(this.url).pathname === '/ws' && new Uint8Array(data)[0] === 0x87) desktopKeys++;
        super.send(data);
      }
    };
  });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(origin + '/#token=' + token);
  await page.waitForFunction(() => window.elsewhere?.store.get().role === 'controller');
  await page.getByRole('button', { name: 'Terminal', exact: true }).click();
  const terminal = page.getByRole('region', { name: 'Terminal', exact: true });
  await terminal.getByRole('status').filter({ hasText: 'Connected' }).waitFor();
  const input = terminal.locator('textarea');
  const command = async text => { await input.focus(); await page.keyboard.type(text); await page.keyboard.press('Enter'); };
  await command('env > shellenv');
  await page.evaluate(() => elsewhere.spawn('env > desktopenv'));
  await wait('desktop and shell environment', async () => await contents(root + '/shellenv') && await contents(root + '/desktopenv'));
  const env = text => Object.fromEntries(text.trim().split('\n').map(line => { const i = line.indexOf('='); return [line.slice(0, i), line.slice(i + 1)]; }));
  const shell = env(await contents(root + '/shellenv')), desktop = env(await contents(root + '/desktopenv'));
  for (const key of ['WAYLAND_DISPLAY', 'DISPLAY', 'XDG_RUNTIME_DIR', 'XDG_SESSION_TYPE', 'GDK_BACKEND', 'SDL_VIDEODRIVER',
    'SDL_VIDEO_DRIVER', 'MOZ_ENABLE_WAYLAND', 'ELECTRON_OZONE_PLATFORM_HINT', 'PIPEWIRE_REMOTE', 'PIPEWIRE_CONFIG_DIR', 'PULSE_SERVER', 'DBUS_SESSION_BUS_ADDRESS']) {
    assert.equal(shell[key], desktop[key], key);
  }
  assert.equal(shell.WAYLAND_DISPLAY, 'wayland-terminal');
  assert.equal(shell.TERM, 'xterm-256color');
  assert.ok(shell.PIPEWIRE_REMOTE, 'private audio is available in the shell');
  assert.ok(shell.PULSE_SERVER, 'private Pulse endpoint is available in the shell');
  await command('foot --app-id=terminal-graph &');
  await page.waitForFunction(() => elsewhere.store.get().windows.some(window => window.app_id === 'terminal-graph'));
  await command('printf "interactive shell\\n" > result');
  await wait('interactive command', async () => await contents(root + '/result') === 'interactive shell\n');
  await command('sleep 30');
  await page.keyboard.press('Control+c');
  await command('printf interrupted > signal');
  await wait('Ctrl+C foreground job', async () => await contents(root + '/signal') === 'interrupted');
  await command('sleep 30');
  await page.keyboard.press('Control+z');
  await command('jobs > jobs; kill %1');
  await wait('Ctrl+Z job control', async () => (await contents(root + '/jobs'))?.includes('Stopped'));
  await command('stty size > size1');
  await wait('initial PTY size', () => contents(root + '/size1'));
  await page.setViewportSize({ width: 750, height: 750 });
  await command('stty size > size2');
  await wait('PTY resize', async () => { const size = await contents(root + '/size2'); return size && size !== await contents(root + '/size1'); });
  await command('seq 1 100000; printf flooddone > flood');
  await wait('output beyond flow-control window', async () => await contents(root + '/flood') === 'flooddone');
  const before = await page.evaluate(() => terminalBytes);
  await command('yes');
  await page.waitForFunction(before => terminalBytes > before + 1024 * 1024, before);
  await page.keyboard.press('Control+c');
  await command('printf responsive > continuous');
  await wait('interrupt continuous output', async () => await contents(root + '/continuous') === 'responsive');
  await command('echo $$ > shellpid');
  await wait('shell PID', () => contents(root + '/shellpid'));
  const shellpid = (await contents(root + '/shellpid')).trim();
  assert.equal(await page.evaluate(() => desktopKeys), 0, 'terminal typing never sends desktop key events');
  await terminal.getByRole('button', { name: 'Close terminal' }).click();
  await wait('shell cleanup', async () => await contents('/proc/' + shellpid + '/status') === null);
  console.log('terminal: session environment, graphical launch, interactive commands, signals, job control, resize, flow control and cleanup passed');

  const failedLoad = await browser.newPage();
  await failedLoad.route('**/assets/TerminalPanel-*.js', route => route.abort());
  await failedLoad.goto(origin + '/#token=' + token);
  await failedLoad.waitForFunction(() => ['controller', 'participant'].includes(elsewhere.store.get().role));
  await failedLoad.getByRole('button', { name: 'Terminal', exact: true }).click();
  await failedLoad.getByRole('status').filter({ hasText: 'Terminal could not load' }).waitFor();
  await failedLoad.getByRole('button', { name: 'Close terminal', exact: true }).click();
  await failedLoad.locator('canvas').waitFor();
  await failedLoad.evaluate(() => elsewhere.spawn('touch after-load-failure'));
  await wait('desktop after terminal download failure', () => contents(root + '/after-load-failure').then(text => text === ''));
  await failedLoad.close();
  console.log('terminal: failed emulator download leaves the desktop usable');

  const viewer = await browser.newPage();
  await viewer.goto(origin + '/#token=' + viewerToken);
  await viewer.waitForFunction(() => elsewhere.store.get().role === 'viewer');
  assert.equal(await viewer.getByRole('button', { name: 'Terminal', exact: true }).count(), 0);
  const denied = await viewer.evaluate(token => new Promise(resolve => {
    const socket = new WebSocket(`ws://${location.host}/ws/terminal`);
    let output = false;
    socket.onopen = () => { const bytes = new TextEncoder().encode(token); const auth = new Uint8Array(bytes.length + 1); auth[0] = 0x80; auth.set(bytes, 1); socket.send(auth); };
    socket.onmessage = () => { output = true; };
    socket.onclose = () => resolve(!output);
  }), viewerToken);
  assert.equal(denied, true, 'read-only token cannot open a shell');
  await viewer.close();
  const malformedClosed = await page.evaluate(token => new Promise(resolve => {
    const socket = new WebSocket(`ws://${location.host}/ws/terminal`);
    socket.binaryType = 'arraybuffer';
    let sent = false;
    const deadline = setTimeout(() => { resolve(false); socket.close(); }, 3000);
    socket.onopen = () => { const bytes = new TextEncoder().encode(token); const auth = new Uint8Array(bytes.length + 1); auth[0] = 0x80; auth.set(bytes, 1); socket.send(auth); };
    socket.onmessage = event => {
      if (!sent && event.data instanceof ArrayBuffer) {
        sent = true;
        socket.send(JSON.stringify({ cols: 80, rows: 24, ack: event.data.byteLength }));
      }
    };
    socket.onclose = () => { clearTimeout(deadline); resolve(sent); };
  }), token);
  assert.equal(malformedClosed, true, 'combined control fields are rejected instead of silently losing acknowledgements');
  await page.getByRole('button', { name: 'Terminal', exact: true }).click();
  await terminal.getByRole('status').filter({ hasText: 'Connected' }).waitFor();
  await command('echo $$ > revokedpid');
  await wait('revoked shell PID', () => contents(root + '/revokedpid'));
  const revokedpid = (await contents(root + '/revokedpid')).trim();
  const rotated = await fetch(origin + '/api/token/rotate', { method: 'POST', headers: { Authorization: 'Bearer ' + token } });
  assert.equal(rotated.ok, true);
  await wait('token rotation shell cleanup', async () => await contents('/proc/' + revokedpid + '/status') === null);
  assert.deepEqual(errors, []);
  console.log('terminal: read-only denial and token rotation passed');
} catch (error) {
  console.error(error, await contents(root + '/server.log'));
  throw error;
} finally {
  await browser?.close();
  server.kill('SIGTERM');
  await new Promise(resolve => { if (server.exitCode !== null || server.signalCode !== null) resolve(); else server.once('exit', resolve); });
  await log.close();
  await rm(root, { recursive: true, force: true, maxRetries: 5 });
}
