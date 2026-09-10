// Docker GPU rig: ELSEWHERE_RENDER_NODE selects the encoder; the browser uses a separate render node.
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, open, readFile, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright-core';
import { createToken } from './token-fixture.mjs';

const root = await mkdtemp('/tmp/elsewhere-gpu-surfaces-');
const binary = process.env.ELSEWHERE_BINARY || '/src/target/release/elsewhere';
const codec = process.env.ELSEWHERE_CODEC || 'h264';
const origin = 'http://127.0.0.1:8849';
const children = [], logs = [];
let browser;
async function desktop(name, port, host) {
  const runtime = `${root}/${name}`;
  await mkdir(runtime, { mode: 0o700 });
  const log = await open(`${runtime}/server.log`, 'w'); logs.push(log);
  const child = spawn(binary, ['--no-audio', '--no-tls', '--listen', `127.0.0.1:${port}`,
    '--render-node', host ? (process.env.ELSEWHERE_BROWSER_RENDER_NODE || '/dev/dri/renderD128') : process.env.ELSEWHERE_RENDER_NODE,
    '--socket-name', name, '--screen-size', host ? '1600x1200' : '1346x908',
    '--codecs', host ? 'vp8' : codec, ...(host ? ['--software-encoding'] : ['--kiosk'])],
    { env: { ...process.env, XDG_RUNTIME_DIR: runtime, XDG_CONFIG_HOME: runtime + '/config' }, stdio: ['ignore', log.fd, log.fd] });
  children.push(child);
  for (let i = 0; i < 300; i++) {
    try { if ((await fetch(`http://127.0.0.1:${port}`)).ok) return runtime; } catch {}
    assert.equal(child.exitCode, null, await readFile(`${runtime}/server.log`, 'utf8'));
    await new Promise(r => setTimeout(r, 50));
  }
  throw Error('server startup timeout');
}
try {
  const host = await desktop('browser-host', 8848, true);
  const target = await desktop('gpu-source', 8849, false);
  const token = await createToken(target);
  const xml = '/usr/share/wayland-protocols/stable/xdg-shell/xdg-shell.xml';
  execFileSync('wayland-scanner', ['client-header', xml, root + '/xdg-shell-client-protocol.h']);
  execFileSync('wayland-scanner', ['private-code', xml, root + '/xdg-shell-protocol.c']);
  execFileSync('cc', ['-I' + root, '/src/crates/elsewhere-compositor/checks/thumbnail-client.c', root + '/xdg-shell-protocol.c', '-lwayland-client', '-o', root + '/client']);
  await writeFile(root + '/command', 'edges');
  browser = await chromium.launch({ executablePath: '/usr/bin/chromium', headless: false,
    args: ['--no-sandbox', '--ozone-platform=wayland', '--enable-unsafe-webgpu', '--disable-background-timer-throttling', '--disable-renderer-backgrounding'],
    env: { ...process.env, XDG_RUNTIME_DIR: host, WAYLAND_DISPLAY: 'browser-host' } });
  const context = await browser.newContext({ viewport: { width: 1450, height: 1050 } });
  await context.addInitScript(codec => {
    localStorage.setItem('elsewhere.codec', codec);
    localStorage.setItem('elsewhere.transport', 'websocket');
    const probe = window.probe = { outputs: 0, errors: [], packets: 0, paints: 0, gpuReads: 0, dimensions: [] };
    addEventListener('error', e => probe.errors.push(e.message));
    addEventListener('unhandledrejection', e => probe.errors.push(String(e.reason)));
    const Decoder = VideoDecoder;
    window.VideoDecoder = class extends Decoder {
      constructor(init) {
        super({ ...init, output(frame) {
          probe.outputs++;
          probe.dimensions = [frame.codedWidth, frame.codedHeight, frame.displayWidth, frame.displayHeight];
          probe.visible = { x: frame.visibleRect.x, y: frame.visibleRect.y, width: frame.visibleRect.width, height: frame.visibleRect.height };
          init.output(frame);
        } });
      }
    };
    const draw = CanvasRenderingContext2D.prototype.drawImage;
    CanvasRenderingContext2D.prototype.drawImage = function (...args) {
      const result = draw.apply(this, args);
      if (this.canvas.matches?.('canvas.stage')) {
        probe.paints++;
        probe.painted = [args[0].displayWidth, args[0].displayHeight];
      }
      return result;
    };
    const Peer = RTCPeerConnection;
    window.RTCPeerConnection = class extends Peer {
      createDataChannel(...args) {
        const channel = super.createDataChannel(...args);
        channel.addEventListener('message', () => probe.packets++);
        return channel;
      }
    };
    const Socket = WebSocket;
    window.WebSocket = class extends Socket { constructor(...args) { super(...args); probe.socket = this; } };
      if (window.GPUDevice) {
        const configure = GPUCanvasContext.prototype.configure,
          texture = GPUCanvasContext.prototype.getCurrentTexture;
        GPUCanvasContext.prototype.configure = function (config) {
          probe.device = config.device;
          probe.format = config.format;
          config.device.addEventListener('uncapturederror', (e) => probe.errors.push(e.error.message));
          return configure.call(this, {
            ...config,
            usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC
          });
        };
        GPUCanvasContext.prototype.getCurrentTexture = function () {
          return (probe.texture = texture.call(this));
        };
        const imp = GPUDevice.prototype.importExternalTexture;
        GPUDevice.prototype.importExternalTexture = function (d) {
          probe.painted = [d.source.displayWidth, d.source.displayHeight];
          return imp.call(this, d);
        };
        const submit = GPUQueue.prototype.submit;
        GPUQueue.prototype.submit = function (commands) {
          submit.call(this, commands);
          if (!probe.texture) return;
          const device = probe.device,
            texture = probe.texture,
            width = texture.width,
            height = texture.height,
            row = Math.ceil((width * 4) / 256) * 256;
          const buffer = device.createBuffer({
              size: row * height,
              usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ
            }),
            encoder = device.createCommandEncoder();
          encoder.copyTextureToBuffer({ texture }, { buffer, bytesPerRow: row }, [width, height]);
          submit.call(this, [encoder.finish()]);
          buffer
            .mapAsync(GPUMapMode.READ)
            .then(() => {
              const pixels = new Uint8Array(buffer.getMappedRange());
              probe.gpuColors = [
                [0.5, 0],
                [0, 0.5],
                [1, 0.5],
                [0.5, 1]
              ].map(([x, y]) => {
                const p =
                    Math.min(height - 1, Math.floor(y * height)) * row + Math.min(width - 1, Math.floor(x * width)) * 4,
                  c = [...pixels.slice(p, p + 4)];
                return probe.format.startsWith('bgra') ? [c[2], c[1], c[0], c[3]] : c;
              });
              probe.gpuReads++;
              buffer.unmap();
              buffer.destroy();
            })
            .catch((e) => probe.errors.push(e.message));
        };
      }
  }, codec);
  const main = await context.newPage();
  await main.goto(origin + '/#token=' + token);
  await main.waitForFunction(() => elsewhere.store.get().stats.frames > 0);
  await main.evaluate(cmd => elsewhere.spawn(cmd), root + '/client ' + root + '/command');
  await main.waitForFunction(() => elsewhere.store.get().windows.some(w => w.app_id === 'thumbnail-surfaces'));
  const id = await main.evaluate(() => elsewhere.store.get().windows.find(w => w.app_id === 'thumbnail-surfaces').id);
  async function capture(page, name, size = null) {
    await page.waitForFunction(() => window.elsewhere?.store.get().stats.frames > 0);
    const before = await page.evaluate(() => {
      const before = probe.paints + probe.gpuReads;
      probe.socket.send(new Uint8Array([0x88]));
      return before;
    });
    await page.waitForFunction(before => probe.paints + probe.gpuReads > before, before);
    const result = await page.evaluate(() => {
      const canvas = document.querySelector('canvas.stage'), state = elsewhere.store.get();
      let colors = probe.gpuColors;
      if (state.renderer !== 'webgpu') {
        const ctx = canvas.getContext('2d');
        colors = [[.5, 0], [0, .5], [1, .5], [.5, 1]].map(([x, y]) => [...ctx.getImageData(
          Math.min(canvas.width - 1, Math.floor(x * canvas.width)), Math.min(canvas.height - 1, Math.floor(y * canvas.height)), 1, 1).data]);
      }
      return { canvas: [canvas.width, canvas.height], configured: [state.stream.width, state.stream.height], dimensions: probe.dimensions, visible: probe.visible,
        colors, painted: probe.painted, via: state.videoVia, renderer: state.renderer, codec: state.streamState?.codec, errors: probe.errors, frames: state.stats.frames, packets: probe.packets };
    });
    assert.deepEqual(result.canvas, size ?? result.configured, name);
    assert.equal(result.codec, codec);
    assert.deepEqual(result.errors, [], name);
    // Normalization may crop padded decoder pictures before they reach either renderer.
    assert.deepEqual(result.painted, size ?? result.configured, name + ': normalized picture dimensions');
    for (const [i, expected] of [[255, 0, 0], [0, 0, 255], [255, 0, 255], [255, 255, 0]].entries())
      assert(result.colors[i].slice(0, 3).every((v, c) => Math.abs(v - expected[c]) < 40), `${name}: edge ${i}: ${result.colors[i]}`);
    console.log(JSON.stringify({ name, ...result }));
    return result;
  }
  await main.waitForTimeout(1000);
  await capture(main, 'desktop');
  await main.evaluate(() => elsewhere.setControlsHidden(true));
  await capture(main, 'hidden-controls');
  await main.evaluate(() => elsewhere.setControlsHidden(false));
  async function clickAction(page, body) {
    await page.evaluate(body => {
      document.querySelector('#surface-action')?.remove();
      const button = document.createElement('button'); button.id = 'surface-action'; button.textContent = 'Test action';
      button.onclick = new Function(body); document.body.prepend(button);
    }, body);
    await page.click('#surface-action');
  }
  await clickAction(main, 'elsewhere.fullscreen()');
  await main.waitForFunction(() => !!document.fullscreenElement);
  await capture(main, 'fullscreen');
  await main.evaluate(() => document.exitFullscreen());
  async function pip(parent, target, label) {
    const opened = context.waitForEvent('page');
    await clickAction(parent, `elsewhere.pip.open(${target})`);
    const page = await opened;
    await page.waitForSelector('iframe');
    const child = await (await page.$('iframe')).contentFrame();
    await capture(child, label);
    await child.evaluate(() => elsewhere.setStage(480, 320));
    await child.waitForTimeout(350);
    await capture(child, label + '-resized');
    await parent.evaluate(() => elsewhere.pip.close());
  }
  for (const renderer of ['2d', 'webgpu']) {
    const page = await context.newPage();
    await page.goto(`${origin}/?renderer=${renderer}#token=${token}`);
    assert.equal((await capture(page, 'desktop-' + renderer)).renderer, renderer);
    await page.evaluate(() => elsewhere.setTransport('webrtc'));
    await page.waitForFunction(() => elsewhere.store.get().videoVia === 'webrtc' && probe.packets > 0);
    await capture(page, 'desktop-' + renderer + '-webrtc');
    await pip(page, null, renderer + '-desktop-pip');
    await pip(page, id, renderer + '-window-pip');
    await pip(page, null, renderer + '-desktop-pip-reopened');
    const opened = context.waitForEvent('page');
    await clickAction(page, `window.open('/?window=${id}&renderer=${renderer}', 'surface-popout', 'popup,width=1000,height=800')`);
    const popup = await opened;
    assert.equal((await capture(popup, 'window-popout-' + renderer)).renderer, renderer);
    await pip(popup, id, renderer + '-pip-from-popout');
    await popup.close();
    await page.close();
  }
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  for (const [width, height] of [[1920, 1080], [1264, 870], [1346, 908]]) {
    const response = await fetch(origin + '/api/display', { method: 'PATCH', headers, body: JSON.stringify({ resolution: { mode: 'fixed', width, height } }) });
    assert.equal(response.status, 200, await response.text());
    await main.waitForFunction(size => elsewhere.store.get().stream.width === size[0] && elsewhere.store.get().stream.height === size[1], [width, height]);
    await main.waitForTimeout(500);
    await capture(main, 'resized-desktop', [width, height]);
  }
  const settings = await fetch(origin + '/api/display', { method: 'PATCH', headers, body: JSON.stringify({ kiosk: false }) });
  assert.equal(settings.status, 200);
  await main.evaluate(id => { elsewhere.control({ id, op: 'unmaximize' }); elsewhere.control({ id, op: 'resize', w: 1263, h: 869 }); }, id);
  await main.waitForFunction(id => { const w = elsewhere.store.get().windows.find(w => w.id === id); return w.w === 1263 && w.h === 869; }, id);
  const png = Buffer.from(await (await fetch(`${origin}/api/windows/${id}/snapshot.png`, { headers })).arrayBuffer());
  assert.deepEqual([png.readUInt32BE(16), png.readUInt32BE(20)], [1263, 869], 'native odd-size PNG');
  const odd = await context.newPage();
  await odd.goto(`${origin}/?window=${id}#token=${token}`);
  await odd.waitForFunction(() => elsewhere.store.get().stats.frames > 0);
  assert.deepEqual(await odd.evaluate(() => probe.painted), [1264, 870], 'window stream rounds odd native dimensions to even');
  await main.evaluate(id => elsewhere.control({ id, op: 'resize', w: 1002, h: 706 }), id);
  await odd.waitForFunction(() => elsewhere.store.get().stream.width === 1002 && elsewhere.store.get().stream.height === 706);
  await capture(odd, 'resized-window', [1002, 706]);
  console.log('Odd native window PNG, even encoding and live window resize passed');
  await main.evaluate(cmd => elsewhere.spawn(cmd), `glxinfo -B > ${root}/glx-info`);
  for (let i = 0; i < 100; i++) {
    if ((await readFile(root + '/glx-info', 'utf8').catch(() => '')).includes('OpenGL renderer string:')) break;
    await main.waitForTimeout(50);
  }
  const glx = await readFile(root + '/glx-info', 'utf8');
  assert.match(glx, /direct rendering: Yes/);
  assert.doesNotMatch(glx, /llvmpipe|softpipe/i, 'Xwayland client uses GPU rendering');
  console.log(glx.split('\n').filter(line => /renderer string|vendor string/.test(line)).join('\n'));
  for (const [cmd, title] of [['glxgears -geometry 640x480', 'glxgears'], ['eglgears_wayland', 'EGL Gears']]) {
    const previous = await main.evaluate(() => elsewhere.store.get().windows.map(w => w.id));
    await main.evaluate(cmd => elsewhere.spawn(cmd), cmd);
    await main.waitForFunction(previous => elsewhere.store.get().windows.some(w => !previous.includes(w.id)), previous);
    const client = await main.evaluate(previous => elsewhere.store.get().windows.find(w => !previous.includes(w.id)).id, previous);
    const page = await context.newPage();
    await page.goto(`${origin}/?window=${client}#token=${token}`);
    await page.waitForFunction(() => elsewhere.store.get().stats.frames > 20);
    const first = await page.evaluate(() => document.querySelector('canvas.stage').toDataURL());
    await page.waitForTimeout(1000);
    const second = await page.evaluate(() => document.querySelector('canvas.stage').toDataURL());
    assert.notEqual(first, second, title + ': accelerated client continues drawing');
    const snapshot = Buffer.from(await (await fetch(`${origin}/api/windows/${client}/snapshot.png`, { headers })).arrayBuffer());
    assert(snapshot.length > 2000, title + ': nonempty snapshot');
    assert.equal(await page.evaluate(() => elsewhere.store.get().stats.decodeErrors), 0);
    console.log(title + ': accelerated client video and snapshot passed');
    await page.close();
    await main.evaluate(id => elsewhere.control({ id, op: 'close' }), client);
  }
  if (process.env.ELSEWHERE_TEST_CAPACITY) {
    const clients = [];
    let failed;
    for (let i = 0; i < Number(process.env.ELSEWHERE_TEST_CAPACITY); i++) {
      const page = await context.newPage(); clients.push(page);
      await page.goto(`${origin}/#token=${token}`);
      await page.waitForFunction(() => elsewhere.store.get().stats.frames > 0 || elsewhere.store.get().streamState?.status === 'failed');
      if (await page.evaluate(() => elsewhere.store.get().streamState?.status === 'failed')) { failed = page; break; }
    }
    assert(failed, 'configured viewer count must exceed the driver session limit');
    assert.equal(await failed.evaluate(() => probe.socket.readyState), 1, 'exhaustion keeps control socket open');
    const survivor = clients.find(page => page !== failed) ?? main;
    const painted = await survivor.evaluate(() => { const painted = probe.paints; probe.socket.send(new Uint8Array([0x88])); return painted; });
    await survivor.waitForFunction(painted => probe.paints > painted, painted);
    assert.equal(await survivor.evaluate(() => elsewhere.store.get().streamState.status), 'streaming');
    for (const page of clients) if (page !== failed) await page.close();
    await failed.evaluate(codec => elsewhere.setChoice({ codec }), codec);
    await failed.waitForFunction(() => elsewhere.store.get().stats.frames > 0);
    console.log('NVENC capacity exhaustion and retry after releasing sessions passed');
  }
  await context.close();
  console.log('GPU surface artifacts:', root);
} finally {
  await browser?.close();
  for (const child of children.reverse()) {
    if (child.exitCode !== null || child.signalCode !== null) continue;
    child.kill('SIGTERM');
    await new Promise(resolve => child.once('exit', resolve));
  }
  await Promise.all(logs.map(log => log.close()));
}
