import { createToken } from './token-fixture.mjs';
// Run in the Docker rig with Chromium, foot and the mounted release binary.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, open, readFile, rm, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { chromium } from 'playwright-core';

const root = await mkdtemp(tmpdir() + '/elsewhere-input-');
await mkdir(root + '/runtime', { mode: 0o700 });
const log = await open(root + '/server.log', 'w');
const origin = 'http://127.0.0.1:8095';
await writeFile(root + '/capture.py', [
  'import os, sys, termios, tty',
  'saved = termios.tcgetattr(0)',
  'try:',
  '    tty.setraw(0)',
  '    open(sys.argv[1] + ".ready", "w").close()',
  '    data = b""',
  '    while len(data) < int(sys.argv[2]): data += os.read(0, int(sys.argv[2]) - len(data))',
  '    open(sys.argv[1], "wb").write(data)',
  'finally: termios.tcsetattr(0, termios.TCSADRAIN, saved)',
].join('\n'));
const server = spawn(process.env.ELSEWHERE_BINARY || '/src/target/release/elsewhere', ['--no-audio', '--no-rtc', '--no-tls', '--render-node', 'none', '--codecs', 'vp8', '--listen', '127.0.0.1:8095', '--socket-name', 'wayland-input'], {
  cwd: root, env: { ...process.env, HOME: root, XDG_CONFIG_HOME: root + '/config', XDG_RUNTIME_DIR: root + '/runtime' }, stdio: ['ignore', log.fd, log.fd],
});
const wait = async (fn, label = 'server readiness') => {
  for (let i = 0; i < 200; i++) { if (await fn()) return; await new Promise(r => setTimeout(r, 50)); }
  throw new Error(`${label} timed out`);
};
const contents = path => readFile(path, 'utf8').catch(() => null);
let browser;
try {
  await wait(async () => { try { return (await fetch(origin)).ok; } catch { return false; } });
  const token = await createToken(root);
  const viewerToken = await createToken(root, ['desktop.view', 'audio.listen', 'clipboard.read']);
  browser = await chromium.launch({ executablePath: '/usr/bin/chromium', env: { ...process.env, XDG_CONFIG_HOME: root + '/chromium' }, args: ['--no-sandbox'] });
  const connect = async (token, id) => {
    const context = await browser.newContext(id ? { hasTouch: true, viewport: { width: 390, height: 844 } } : {});
    const page = await context.newPage();
    await page.goto(`${origin}/${id ? '?window=' + id : ''}#token=${token}`);
    await page.waitForFunction(() => window.elsewhere?.store.get().status === 'connected');
    await page.evaluate(() => elsewhere.setCaptureOnClick(false));
    return page;
  };
  const desktop = await connect(token);
  await desktop.evaluate(() => elsewhere.spawn('foot --app-id=input-check'));
  await desktop.waitForFunction(() => elsewhere.store.get().windows.some(w => w.app_id === 'input-check'));
  const id = await desktop.evaluate(() => elsewhere.store.get().windows.find(w => w.app_id === 'input-check').id);
  const windowPage = await connect(token, id);
  const observers = [await connect(viewerToken), await connect(viewerToken, id)];
  for (const observer of observers) assert.equal(await observer.getByRole('button', { name: 'On-Screen Keyboard', exact: true }).count(), 0);
  for (const [index, page] of [desktop, windowPage].entries()) {
    const output = `${root}/input-${index}`;
    const label = index ? 'window' : 'desktop';
    await page.evaluate(id => elsewhere.activate(id), id);
    // Raw input starts tee, independently of the structured messages under test.
    await page.locator('canvas').focus();
    await page.keyboard.type(`tee input-${index}`);
    await page.keyboard.press('Enter');
    await wait(async () => await contents(output) === '', `${label} raw input setup`);
    const canvas = page.locator('canvas.stage');
    const stageBefore = await canvas.boundingBox();
    const windowBefore = await desktop.evaluate(id => {
      const w = elsewhere.store.get().windows.find(w => w.id === id);
      return [w.w, w.h];
    }, id);
    await page.getByRole('button', { name: 'On-Screen Keyboard', exact: true }).click();
    const keyboard = page.getByRole('region', { name: 'On-Screen Keyboard', exact: true });
    await keyboard.waitFor({ state: 'visible' });
    if (index) {
      await page.evaluate(() => elsewhere.store.set({ role: 'participant' }));
      assert(await keyboard.isVisible(), 'window participants retain their keyboard');
    }
    assert.deepEqual(await canvas.boundingBox(), stageBefore, 'keyboard overlays the stage');
    const keyboardBox = await keyboard.boundingBox(), stageBox = await page.locator('.viewer-stage').boundingBox();
    assert(keyboardBox.x >= stageBox.x && keyboardBox.x + keyboardBox.width <= stageBox.x + stageBox.width, 'keyboard stays within the stage beside the sidebar');
    const press = async key => {
      const keyButton = keyboard.locator('[data-skbtn=' + JSON.stringify(key) + ']').first();
      if (index) await keyButton.tap(); else await keyButton.click();
    };
    for (const key of ['f', 'i', 'r', 'x', '{bksp}', 's', 't', '{enter}']) await press(key);
    assert(await canvas.evaluate(el => el === document.activeElement), 'on-screen keys preserve canvas focus');
    assert.deepEqual(await desktop.evaluate(id => {
      const w = elsewhere.store.get().windows.find(w => w.id === id);
      return [w.w, w.h];
    }, id), windowBefore, 'opening and typing do not resize the streamed window');
    await wait(async () => await contents(output) === 'first\n', `${label} structured text and Return`);
    for (const observer of observers) {
      await observer.evaluate(() => { elsewhere.type('forbidden'); elsewhere.key('Return'); elsewhere.key('ctrl+d'); });
      // Stream state acknowledges a later message on the same ordered socket.
      const quality = await observer.evaluate(() => elsewhere.store.get().streamState?.preset === 'low' ? 'high' : 'low');
      await observer.evaluate(quality => elsewhere.setChoice({ quality }), quality);
      await observer.waitForFunction(quality => elsewhere.store.get().streamState?.preset === quality, quality);
    }
    await page.keyboard.type('second');
    await page.keyboard.press('Enter');
    await wait(async () => await contents(output) === 'first\nsecond\n', `${label} view permission rejection`);
    await press('{ctrl}');
    assert.equal(await keyboard.locator('[data-skbtn="{ctrl}"]').getAttribute('aria-pressed'), 'true');
    await press('d');
    assert.equal(await keyboard.locator('[data-skbtn="{ctrl}"]').getAttribute('aria-pressed'), 'false');
    // A subsequent shell command proves the key chord reached the running app.
    const done = `${root}/done-${index}`;
    await page.evaluate(done => { elsewhere.type(`touch ${done}`); elsewhere.key('Return'); }, done);
    await wait(async () => await contents(done) === '', `${label} Ctrl+D and subsequent command`);
    assert.equal(await contents(output), 'first\nsecond\n', 'view-only structured input must not reach the app');
    const expected = '\x1b\t\x1b[3~\x1b[D\x1b[C\x1b[A\x1b[BA!\x1bx\x01';
    const capture = `${root}/keys-${index}`;
    await page.evaluate(command => { elsewhere.type(command); elsewhere.key('Return'); }, `python3 capture.py ${capture} ${expected.length}`);
    await wait(async () => await contents(capture + '.ready') === '', 'raw terminal key capture ready');
    for (const key of ['{esc}', '{tab}', '{del}', '{left}', '{right}', '{up}', '{down}', '{shift}', 'A', '{shift}', '!', '{alt}', 'x', '{ctrl}', 'a']) await press(key);
    await wait(async () => await contents(capture) === expected, `${label} named keys, Shift punctuation and Alt/Ctrl chords`);
    await press('{super}');
    assert.equal(await keyboard.locator('[data-skbtn="{super}"]').getAttribute('aria-pressed'), 'true');
    await press('{super}');
    assert.equal(await keyboard.locator('[data-skbtn="{super}"]').getAttribute('aria-pressed'), 'false');
    await page.screenshot({ path: `/tmp/elsewhere-keyboard-${label}.png` });
    await page.getByRole('button', { name: 'Hide Keyboard', exact: true }).click();
    await keyboard.waitFor({ state: 'detached' });
    console.log(`${label} on-screen text, Backspace, Return, Ctrl+D, physical typing, overlay geometry and view-only rejection passed`);
  }
  const focused = `${root}/focused`;
  await desktop.evaluate(command => elsewhere.spawn(command), `foot --app-id=input-focus sh -c 'cat > ${focused}'`);
  await desktop.waitForFunction(() => elsewhere.store.get().windows.some(w => w.app_id === 'input-focus' && w.focused && w.w > 0 && w.h > 0));
  await wait(async () => await contents(focused) === '', 'second terminal readiness');
  await windowPage.evaluate(() => { elsewhere.type('current focus'); elsewhere.key('Return'); });
  await wait(async () => await contents(focused) === 'current focus\n', 'window text follows current keyboard focus');
  console.log('window text follows current keyboard focus even when another window is streamed');
} catch (error) {
  console.error(error);
  console.error(await contents(root + '/server.log'));
  throw error;
} finally {
  await browser?.close();
  server.kill('SIGTERM');
  await new Promise(resolve => { if (server.exitCode !== null || server.signalCode !== null) resolve(); else server.once('exit', resolve); });
  await log.close();
  await rm(root, { recursive: true, force: true, maxRetries: 5 });
}
