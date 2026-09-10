// Docker desktop rig: current binary with viewer, Chromium and foot.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, open, readFile, rm } from 'node:fs/promises';
import { chromium } from 'playwright-core';
import { createToken } from './token-fixture.mjs';

const root = await mkdtemp('/tmp/elsewhere-capture-scroll-');
await mkdir(root + '/runtime', { mode: 0o700 });
const log = await open(root + '/server.log', 'w');
const origin = 'http://127.0.0.1:8094';
const width = 1024, height = 768;
const server = spawn(process.env.ELSEWHERE_BINARY || '/src/target/release/elsewhere', [
  '--no-audio', '--no-rtc', '--no-tls', '--render-node', 'none', '--codecs', 'vp8',
  '--listen', '127.0.0.1:8094', '--screen-size', `${width}x${height}`, '--socket-name', 'wayland-capture-scroll',
  '--exec', "foot --app-id=capture-scroll -o cursor.blink=no sh -c 'seq 1 300; printf \"\\033[?25l\"; sleep 600'",
], { cwd: root, env: { ...process.env, HOME: root, XDG_CONFIG_HOME: root + '/config', XDG_RUNTIME_DIR: root + '/runtime' }, stdio: ['ignore', log.fd, log.fd] });
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const wait = async (label, predicate) => {
  for (let n = 0; n < 200; n++) { if (await predicate()) return; await pause(50); }
  throw new Error(label + ' timed out');
};
let browser;
try {
  await wait('server', async () => { try { return (await fetch(origin)).ok; } catch { return false; } });
  const token = await createToken(root);
  const api = (path, body) => fetch(origin + path, {
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }),
  });
  let target;
  await wait('terminal', async () => {
    target = (await (await api('/api/windows')).json()).find(w => w.app_id === 'capture-scroll');
    return target && target.w > 0;
  });
  browser = await chromium.launch({ executablePath: '/usr/bin/chromium', args: ['--no-sandbox'] });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(origin + '/#token=' + token);
  await page.waitForFunction(() => elsewhere?.store.get().stats.frames > 0 && elsewhere.store.get().role === 'controller');
  await page.evaluate(() => elsewhere.setCaptureOnClick(true));
  assert(target.y + target.h < height - 1, 'previous pointer position is outside the terminal');
  assert.equal((await api('/api/input', { type: 'move', x: 1, y: height - 1 })).status, 202);
  const snapshot = async () => {
    const response = await api(`/api/windows/${target.id}/snapshot.png`);
    assert.equal(response.status, 200);
    return Buffer.from(await response.arrayBuffer());
  };
  let before;
  await wait('stable terminal contents', async () => {
    before = await snapshot();
    await pause(200);
    return (await snapshot()).equals(before);
  });
  const canvas = page.locator('canvas.stage'), box = await canvas.boundingBox();
  const x = box.x + (target.x + target.w / 2) / width * box.width;
  const y = box.y + (target.y + target.h / 2) / height * box.height;
  await page.mouse.click(x, y);
  await page.waitForFunction(() => elsewhere.store.get().locked && !!document.pointerLockElement);
  await pause(200);
  assert.deepEqual(await snapshot(), before, 'capture alone does not repaint the terminal');
  await page.mouse.wheel(0, -200);
  let immediate;
  await wait('first wheel after capture scrolls without pointer movement', async () => { immediate = await snapshot(); return !immediate.equals(before); });
  // The next wheel proves this application has usable scrollback at this position.
  await page.mouse.move(x + 2, y + 2);
  await page.mouse.wheel(0, -200);
  await wait('terminal scrolls after subsequent pointer movement', async () => !(await snapshot()).equals(immediate));
  console.log('Capture followed immediately by scrolling reaches the terminal; subsequent motion and scrolling also work');
  assert.deepEqual(errors, []);
} catch (error) {
  console.error((await readFile(root + '/server.log', 'utf8')).split('\n').slice(-10).join('\n'));
  throw error;
} finally {
  await browser?.close();
  server.kill('SIGTERM');
  await new Promise(resolve => { if (server.exitCode !== null || server.signalCode !== null) resolve(); else server.once('exit', resolve); });
  await log.close();
  await rm(root, { recursive: true, force: true, maxRetries: 5 });
}
