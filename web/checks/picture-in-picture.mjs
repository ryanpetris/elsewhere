import { approveControl } from './control-fixture.mjs';
import { createToken, revokeToken } from './token-fixture.mjs';
// Run in the Docker rig with a headed display at :95 and the release binary.
// Chromium check also needs wev; Firefox check needs geckodriver listening on port 4445.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdir, mkdtemp, open, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {chromium} from 'playwright-core';
import {toneCommand} from './audio-fixture.mjs';

const root = await mkdtemp(tmpdir() + '/elsewhere-pip-probe-');
await mkdir(root + '/runtime', {mode: 0o700});
const log = await open(root + '/server.log', 'w');
const origin = 'http://127.0.0.1:8093';
const server = spawn(
    (process.env.ELSEWHERE_BINARY || '/src/target/release/elsewhere'),
    [
      '--no-rtc', '--no-tls', '--render-node', 'none', '--codecs', 'vp8', '--listen', '127.0.0.1:8093',
      '--socket-name', 'wayland-pip-probe'
    ],
    {
      env: {
        ...process.env,
        HOME: root,
        XDG_CONFIG_HOME: root + '/config',
        XDG_RUNTIME_DIR: root + '/runtime',
        RUST_LOG: 'elsewhere_server::api=debug'
      },
      stdio: ['ignore', log.fd, log.fd],
    });
