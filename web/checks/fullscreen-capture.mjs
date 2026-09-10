// Docker: built viewer, Chromium, Firefox, geckodriver, Xvfb, xdotool and xmessage. Real XTest keyboard input.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { chromium } from 'playwright-core';
import { CONFIG, ROLE, POINTER_LOCK, POINTER_LOCK_LOST, KEY, BLUR } from '../src/protocol.js';

const root = await mkdtemp('/tmp/elsewhere-fullscreen-');
const children = [];
const start = async (command, args, env) => {
  const child = spawn(command, args, { env, stdio: ['ignore', 'ignore', 'ignore', 'pipe'] });
  children.push(child);
  await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
  return child;
};
const stop = async child => {
  if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise(resolve => child.once('exit', resolve));
  child.kill('SIGTERM');
  const timer = setTimeout(() => child.kill('SIGKILL'), 2000);
  await exited; clearTimeout(timer);
};
const wait = async predicate => {
  for (let i = 0; i < 200; i++) { if (await predicate()) return; await new Promise(resolve => setTimeout(resolve, 50)); }
  throw new Error('fullscreen condition timed out');
};
const init = `
window.sent = []; window.errors = [];
addEventListener('unhandledrejection', event => errors.push(String(event.reason)));
window.WebSocket = class {
  static OPEN = 1; readyState = 1;
  constructor() { window.socket = this; queueMicrotask(() => { this.onopen?.({}); this.onmessage?.({ data: new Uint8Array([0x15, ...new TextEncoder().encode(JSON.stringify(["desktop.view", "desktop.control", "clipboard.read", "clipboard.write"]))]).buffer }); }); }
  send(data) { sent.push([...new Uint8Array(data)]); }
  close() {}
};
window.packet = bytes => socket.onmessage({ data: new Uint8Array(bytes).buffer });
// This fixture sends no video. Isolate input fallback from WebCodecs' secure-context requirement.
if (!isSecureContext) window.VideoDecoder = class {
  static async isConfigSupported() { return { supported: true }; }
  configure() { this.state = 'configured'; }
  close() { this.state = 'closed'; }
};
`;
const server = createServer(async (req, res) => {
  try {
    const path = new URL(req.url, 'http://localhost').pathname;

    if (path.startsWith('/api/')) { res.setHeader('Content-Type', 'application/json'); return res.end('[]'); }
    res.setHeader('Content-Type', path.endsWith('.js') ? 'text/javascript' : path.endsWith('.css') ? 'text/css' : 'text/html');
    let data = await readFile(new URL('../dist/' + (path === '/' ? 'index.html' : path.slice(1)), import.meta.url));
    if (path === '/') data = data.toString().replace('<head>', '<head><script>' + init + '</script>');
    res.end(data);
  } catch { res.writeHead(404).end(); }
});
let browser, driver, route, closeSession;
try {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const xvfb = await start('Xvfb', ['-displayfd', '3', '-screen', '0', '1280x900x24', '-nolisten', 'tcp'], process.env);
  const display = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Xvfb startup timed out')), 5000);
    xvfb.stdio[3].once('data', data => { clearTimeout(timer); resolve(':' + data.toString().trim()); });
    xvfb.once('exit', () => { clearTimeout(timer); reject(new Error('Xvfb exited')); });
  });
  const env = { ...process.env, DISPLAY: display, XDG_CONFIG_HOME: root };
  const key = value => execFileSync('xdotool', ['key', '--clearmodifiers', value], { env });
  const port = process.env.ELSEWHERE_WEBDRIVER_PORT || '4493';
  const wd = async (path, body, method = body ? 'POST' : 'GET') => {
    const response = await fetch('http://127.0.0.1:' + port + path, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    const data = await response.json();
    if (!response.ok) throw new Error(JSON.stringify(data.value));
    return data.value;
  };
  closeSession = async () => { if (route) { await wd(route, undefined, 'DELETE'); route = null; } };
  for (const name of (process.env.ELSEWHERE_CAPTURE_BROWSERS || 'chromium,firefox').split(',')) {
    let js, click, navigate, checkPip, checkF11, realFocus = async () => {};
    if (name === 'chromium') {
      browser = await chromium.launch({ executablePath: '/usr/bin/chromium', headless: false, env, args: ['--no-sandbox', '--no-proxy-server', '--host-resolver-rules=MAP insecure.example.test 127.0.0.1'] });
      const page = await browser.newPage();
      const cdp = await page.context().newCDPSession(page);
      realFocus = () => cdp.send('Emulation.setFocusEmulationEnabled', { enabled: false });
      js = (fn, ...args) => page.evaluate('(' + fn.toString() + ')(...' + JSON.stringify(args) + ')');
      click = selector => page.locator(selector).click();
      navigate = url => page.goto(url);
      checkF11 = async () => {
        const { windowId } = await cdp.send('Browser.getWindowForTarget');
        await page.getByRole('button', { name: 'Fullscreen', exact: true }).focus();
        key('F11');
        await wait(async () => (await cdp.send('Browser.getWindowBounds', { windowId })).bounds.windowState === 'fullscreen');
        assert.equal(await page.evaluate(() => elsewhere.isFullscreen()), false);
        await new Promise(resolve => setTimeout(resolve, 2100));
        await page.locator('canvas.stage').click();
        await page.waitForFunction(() => !!document.pointerLockElement);
        key('Escape');
        await page.waitForFunction(() => !document.pointerLockElement);
        await page.getByRole('button', { name: 'Fullscreen', exact: true }).focus();
        key('F11');
        await wait(async () => (await cdp.send('Browser.getWindowBounds', { windowId })).bounds.windowState !== 'fullscreen');
        console.log(name, 'browser-only F11 Escape fallback passed');
      };
      checkPip = async () => {
        const next = page.context().waitForEvent('page');
        await page.getByRole('button', { name: 'Picture-in-Picture', exact: true }).click();
        const popup = await next;
        let frame;
        await wait(() => { frame = popup.frames().find(f => f.parentFrame()); return !!frame; });
        await frame.waitForFunction(() => !!window.elsewhere?.store && !!window.socket);
        await frame.evaluate(({ ROLE, CONFIG }) => {
          packet([ROLE, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
          packet([CONFIG, ...new TextEncoder().encode(JSON.stringify({ streamId: 1, codec: 'vp8', width: 640, height: 480, scale: 1 }))]);
          elsewhere.setCaptureOnClick(true);
        }, { ROLE, CONFIG });
        assert.equal(await frame.locator('[data-mouse-capture]').count(), 0);
        assert.equal(await frame.getByRole('button', { name: 'Fullscreen', exact: true }).count(), 0);
        await frame.locator('canvas.stage').click();
        await frame.locator('[data-mouse-capture]').waitFor();
        key('a');
        await frame.waitForFunction(KEY => sent.filter(p => p[0] === KEY && p[1] === 30).length === 2, KEY);
        key('Escape');
        await frame.waitForFunction(() => !document.pointerLockElement);
        assert.equal(await frame.evaluate(() => elsewhere.isFullscreen()), false);
        assert.deepEqual(await frame.evaluate(() => errors), []);
        await frame.getByRole('button', { name: 'Return to Viewer' }).click();
        await wait(() => popup.isClosed());
        console.log(name, 'Document PiP input and Escape fallback passed');
      };
      console.log(name, await browser.version());
    } else {
      assert.equal(name, 'firefox');
      driver = await start('geckodriver', ['--port', port], env);
      await wait(async () => { try { return (await wd('/status')).ready; } catch { return false; } });
      const session = await wd('/session', { capabilities: { alwaysMatch: { browserName: 'firefox', 'moz:firefoxOptions': { binary: process.env.ELSEWHERE_FIREFOX_BINARY || '/usr/bin/firefox' } } } });
      route = '/session/' + session.sessionId;
      js = (fn, ...args) => wd(route + '/execute/sync', { script: 'return (' + fn.toString() + ')(...arguments)', args });
      click = async selector => {
        const element = await wd(route + '/element', { using: 'css selector', value: selector });
        await wd(route + '/element/' + Object.values(element)[0] + '/click', {});
      };
      navigate = url => wd(route + '/url', { url });
      console.log(name, session.capabilities.browserVersion);
    }
    let visit = 0;
    const load = async (windowMode = false, hostname = '127.0.0.1') => {
      await navigate(`http://${hostname}:${server.address().port}/?check=${++visit}${windowMode ? '&window=1' : ''}#token=test`);
      await wait(() => js(() => !!window.elsewhere?.store && !!window.socket)).catch(async error => { console.error(await js(() => ({ errors: window.errors, text: document.body.innerText, viewer: !!window.elsewhere }))); throw error; });
      await js((ROLE, CONFIG) => {
        packet([ROLE, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
        packet([CONFIG, ...new TextEncoder().encode(JSON.stringify({ streamId: 1, codec: 'vp8', width: 1280, height: 720, scale: 1 }))]);
        elsewhere.setCaptureOnClick(true);
      }, ROLE, CONFIG);
    };
    for (const windowMode of [false, true]) {
      await load(windowMode);
      const captured = () => wait(() => js(() => document.pointerLockElement === document.querySelector('canvas.stage') && elsewhere.store.get().locked));
      const full = () => wait(() => js(() => elsewhere.isFullscreen()));
      const enter = async () => {
        await click('button[title*="Fullscreen"]'); await full();
        await click('canvas.stage');
        if (windowMode) await js(POINTER_LOCK => packet([POINTER_LOCK, 1]), POINTER_LOCK);
        await captured();
      };
      const escape = async label => {
        await js(() => { sent.length = 0; });
        key('Escape');
        await wait(() => js(KEY => sent.filter(p => p[0] === KEY && p[1] === 1).length === 2, KEY));
        assert.deepEqual(await js(KEY => sent.filter(p => p[0] === KEY), KEY), [[KEY, 1, 0, 1], [KEY, 1, 0, 0]], label);
        assert.equal(await js(() => !!document.pointerLockElement && elsewhere.isFullscreen()), true, label);
        assert.equal(await js(type => sent.filter(p => p[0] === type).length, POINTER_LOCK_LOST), 0, label);
      };
      await enter();
      assert.equal(await js(() => [...document.querySelectorAll('button')].some(b => b.ariaLabel === 'Show Controls' && b.getBoundingClientRect().width > 0)), true);
      key('ctrl+alt+shift+h');
      await wait(() => js(() => !elsewhere.isFullscreen() && !document.pointerLockElement));
      assert.equal(await js(KEY => sent.some(p => p[0] === KEY && p[1] === 35), KEY), false, 'controls shortcut H stays local');
      await enter();
      await js(() => document.exitPointerLock());
      await wait(() => js(() => !document.pointerLockElement));
      await click('#clipboard-toggle');
      assert.equal(await js(() => document.fullscreenElement.contains(document.querySelector('#desktop-clipboard'))), true, 'fullscreen clipboard stays inside fullscreen root');
      await click('button[aria-label="Close Clipboard"]');
      await new Promise(resolve => setTimeout(resolve, 2100));
      await click('canvas.stage');
      if (windowMode) await js(POINTER_LOCK => packet([POINTER_LOCK, 1]), POINTER_LOCK);
      await captured();
      for (let i = 0; i < 3; i++) await escape('normal Escape stays captured');
      await js(() => { sent.length = 0; }); key('ctrl+alt');
      await wait(() => js(KEY => sent.filter(p => p[0] === KEY).length === 4, KEY));
      assert.equal(await js(() => !!document.pointerLockElement), true);
      assert.deepEqual((await js(KEY => sent.filter(p => p[0] === KEY).map(p => [p[1], p[3]]), KEY)).sort(), [[29, 0], [29, 1], [56, 0], [56, 1]].sort());
      assert.equal(await js(() => document.querySelector('[data-mouse-capture]')?.checkVisibility()), false, 'fullscreen hides the top bar and its warning');

      // A remote application can release and request capture again when its menu closes.
      await js(POINTER_LOCK => { packet([POINTER_LOCK, 1]); elsewhere.setCaptureOnClick(false); packet([POINTER_LOCK, 0]); }, POINTER_LOCK);
      await wait(() => js(() => !document.pointerLockElement && !elsewhere.store.get().locked));
      if (name === 'chromium') {
        await new Promise(resolve => setTimeout(resolve, 2100));
        await js(POINTER_LOCK => {
          window.pointerChanges = 0;
          document.addEventListener('pointerlockchange', () => { pointerChanges++; });
          packet([POINTER_LOCK, 1]); packet([POINTER_LOCK, 0]);
      }, POINTER_LOCK);
      await wait(() => js(() => pointerChanges > 0 && !document.pointerLockElement && !elsewhere.store.get().locked));
      await new Promise(resolve => setTimeout(resolve, 2100));
      }
      await js(POINTER_LOCK => packet([POINTER_LOCK, 1]), POINTER_LOCK);
      await captured(); await escape('application recapture retains keyboard capture');

      if (name === 'chromium') {
        await js(() => document.exitPointerLock());
        await wait(() => js(() => !document.pointerLockElement));
        await realFocus();
        const focused = execFileSync('xdotool', ['search', '--onlyvisible', '--class', name], { env, encoding: 'utf8' }).trim().split('\n')[0];
        execFileSync('xdotool', ['windowfocus', focused], { env });
        await wait(() => js(() => document.hasFocus()));
        const other = await start('xmessage', ['-title', 'Elsewhere focus check', 'Focus check'], env);
        let otherWindow;
        await wait(() => {
          try { otherWindow = execFileSync('xdotool', ['search', '--name', '^Elsewhere focus check$'], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim().split('\n')[0]; return !!otherWindow; }
          catch { return false; }
      });
      execFileSync('xdotool', ['windowfocus', otherWindow], { env });
      await wait(() => js(() => !document.hasFocus()));
      execFileSync('xdotool', ['windowfocus', focused], { env });
      await wait(() => js(() => document.hasFocus()));
      await stop(other);
      // Let the browser's pointer-lock request rate limit expire between independent cases.
      await new Promise(resolve => setTimeout(resolve, 2100));
      if (!await js(() => elsewhere.isFullscreen())) await click('button[title="Fullscreen"]');
      await full(); await click('canvas.stage');
      await js(POINTER_LOCK => packet([POINTER_LOCK, 1]), POINTER_LOCK);
      await captured(); await escape('deliberate recapture after real focus loss');
      }

      await js(() => {
        document.exitPointerLock();
        const field = document.createElement('textarea'); field.id = 'local-field';
        field.style = 'position:absolute;top:0;left:0;z-index:9999';
        document.fullscreenElement.append(field); sent.length = 0;
      });
      await wait(() => js(() => !document.pointerLockElement));
      await click('#local-field'); key('a'); key('Escape');
      assert.equal(await js(() => document.querySelector('#local-field').value), 'a');
      assert.deepEqual(await js(KEY => sent.filter(p => p[0] === KEY), KEY), [], 'local form input stays local');
      await js(() => document.querySelector('#local-field').remove());
      await new Promise(resolve => setTimeout(resolve, 2100));
      if (!await js(() => elsewhere.isFullscreen())) await click('button[title="Fullscreen"]');
      await full(); await click('canvas.stage');
      await js(POINTER_LOCK => packet([POINTER_LOCK, 1]), POINTER_LOCK);
      await captured();

      await js(() => { sent.length = 0; });
      execFileSync('xdotool', ['keydown', 'Escape'], { env });
      await new Promise(resolve => setTimeout(resolve, 3000));
      execFileSync('xdotool', ['keyup', 'Escape'], { env });
      await wait(() => js(() => !document.pointerLockElement));
      assert.equal(await js((KEY, BLUR) => {
        const held = new Set();
        for (const p of sent) {
          if (p[0] === BLUR) held.clear();
          if (p[0] === KEY) { const code = p[1] | p[2] << 8; if (p[3]) held.add(code); else held.delete(code); }
        }
        return held.size === 0 && sent.some(p => p[0] === BLUR);
      }, KEY, BLUR), true, 'hold Escape releases every remote key');
      await js(POINTER_LOCK => packet([POINTER_LOCK, 1]), POINTER_LOCK);
      await new Promise(resolve => setTimeout(resolve, 250));
      assert.equal(await js(() => !!document.pointerLockElement), false, 'late application request cannot recapture after hold Escape');
      if (await js(() => elsewhere.isFullscreen())) await js(() => document.exitFullscreen());
      await js(() => elsewhere.setCaptureOnClick(true));
      await enter(); await escape('fullscreen re-entry restores keyboard capture');

      await js(ROLE => packet([ROLE, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]), ROLE);
      await wait(() => js(() => !document.pointerLockElement));
      if (name === 'firefox') await wait(() => js(() => !elsewhere.isFullscreen()));
      if (await js(() => elsewhere.isFullscreen())) await js(() => document.exitFullscreen());
      await js(ROLE => packet([ROLE, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0]), ROLE);
      await enter();
      await js(() => socket.onclose({ code: 4003, reason: 'check' }));
      await wait(() => js(() => !document.pointerLockElement));
      if (name === 'firefox') await wait(() => js(() => !elsewhere.isFullscreen()));
      assert.deepEqual(await js(() => errors), []);
      console.log(name, windowMode ? 'window' : 'desktop', 'Escape pairs, Ctrl/Alt, application recapture, hold release, late-request suppression, re-entry, role loss and disconnect passed');
    }
    await load();
    await click('canvas.stage');
    await wait(() => js(() => !!document.pointerLockElement));
    key('Escape');
    await wait(() => js(() => !document.pointerLockElement));
    assert.equal(await js(() => elsewhere.isFullscreen()), false);
    assert.deepEqual(await js(() => errors), [], 'ordinary windowed Escape fallback stays usable');
    if (checkF11) { await load(); await checkF11(); }
    for (const cancel of ['role', 'disconnect', 'dispose', 'blur', 'exit']) {
      console.log(name, 'pending fullscreen cancellation:', cancel);
      await load();
      await js(() => {
        const stage = document.querySelector('[data-viewer]');
        const request = stage.requestFullscreen.bind(stage);
        stage.requestFullscreen = options => request(options).then(() => new Promise(resolve => { window.finishFullscreen = resolve; }));
      });
      await click('button[title="Fullscreen"]');
      await wait(() => js(() => !!window.finishFullscreen));
      await js((cancel, ROLE) => {
        if (cancel === 'role') packet([ROLE, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
        if (cancel === 'disconnect') socket.onclose({ code: 4003, reason: 'check' });
        if (cancel === 'dispose') elsewhere.dispose();
        if (cancel === 'blur') window.dispatchEvent(new Event('blur'));
        if (cancel === 'exit') document.exitFullscreen();
        finishFullscreen();
      }, cancel, ROLE);
      await wait(() => js(() => !elsewhere.isFullscreen()));
      assert.deepEqual(await js(() => errors), []);

    }
    if (name === 'chromium') {
      for (const cancel of ['role', 'disconnect', 'dispose', 'blur', 'exit']) {
        await load();
        await js(() => {
          const lock = navigator.keyboard.lock.bind(navigator.keyboard), unlock = navigator.keyboard.unlock.bind(navigator.keyboard);
          window.unlocks = 0;
          navigator.keyboard.lock = () => lock().then(() => new Promise(resolve => { window.finishKeyboard = resolve; }));
          navigator.keyboard.unlock = () => { unlocks++; unlock(); };
        });
        await click('button[title="Fullscreen"]');
        await wait(() => js(() => !!window.finishKeyboard));
        await js((cancel, ROLE) => {
          if (cancel === 'role') packet([ROLE, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
          if (cancel === 'disconnect') socket.onclose({ code: 4003, reason: 'check' });
          if (cancel === 'dispose') elsewhere.dispose();
          if (cancel === 'blur') window.dispatchEvent(new Event('blur'));
          if (cancel === 'exit') document.exitFullscreen();
        }, cancel, ROLE);
        await wait(() => js(() => unlocks > 0));
        const cancelled = await js(() => unlocks);
        await js(() => finishKeyboard());
        await wait(() => js(cancelled => unlocks > cancelled, cancelled));
        assert.deepEqual(await js(() => errors), []);
      }
      await load();
      await js(() => { navigator.keyboard.lock = () => Promise.reject(new DOMException('check', 'NotAllowedError')); });
      await click('button[title="Fullscreen"]');
      await wait(() => js(() => elsewhere.isFullscreen()));
      assert.deepEqual(await js(() => errors), []);
      await load(false, 'insecure.example.test');
      assert.equal(await js(() => isSecureContext), false);
      assert.equal(await js(() => !!navigator.keyboard?.lock), false);
      await click('button[title="Fullscreen"]');
      await wait(() => js(() => elsewhere.isFullscreen()));
      await click('canvas.stage');
      await wait(() => js(() => !!document.pointerLockElement));
      key('Escape');
      await wait(() => js(() => !document.pointerLockElement));
      assert.deepEqual(await js(() => errors), [], 'insecure input fallback has no unhandled rejection');
    }
    for (const behavior of ['rejected', 'ignored']) {
      await load();
      await js(behavior => {
        Object.defineProperty(navigator, 'keyboard', { configurable: true, value: undefined });
        const stage = document.querySelector('[data-viewer]'), request = stage.requestFullscreen.bind(stage);
        window.fullscreenCalls = [];
        stage.requestFullscreen = options => {
          fullscreenCalls.push(options?.keyboardLock || 'none');
          if (behavior === 'rejected' && options?.keyboardLock) return Promise.reject(new TypeError('check'));
          return request();
        };
      }, behavior);
      await click('button[title="Fullscreen"]');
      await wait(() => js(() => elsewhere.isFullscreen()));
      assert.deepEqual(await js(() => fullscreenCalls), behavior === 'rejected' ? ['browser', 'none'] : ['browser']);
      assert.deepEqual(await js(() => errors), []);
    }
    await load();
    if (checkPip) { await checkPip(); await load(); }
    await js(() => {
      const other = document.createElement('button'); other.id = 'other-fullscreen'; other.textContent = 'Other fullscreen';
      other.style = 'position:fixed;top:0;left:0;z-index:9999'; other.onclick = () => other.requestFullscreen(); document.body.append(other);
    });
    await click('#other-fullscreen');
    await wait(() => js(() => document.fullscreenElement?.id === 'other-fullscreen'));
    await js(() => elsewhere.dispose());
    assert.equal(await js(() => document.fullscreenElement?.id), 'other-fullscreen', 'disposal preserves unrelated fullscreen');
    console.log(name, 'pending fullscreen/keyboard cancellation, rejected/ignored APIs and unrelated fullscreen passed');
    await browser?.close(); browser = null;
    await closeSession();
    await stop(driver); driver = null;
  }
} finally {
  await browser?.close();
  await closeSession?.().catch(() => {});
  for (const child of children.reverse()) await stop(child);
  await new Promise(resolve => server.close(resolve));
  await rm(root, { recursive: true, force: true });
}