const wait = async fn => {
  for (let i = 0; i < 200; i++) {
    if (await fn()) return;
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error('timed out');
};
let browser, inputClient, inputLog;
const pageErrors = [];
try {
  await wait(async () => {
    try {
      return (await fetch(origin)).ok
    } catch {
      return false
    }
  });
  const token = await createToken(root);
  browser = await chromium.launch({
    headless: false,
    executablePath: '/usr/bin/chromium',
    env: {...process.env, DISPLAY: ':95', XDG_CONFIG_HOME: root + '/chromium'},
    args: [
      '--no-sandbox', '--autoplay-policy=no-user-gesture-required', '--use-fake-device-for-media-stream',
      '--use-fake-ui-for-media-stream'
    ]
  });
  const context = await browser.newContext();
  context.on('page', page => page.on('pageerror', error => pageErrors.push(error.message)));
  const permissionPreflights = [];
  context.on('request', request => { if (new URL(request.url()).pathname === '/api/me') permissionPreflights.push(request.url()); });
  await context.addInitScript(() => {
    const media = window.matchMedia;
    window.testMediaQueries = [];
    window.matchMedia = query => {
      const result = media.call(window, query);
      if (query.startsWith('(resolution:')) testMediaQueries.push(result);
      return result;
    };
    const Socket = WebSocket;
    const Decoder = window.VideoDecoder;
    if (Decoder) window.VideoDecoder = class extends Decoder {
      constructor(init) { super(init); window.testVideoOutput = init.output; }
    };
    window.testPackets = [];
    window.WebSocket = class extends Socket {
      constructor(...args) {
        super(...args);
        window.testSocket = this
      }
      send(data) {
        if (data instanceof ArrayBuffer || ArrayBuffer.isView(data))
          window.testPackets.push(
              Array.from(new Uint8Array(data instanceof ArrayBuffer ? data : data.buffer)));
        super.send(data)
      }
    }
  });
  const page = await context.newPage();
  await page.goto(origin + '/#token=' + token);
  await page.waitForFunction(() => !!window.elsewhere?.store.get().stream);
  await page.evaluate(() => elsewhere.claimControl());
  await page.evaluate(command => elsewhere.spawn(command), toneCommand());
  await page.waitForFunction(() => !!elsewhere.store.get().playback);
  await page.evaluate(() => elsewhere.mic.start());
  await page.waitForFunction(() => elsewhere.store.get().mic);
  await page.evaluate(
      cmd => elsewhere.spawn(cmd),
      'foot --app-id=pip-probe sh -c ' +
          '\'while true; do date +%s%N; sleep 0.2; done & while read line; do echo "$line" >> ' + root +
          '/typed; done\'');
  await page.waitForFunction(() => elsewhere.store.get().windows.some(w => w.app_id === 'pip-probe'));
  const id = await page.evaluate(() => elsewhere.store.get().windows.find(w => w.app_id === 'pip-probe').id);
  const other = await context.newPage();
  await other.goto(origin + '/#token=' + token);
  await other.waitForFunction(() => window.elsewhere?.store.get().role === 'participant');
  await other.evaluate(() => elsewhere.requestControl());
  const otherId = await other.evaluate(() => elsewhere.store.get().participantId);
  await page.waitForFunction(id => elsewhere.store.get().roster.sessions.find(s => s.id === id)?.request, otherId);
  const pendingBeforePip = await page.evaluate(id => elsewhere.store.get().roster.sessions.find(s => s.id === id).request, otherId);
  const tenureBeforePip = await page.evaluate(() => elsewhere.store.get().roster.epoch);
  const nextPage = context.waitForEvent('page');
  await page.getByRole('button', {name: 'Picture-in-Picture', exact: true}).first().click();
  const pipPage = await nextPage;
  await pipPage.waitForTimeout(300);
  let frame = pipPage.frames().find(f => f.parentFrame());
  await frame.waitForFunction(() => window.elsewhere?.store.get().role === 'controller' && !!elsewhere.store.get().stream);
  await page.waitForFunction(() => window.elsewhere?.store.get().role === 'controller' && elsewhere.store.get().pipDesktop && !elsewhere.store.get().desktopInput);
  await frame.waitForFunction(() => !!elsewhere.store.get().playback);
  assert.equal(await page.evaluate(() => elsewhere.store.get().playback), null);
  assert.equal(await page.evaluate(() => elsewhere.store.get().mic), true);
  assert.equal(await frame.evaluate(() => elsewhere.store.get().micAvailable), false);
  assert.equal(await frame.evaluate(() => elsewhere.store.get().mic), false);
  assert.equal(await page.evaluate(() => elsewhere.store.get().participantId), await frame.evaluate(() => elsewhere.store.get().participantId));
  await page.evaluate(() => {
    const tiny = document.createElement('canvas'); tiny.width = tiny.height = 1;
    testVideoOutput(new VideoFrame(tiny, {timestamp: 0}));
  });
  await page.waitForFunction(() => elsewhere.store.get().status === 'error');
  await page.waitForTimeout(100);
  assert.equal(pipPage.isClosed(), false, 'a recoverable opener video error keeps PiP open');
  assert.equal(await frame.evaluate(() => elsewhere.store.get().status), 'connected');
  const videoErrorSession = await page.evaluate(() => elsewhere.store.get().sessionId);
  await page.evaluate(() => testSocket.close());
  await page.waitForFunction(() => elsewhere.store.get().status === 'retrying');
  await page.waitForTimeout(100);
  assert.equal(pipPage.isClosed(), false, 'opener disconnect after video error keeps PiP open');
  await page.waitForFunction(old => elsewhere.store.get().status === 'connected' && elsewhere.store.get().sessionId !== old, videoErrorSession);
  assert.equal(await page.getByRole('button', {name: 'Request Control', exact: true}).count(), 0);
  assert.equal(await frame.getByRole('button', {name: 'Request Control', exact: true}).count(), 0);
  assert.equal(await page.locator('[data-pip-desktop] p').textContent(), 'Desktop is open in picture-in-picture.');
  console.log('single playback owner, main microphone retained, shared participant and desktop overlay');
  assert.equal(await page.evaluate(() => elsewhere.store.get().roster.sessions.length), 2);
  assert.equal(await page.evaluate(() => elsewhere.store.get().roster.epoch), tenureBeforePip);
  assert.deepEqual(await frame.evaluate(id => elsewhere.store.get().roster.sessions.find(s => s.id === id).request, otherId), pendingBeforePip);
  const overlay = await page.locator('[data-pip-desktop]').boundingBox();
  assert.deepEqual(overlay, await page.locator('.viewer-stage').boundingBox(), 'overlay covers only the desktop');
  await page.bringToFront();
  const inputCount = await page.evaluate(() => testPackets.filter(p => [0x83, 0x84, 0x85, 0x87, 0x91, 0x92].includes(p[0])).length);
  await page.locator('[data-pip-desktop]').click({ position: {x: 5, y: 5} });
  await page.locator('canvas.stage').evaluate(el => el.focus());
  await page.keyboard.type('blocked input'); await page.keyboard.press('Enter');
  assert.equal(await page.evaluate(() => testPackets.filter(p => [0x83, 0x84, 0x85, 0x87, 0x91, 0x92].includes(p[0])).length), inputCount);
  await page.getByRole('button', {name: 'Windows and Statistics', exact: true}).click();
  await page.getByRole('button', {name: 'Settings', exact: true}).click();
  assert.ok(await page.locator('#viewer-settings input').first().evaluate(el => {
    const box = el.getBoundingClientRect();
    return !!document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2)?.closest('#viewer-settings');
  }), 'settings controls remain above the desktop overlay');
  await page.keyboard.press('Escape');
  await page.locator('#participants-toggle').click();
  await page.getByRole('dialog', {name: 'Participants', exact: true}).getByRole('button', {name: 'Close', exact: true}).click({timeout: 3000});
  await page.getByRole('button', {name: 'Windows and Statistics', exact: true}).click();
  await page.evaluate(() => elsewhere.control({op: 'createworkspace', name: 'PiP check'}));
  await page.waitForFunction(() => elsewhere.store.get().workspaces.workspaces.length === 2);
  await page.getByRole('combobox', {name: 'Workspace', exact: true}).selectOption('2');
  await frame.waitForFunction(() => elsewhere.store.get().workspaces.active === 2);
  await frame.evaluate(() => elsewhere.control({op: 'switchworkspace', workspace: 1}));
  await page.waitForFunction(() => elsewhere.store.get().workspaces.active === 1);
  await frame.evaluate(() => elsewhere.control({op: 'deleteworkspace', workspace: 2}));
  await page.waitForFunction(() => elsewhere.store.get().mixer.nodes.some(n => n.mute_writable));
  const mixerNode = await page.evaluate(() => elsewhere.store.get().mixer.nodes.find(n => n.mute_writable));
  await page.evaluate(node => elsewhere.mixer.command({op: 'mute', id: node.id, value: !node.mute}), mixerNode);
  await frame.waitForFunction(node => elsewhere.store.get().mixer.nodes.find(n => n.id === node.id)?.mute === !node.mute, mixerNode);
  await frame.evaluate(node => elsewhere.mixer.command({op: 'mute', id: node.id, value: node.mute}), mixerNode);
  await page.waitForFunction(node => elsewhere.store.get().mixer.nodes.find(n => n.id === node.id)?.mute === node.mute, mixerNode);
  assert.deepEqual(await page.evaluate(id => elsewhere.store.get().roster.sessions.find(s => s.id === id).request, otherId), pendingBeforePip);
  console.log('overlay blocks desktop input, toolbar stays usable, both presentations control workspaces and mixer, pending request is unchanged');

  await frame.locator('canvas').click();
  await pipPage.keyboard.type('desktop input');
  await pipPage.keyboard.press('Enter');
  await wait(async () => {
    try {
      return (await readFile(root + '/typed', 'utf8')).includes('desktop input')
    } catch {
      return false
    }
  });
  const before = await frame.evaluate(() => elsewhere().videoSeq);
  await other.bringToFront();
  await frame.waitForFunction(before => elsewhere().videoSeq !== before, before);
  const cdp = await context.newCDPSession(page);
  const {windowId} = await cdp.send('Browser.getWindowForTarget');
  const preMin = await frame.evaluate(() => elsewhere().videoSeq);
  await cdp.send('Browser.setWindowBounds', {windowId, bounds: {windowState: 'minimized'}});
  await frame.waitForTimeout(1500);
  await frame.waitForFunction(n => elsewhere().videoSeq !== n, preMin);
  console.log('minimized opener still renders', await frame.evaluate(() => document.hidden));
  await cdp.send('Browser.setWindowBounds', {windowId, bounds: {windowState: 'normal'}});
  console.log('desktop PiP background', await frame.evaluate(() => ({
                                                               status: elsewhere.store.get().status,
                                                               role: elsewhere.store.get().role,
                                                               hidden: document.hidden,
                                                               frames: elsewhere().videoSeq
                                                             })));
  await approveControl(frame, other);
  await other.waitForFunction(() => window.elsewhere?.store.get().role === 'controller');
  const transferredChild = await frame.evaluate(() => elsewhere.store.get().sessionId);
  await frame.evaluate(() => testSocket.close());
  await frame.waitForFunction(old => elsewhere.store.get().status === 'connected' && elsewhere.store.get().sessionId !== old, transferredChild);
  assert.equal(await frame.evaluate(() => elsewhere.store.get().role), 'participant');
  assert.equal(await page.evaluate(() => elsewhere.store.get().role), 'participant');
  assert.equal(await other.evaluate(() => elsewhere.store.get().role), 'controller');
  await frame.getByRole('button', {name: 'Return to Viewer'}).click();
  await wait(() => Promise.resolve(pipPage.isClosed()));
  assert.equal(await other.evaluate(() => window.elsewhere?.store.get().role), 'controller');
  assert.equal(await page.evaluate(() => window.elsewhere?.store.get().role), 'participant');
  console.log('return preserves third-party controller');
  await page.bringToFront();
  const mainClaimNext = context.waitForEvent('page');
  await page.getByRole('button', {name: 'Picture-in-Picture', exact: true}).first().click();
  const claimPip = await mainClaimNext;
  await claimPip.waitForTimeout(300);
  await page.bringToFront();
  const claimFrame = claimPip.frames().find(f => f.parentFrame());
  await claimFrame.waitForFunction(() => window.elsewhere?.store.get().role === 'participant');
  await claimFrame.evaluate(() => elsewhere.requestControl());
  await page.waitForTimeout(150);
  assert.equal(await other.evaluate(() => elsewhere.store.get().role), 'controller');
  await approveControl(other, claimFrame);
  await claimFrame.getByRole('button', {name: 'Return to Viewer'}).click();
  await wait(() => Promise.resolve(claimPip.isClosed()));
  await page.waitForFunction(() => window.elsewhere?.store.get().role === 'controller');
  console.log('PiP requests approval and returns control to its opener');

  await page.bringToFront();
  await page.evaluate(() => elsewhere.claimControl());
  await page.waitForFunction(() => window.elsewhere?.store.get().role === 'controller');
  const next = context.waitForEvent('page');
  await page.getByRole('button', {name: 'Picture-in-Picture', exact: true}).first().click();
  const pip2 = await next;
  await pip2.waitForTimeout(300);
  frame = pip2.frames().find(f => f.parentFrame());
  await frame.waitForFunction(() => window.elsewhere?.store.get().role === 'controller');
  await page.bringToFront();
  await page.locator('[data-pip-desktop]').getByRole('button', {name: 'Return to Viewer', exact: true}).click();
  await page.waitForFunction(() => window.elsewhere?.store.get().role === 'controller' && elsewhere.store.get().desktopInput && !elsewhere.store.get().pipDesktop);
  await page.waitForFunction(() => !!elsewhere.store.get().playback);
  assert.equal(await page.evaluate(() => elsewhere.store.get().mic), false);
  console.log('return restores opener controller and playback without microphone');
  await page.evaluate(id => {
    const b = document.createElement('button');
    b.id = 'open-window-pip';
    b.textContent = 'Open test window';
    b.onclick = () => elsewhere.pip.open(id);
    document.body.append(b);
    b.style = 'position:fixed;top:0;left:0;z-index:9999'
  }, id);
  const nextWindow = context.waitForEvent('page');
  await page.click('#open-window-pip');
  const pip3 = await nextWindow;
  await pip3.waitForTimeout(300);
  frame = pip3.frames().find(f => f.parentFrame());
  await frame.waitForFunction(() => !!window.elsewhere?.store.get().stream);
  await frame.locator('canvas').click();
  await pip3.keyboard.type('window input');
  await pip3.keyboard.press('Enter');
  await wait(async () => {
    try {
      return (await readFile(root + '/typed', 'utf8')).includes('window input')
    } catch {
      return false
    }
  });
  const windowStage = await frame.locator('canvas.stage').boundingBox();
  await frame.getByRole('button', { name: 'On-Screen Keyboard', exact: true }).click();
  for (const key of ['p', 'i', 'p', '{space}', 'k', 'e', 'y', 's', '{enter}']) {
    await frame.locator('[data-skbtn=' + JSON.stringify(key) + ']').first().click();
  }
  await wait(async () => (await readFile(root + '/typed', 'utf8')).includes('pip keys'));
  assert.deepEqual(await frame.locator('canvas.stage').boundingBox(), windowStage, 'window PiP keyboard overlays its stage');
  await frame.getByRole('button', { name: 'Hide Keyboard', exact: true }).click();
  console.log('window PiP input');
  await page.bringToFront();
  await page.getByRole('button', {name: 'Picture-in-Picture', exact: true}).first().click();
  await pip3.waitForTimeout(300);
  assert.equal(pip3.isClosed(), false);
  frame = pip3.frames().find(f => f.parentFrame());
  await frame.waitForFunction(
      () => window.elsewhere?.store.get().role === 'controller' && elsewhere.store.get().sessionId != null);
  console.log('window to desktop reuses PiP');
  await frame.locator('canvas').click();
  await pip3.keyboard.press('Control+Shift+V');
  await frame.evaluate(() => {
    const data = new DataTransfer();
    data.setData('text/plain', 'pip clipboard');
    document.dispatchEvent(
        new ClipboardEvent('paste', {clipboardData: data, bubbles: true, cancelable: true}))
  });
  await frame.waitForFunction(async () => await elsewhere.clipboard.read() === 'pip clipboard');
  console.log('PiP clipboard event reaches remote clipboard');
  await frame.getByRole('button', {name: 'On-Screen Keyboard', exact: true}).click();
  await frame.locator('[data-keyboard]')
      .evaluate(
          el => el.dispatchEvent(
              new CompositionEvent('compositionend', {data: 'composition check', bubbles: true})));
  await frame.locator('[data-keyboard]').press('Enter');
  await wait(async () => {
    try {
      return (await readFile(root + '/typed', 'utf8')).includes('composition check')
    } catch {
      return false
    }
  });
  await frame.getByRole('button', {name: 'Hide Keyboard'}).click();
  console.log('PiP composition commit reaches terminal through keyboard field');
  await frame.locator('canvas').evaluate(async el => {
    try {
      await el.requestPointerLock();
      window.lockResult = !!document.pointerLockElement
    } catch (e) {
      window.lockResult = e.name
    }
  });
  console.log('Chromium pointer lock', await frame.evaluate(() => window.lockResult));
  await frame.evaluate(() => document.exitPointerLock());
  inputLog = await open(root + '/wev.log', 'w');
  inputClient = spawn('stdbuf', ['-oL', 'wev'], { env: { ...process.env, XDG_RUNTIME_DIR: root + '/runtime', WAYLAND_DISPLAY: 'wayland-pip-probe' }, stdio: ['ignore', inputLog.fd, inputLog.fd] });
  await frame.waitForFunction(() => elsewhere.store.get().windows.some(w => w.app_id === 'wev'));
  await frame.evaluate(() => {
    const w = elsewhere.store.get().windows.find(w => w.app_id === 'wev');
    elsewhere.control({op: 'maximize', id: w.id});
    elsewhere.activate(w.id)
  });
  await frame.locator('canvas').click({position: {x: 100, y: 100}});
  await pip3.mouse.wheel(0, 90);
  await frame.evaluate(() => elsewhere.setTouchMouse(false));
  const touchSession = await context.newCDPSession(pip3);
  await touchSession.send('Input.dispatchTouchEvent', {type: 'touchStart', touchPoints: [{x: 100, y: 100}]});
  await touchSession.send('Input.dispatchTouchEvent', {type: 'touchEnd', touchPoints: []});
  assert.ok(await frame.evaluate(() => testPackets.some(p => p[0] === 0x86)));
  assert.ok(await frame.evaluate(() => testPackets.some(p => p[0] === 0x92)));
  console.log('wheel and touch events emit protocol input');
  await wait(async () => {
    try {
      const log = await readFile(root + '/wev.log', 'utf8');
      return log.includes('button:') && log.includes('axis:') && log.includes('wl_touch')
    } catch {
      return false
    }
  });
  console.log('Wayland client receives button, axis and touch');
  await frame.locator('canvas').evaluate(el => {
    const data = new DataTransfer();
    data.items.add(new File(['pip file'], 'pip-drop.txt', {type: 'text/plain'}));
    for (const type of ['dragenter', 'dragover', 'drop'])
      el.dispatchEvent(new DragEvent(
          type, {dataTransfer: data, bubbles: true, cancelable: true, clientX: 100, clientY: 100}))
  });
  await frame.waitForFunction(() => !elsewhere.store.get().upload);
  await frame.waitForTimeout(500);
  await frame.waitForFunction(() => elsewhere.store.get().notice?.path?.endsWith('/Downloads') && elsewhere.store.get().notice.text.includes('pip-drop.txt'));
  console.log('PiP unclaimed drop saved to transfer folder');

  await frame.getByRole('button', { name: 'Open Folder', exact: true }).click();
  await page.waitForFunction(() => window.elsewhere?.store.get().role === 'controller');
  await page.locator('[data-file-name="pip-drop.txt"]').waitFor();
  const viewerToken = await createToken(root, ['desktop.view', 'audio.listen', 'clipboard.read']);
  const readOnly = await context.newPage();
  await readOnly.goto(origin + '/#token=' + viewerToken);
  await readOnly.waitForFunction(() => window.elsewhere?.store.get().role === 'viewer');
  const roId = await readOnly.evaluate(() => elsewhere.store.get().sessionId);
  await page.evaluate(id => elsewhere.handoff(id), roId);
  await readOnly.evaluate(() => elsewhere.handoff(1n));
  await page.waitForTimeout(200);
  assert.equal(await page.evaluate(() => window.elsewhere?.store.get().role), 'controller');
  const roNext = context.waitForEvent('page');
  await readOnly.getByRole('button', {name: 'Picture-in-Picture', exact: true}).first().click();
  const roPip = await roNext;
  await roPip.waitForTimeout(300);
  const roFrame = roPip.frames().find(f => f.parentFrame());
  await roFrame.waitForFunction(() => window.elsewhere?.store.get().role === 'viewer');
  await roFrame.evaluate(() => {
    elsewhere.requestControl();
    elsewhere.handoff(1n)
  });
  await page.waitForTimeout(300);
  assert.equal(await roFrame.evaluate(() => window.elsewhere?.store.get().role), 'viewer');
  assert.equal(await page.evaluate(() => window.elsewhere?.store.get().role), 'controller');
  assert.equal(await roFrame.getByRole('button', {name: 'Request Control', exact: true}).count(), 0);
  await readOnly.evaluate(() => elsewhere.pip.close());
  console.log('read-only PiP stays read-only');
  await page.evaluate(() => {
    window.originalPipRequest = documentPictureInPicture.requestWindow;
    documentPictureInPicture.requestWindow = () =>
        Promise.reject(new DOMException('Denied', 'NotAllowedError'))
  });
  await page.bringToFront();
  await page.getByRole('button', {name: 'Picture-in-Picture', exact: true}).first().click();
  await page.waitForFunction(() => elsewhere.store.get().notice?.text.includes('could not open'));
  assert.equal(await page.evaluate(() => window.elsewhere?.store.get().role), 'controller');
  await page.evaluate(() => documentPictureInPicture.requestWindow = window.originalPipRequest);
  assert.equal(await page.evaluate(() => elsewhere.store.get().pipDesktop), false);
  console.log('rejected request preserves viewer');
  const unsupported = await context.newPage();
  await unsupported.addInitScript(
      () => Object.defineProperty(window, 'documentPictureInPicture', {value: undefined}));
  await unsupported.goto(origin + '/#token=' + token);
  await unsupported.waitForFunction(() => !!window.elsewhere?.store.get().stream);
  assert.equal(await unsupported.getByRole('button', {name: 'Picture-in-Picture', exact: true}).count(), 0);
  assert.equal(
      await unsupported
          .getByRole('button', {name: 'Fullscreen', exact: true})
          .count(),
      1);
  await unsupported.close();
  const popNext = context.waitForEvent('page');
  await page.evaluate(id => window.open('/?window=' + id, 'normal-test', 'popup,width=500,height=400'), id);
  const normal = await popNext;
  await normal.waitForFunction(() => !!window.elsewhere?.store.get().stream);
  await normal.close();
  console.log('unsupported API and ordinary popup');
  await page.bringToFront();
  await page.getByRole('button', {name: 'Fullscreen', exact: true})
      .click();
  await page.waitForFunction(() => !!document.fullscreenElement);
  await page.evaluate(() => document.exitFullscreen());
  const reopen = context.waitForEvent('page');
  await page.getByRole('button', {name: 'Picture-in-Picture', exact: true}).first().click();
  const lifePip = await reopen;
  await lifePip.waitForTimeout(300);
  let lifeFrame = lifePip.frames().find(f => f.parentFrame());
  await lifeFrame.waitForFunction(() => window.elsewhere?.store.get().role === 'controller');
  const oldId = await lifeFrame.evaluate(() => elsewhere.store.get().sessionId);
  await lifeFrame.evaluate(() => testSocket.close());
  await lifeFrame.waitForFunction(
      old => elsewhere.store.get().status === 'connected' && elsewhere.store.get().sessionId !== old, oldId);
  await lifeFrame.waitForFunction(() => window.elsewhere?.store.get().role === 'controller');
  console.log('child socket reconnect restores presentation control');
  const oldMain = await page.evaluate(() => elsewhere.store.get().sessionId);
  const sharedParticipant = await lifeFrame.evaluate(() => elsewhere.store.get().participantId);
  await page.evaluate(() => {
    const schedule = window.setTimeout;
    window.setTimeout = (fn, delay, ...args) => schedule(fn, delay === 1000 ? 5000 : delay, ...args);
    testSocket.addEventListener('close', () => { window.setTimeout = schedule; });
    testSocket.close();
  });
  await page.waitForFunction(() => elsewhere.store.get().status === 'retrying');
  await lifeFrame.waitForTimeout(1500);
  assert.equal(await page.evaluate(() => elsewhere.store.get().status), 'retrying');
  assert.equal(await page.evaluate(() => elsewhere.store.get().pipDesktop), true);
  assert.ok(await lifeFrame.evaluate(() => elsewhere.store.get().playback));
  await lifeFrame.waitForFunction(() => elsewhere.store.get().role === 'controller' && elsewhere.store.get().desktopInput);
  await page.waitForFunction(old => elsewhere.store.get().status === 'connected' && elsewhere.store.get().sessionId !== old, oldMain);
  assert.equal(await page.evaluate(() => elsewhere.store.get().participantId), sharedParticipant);
  assert.equal(await page.evaluate(() => elsewhere.store.get().role), 'controller');
  assert.equal(await page.evaluate(() => elsewhere.store.get().desktopInput), false);
  console.log('main reconnect shares surviving PiP ownership without taking its input source');
  const bothMain = await page.evaluate(() => elsewhere.store.get().sessionId);
  const bothChild = await lifeFrame.evaluate(() => elsewhere.store.get().sessionId);
  await page.evaluate(() => {
    const schedule = window.setTimeout;
    window.setTimeout = (fn, delay, ...args) => schedule(fn, delay === 1000 ? 5000 : delay, ...args);
    testSocket.addEventListener('close', () => { window.setTimeout = schedule; });
    testSocket.close();
  });
  await page.waitForFunction(() => elsewhere.store.get().status === 'retrying');
  await lifeFrame.evaluate(() => testSocket.close());
  await lifeFrame.waitForTimeout(1500);
  assert.equal(lifePip.isClosed(), false, 'PiP waits for the opener after both sockets disconnect');
  await page.waitForFunction(old => elsewhere.store.get().status === 'connected' && elsewhere.store.get().sessionId !== old, bothMain);
  await lifeFrame.waitForFunction(old => elsewhere.store.get().status === 'connected' && elsewhere.store.get().sessionId !== old, bothChild);
  assert.equal(await page.evaluate(() => elsewhere.store.get().participantId), await lifeFrame.evaluate(() => elsewhere.store.get().participantId));
  assert.equal(await other.evaluate(() => elsewhere.store.get().role), 'controller');
  assert.equal(await lifeFrame.evaluate(() => elsewhere.store.get().role), 'participant');
  await page.evaluate(() => elsewhere.claimControl());
  await lifeFrame.waitForFunction(() => elsewhere.store.get().role === 'controller' && elsewhere.store.get().desktopInput);
  console.log('both sockets reconnect into the existing PiP without reclaiming ownership');
  const lifeCdp = await context.newCDPSession(lifePip);
  const lifeWin = await lifeCdp.send('Browser.getWindowForTarget');
  await lifeCdp.send(
      'Browser.setWindowBounds', {windowId: lifeWin.windowId, bounds: {width: 480, height: 360}});
  await lifeFrame.waitForFunction(
      () => elsewhere.store.get().stream.width ===
          Math.round(document.querySelector('canvas').getBoundingClientRect().width * devicePixelRatio));
  console.log('PiP viewport drives output');
  for (const deviceScaleFactor of [1.5, 2, 1]) {
    await lifeCdp.send(
        'Emulation.setDeviceMetricsOverride', {width: 480, height: 360, deviceScaleFactor, mobile: false});
    // CDP changes iframe DPR without a media-query event when CSS dimensions stay fixed.
    // Supply that event to exercise the viewer's rearm; viewport resizing is checked above.
    await lifeFrame.evaluate(() => {
      const query = testMediaQueries.at(-1);
      if (!query.matches) query.dispatchEvent(new Event('change'));
    });
    await lifeFrame.waitForFunction(
        dpr => devicePixelRatio === dpr && Math.abs(elsewhere.store.get().stream.scale - dpr) < 0.01,
        deviceScaleFactor);
  }
  console.log('PiP DPR variants and media-query rearm');
  await lifeFrame.evaluate(() => document.dispatchEvent(new Event('pointerlockerror')));
  await lifeFrame.waitForFunction(() => elsewhere.store.get().notice?.text.startsWith('Pointer capture failed.'));
  console.log('pointer lock error event reports failure');
  await lifeFrame.evaluate(() => elsewhere.activate(elsewhere.store.get().windows.find(w => w.app_id === 'wev').id));
  const inputOffset = (await readFile(root + '/wev.log', 'utf8')).length;
  await lifeFrame.locator('canvas').click();
  await lifePip.keyboard.down('Shift');
  await wait(async () => {
    const tail = (await readFile(root + '/wev.log', 'utf8')).slice(inputOffset);
    return tail.includes('Shift_L')
  });
  await lifePip.close();
  await page.waitForFunction(() => window.elsewhere?.store.get().role === 'controller' && elsewhere.store.get().desktopInput && !elsewhere.store.get().pipDesktop);
  await wait(async () => {
    const tail = (await readFile(root + '/wev.log', 'utf8')).slice(inputOffset);
    return tail.includes('Shift_L') && tail.includes('state: 0 (released)')
  });
  console.log('browser closure restores main input and releases held key');
  const goneNext = context.waitForEvent('page');
  await page.click('#open-window-pip');
  const gonePip = await goneNext;
  await gonePip.waitForTimeout(300);
  await page.evaluate(id => elsewhere.control({op: 'close', id}), id);
  await wait(() => Promise.resolve(gonePip.isClosed()));
  console.log('remote window closure closes PiP');
  const navNext = context.waitForEvent('page');
  await page.getByRole('button', {name: 'Picture-in-Picture', exact: true}).first().click();
  const navPip = await navNext;
  await navPip.waitForTimeout(300);
  await page.goto(origin + '/?navigation-check=1#token=' + token);
  await wait(() => Promise.resolve(navPip.isClosed()));
  await page.waitForFunction(() => !!window.elsewhere?.store.get().stream);
  console.log('opener navigation closes PiP');
  await page.evaluate(() => {
    window.dispatchEvent(new PageTransitionEvent('pagehide', {persisted: true}));
    window.dispatchEvent(new PageTransitionEvent('pageshow', {persisted: true}))
  });
  const authNext = context.waitForEvent('page');
  await page.getByRole('button', {name: 'Picture-in-Picture', exact: true}).first().click();
  const authPip = await authNext;
  await authPip.waitForTimeout(300);
  const authFrame = authPip.frames().find(f => f.parentFrame());
  await authFrame.waitForFunction(() => elsewhere.store.get().status === 'connected');
  await authFrame.evaluate(() => testSocket.close());
  await authFrame.waitForFunction(() => elsewhere.store.get().status === 'retrying');
  const revoked = await revokeToken(origin, token);
  assert.equal(revoked.status, 204);
  await wait(() => Promise.resolve(authPip.isClosed()));
  await page.waitForFunction(() => elsewhere.store.get().status === 'unauthorized');
  console.log('token revocation closes PiP while it is reconnecting');
  assert.deepEqual(pageErrors, [], 'main and PiP have no page errors');
  assert.deepEqual(permissionPreflights, [], 'desktop/window/PiP initialization and reconnect never preflight permissions');



} catch (error) {
  console.error('Page errors:', pageErrors);
  for (const context of browser?.contexts() ?? []) for (const page of context.pages()) for (const frame of page.frames()) {
    console.error(await frame.evaluate(() => { const s = window.elsewhere?.store.get(); return s && { status: s.status, role: s.role, participant: s.participantId, desktopInput: s.desktopInput, pipDesktop: s.pipDesktop, reason: s.reason, notice: s.notice?.text }; }).catch(() => 'frame closed'));
  }
  console.error((await readFile(root + '/server.log', 'utf8')).split('\n').slice(-25).join('\n'));
  throw error;
} finally {
  inputClient?.kill('SIGTERM');
  await inputLog?.close();
  await browser?.close();
  server.kill('SIGTERM');
  await new Promise(r => server.exitCode != null ? r() : server.once('exit', r));
  await log.close();
  if (!process.env.KEEP_FIXTURE) await rm(root, {recursive: true, force: true, maxRetries: 5, retryDelay: 100});
  else console.log(root);
}
