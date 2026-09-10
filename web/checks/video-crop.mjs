// Docker with Chromium, FFmpeg and Xvfb: DISPLAY=:96 TEST_WEBGPU=software npm run check:video-crop
// TEST_WEBGPU=1 uses the system GPU path; software selects SwiftShader for ANGLE and WebGPU.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import { chromium } from 'playwright-core';
import { execFileSync } from 'node:child_process';
import { CONFIG, VIDEO, ROLE, PERMISSIONS, MOTION_ABS, REQUEST_KEYFRAME, AUTH } from '../src/protocol.js';

// Saturated padding surrounds four distinct valid edges. VP8 supplies real decoded frames.
const ivf = execFileSync(
  'ffmpeg',
  [
    '-v',
    'error',
    '-f',
    'lavfi',
    '-i',
    'color=lime:s=1408x912,drawbox=x=0:y=0:w=1346:h=908:color=gray:t=fill,drawbox=x=0:y=0:w=1346:h=8:color=red:t=fill,drawbox=x=0:y=900:w=1346:h=8:color=yellow:t=fill,drawbox=x=0:y=8:w=8:h=892:color=blue:t=fill,drawbox=x=1338:y=8:w=8:h=892:color=magenta:t=fill',
    '-frames:v',
    '1',
    '-c:v',
    'libvpx',
    '-deadline',
    'realtime',
    '-b:v',
    '8M',
    '-f',
    'ivf',
    'pipe:1'
  ],
  { maxBuffer: 10 * 1024 * 1024 }
);
const key = [...ivf.subarray(44, 44 + ivf.readUInt32LE(32))];
const server = http.createServer((req, res) => {
  const path = new URL(req.url, 'http://localhost').pathname.replace(/^\/prefixed(?=\/)/, '');
  if (path.startsWith('/api/')) {
    res.setHeader('Content-Type', 'application/json');
    return res.end(
      JSON.stringify(
        path === '/api/codecs'
          ? [{ codec: 'vp8', hardware: true }]
          : path === '/api/clipboard/state'
            ? { observation: 'fixture:0', operation: null, present: false, mime: null, size: 0, preview: 'empty' }
            : []
      )
    );
  }
  try {
    res.setHeader(
      'Content-Type',
      path.endsWith('.js') ? 'text/javascript' : path.endsWith('.css') ? 'text/css' : 'text/html'
    );
    const body = fs.readFileSync(new URL('../dist/' + (path === '/' ? 'index.html' : path.slice(1)), import.meta.url));
    res.end(path === '/' && req.url.startsWith('/prefixed/') ? body.toString().replace('<base href="/">', '<base href="/prefixed/">') : body);
  } catch {
    res.writeHead(404).end();
  }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const softwareGpu = process.env.TEST_WEBGPU === 'software';
const browser = await chromium.launch({
  executablePath: '/usr/bin/chromium',
  headless: false,
  env: { ...process.env, DISPLAY: process.env.DISPLAY || ':96' },
  args: [
    '--no-sandbox',
    '--enable-unsafe-webgpu',
    ...(softwareGpu ? ['--use-angle=vulkan', '--use-vulkan=swiftshader', '--use-webgpu-adapter=swiftshader'] : ['--use-angle=gl']),
    '--enable-features=Vulkan',
    '--disable-vulkan-surface',
    '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding'
  ]
});
const results = [];
try {
  const context = await browser.newContext({ viewport: { width: 1400, height: 1050 } });
  await context.addInitScript(
    ({ key, tags }) => {
      window.tags = tags;
      const probe = (window.probe = { outputs: 0, draws: 0, imports: 0, errors: [], sent: [], callbacks: [] });
      addEventListener('error', (e) => probe.errors.push(e.message));
      addEventListener('unhandledrejection', (e) => probe.errors.push(String(e.reason)));
      const Decoder = VideoDecoder;
      window.VideoDecoder = class extends Decoder {
        constructor(init) {
          super({
            ...init,
            output: (frame) => {
              probe.outputs++;
              init.output(frame);
            }
          });
          probe.callbacks.push(init.output);
        }
      };
      const draw = CanvasRenderingContext2D.prototype.drawImage;
      CanvasRenderingContext2D.prototype.drawImage = function (...args) {
        const r = draw.apply(this, args);
        if (this.canvas.matches?.('canvas.stage')) probe.draws++;
        return r;
      };
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
          probe.imports++;
          if (probe.retain) probe.retained.push(d.source.clone());
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
              buffer.unmap();
              buffer.destroy();
            })
            .catch((e) => probe.errors.push(e.message));
        };
      }
      window.WebSocket = class {
        static OPEN = 1;
        readyState = 1;
        constructor(url) {
          window.socket = this;
          probe.socketUrl = url;
          queueMicrotask(() => {
            this.onopen?.({});
            this.onmessage?.({
              data: new Uint8Array([
                tags.PERMISSIONS,
                ...new TextEncoder().encode(
                  JSON.stringify(['desktop.view', 'desktop.control', 'clipboard.read', 'clipboard.write'])
                )
              ]).buffer
            });
          });
        }
        send(b) {
          probe.sent.push([...new Uint8Array(b)]);
        }
        close() {}
      };
      let seq = 0,
        streamId = 0;
      probe.configure = (width = 1346, height = 908, scale = 1) => {
        socket.onmessage({ data: new Uint8Array([tags.ROLE, 2, 0, 1, 0, 0, 0, 0, 0, 0, 0]).buffer });
        socket.onmessage({
          data: new Uint8Array([
            tags.CONFIG,
            ...new TextEncoder().encode(
              JSON.stringify({ streamId: ++streamId, attempt: streamId, codec: 'vp8', width, height, scale })
            )
          ]).buffer
        });
      };
      probe.feed = () => {
        const bytes = new Uint8Array(12 + key.length),
          view = new DataView(bytes.buffer);
        bytes[0] = tags.VIDEO;
        bytes[1] = 1;
        view.setUint16(2, seq, true);
        view.setBigUint64(4, BigInt(++seq * 1000), true);
        bytes.set(key, 12);
        socket.onmessage({ data: bytes.buffer });
      };
    },
    { key, tags: { CONFIG, VIDEO, ROLE, PERMISSIONS, MOTION_ABS, REQUEST_KEYFRAME, AUTH } }
  );
  const url = `http://127.0.0.1:${server.address().port}/`;
  const ready = async (frame) => {
    await frame.waitForFunction(() => window.elsewhere?.store && window.socket);
    await frame.evaluate(async () => {
      probe.configure();
      for (let i = 0; i < 20; i++) {
        probe.feed();
        await new Promise((r) => setTimeout(r, 10));
      }
    });
    await frame.waitForFunction(() => probe.outputs >= 20 && probe.draws + probe.imports > 0);
  };
  const capture = async (frame, path) => {
    const r = await frame.evaluate(() => {
      const c = document.querySelector('canvas.stage'),
        s = elsewhere.store.get();
      return {
        renderer: s.renderer,
        canvas: [c.width, c.height],
        outputs: probe.outputs,
        draws: probe.draws,
        imports: probe.imports,
        errors: probe.errors,
        socketPath: new URL(probe.socketUrl).pathname,
        pip: typeof parent.elsewhereReturn === 'function'
      };
    });
    assert.deepEqual(r.canvas, [1346, 908]);
    assert.deepEqual(r.errors, []);
    if (r.renderer === '2d') assert.equal(await frame.evaluate(() => document.querySelector('canvas.stage').getContext('2d').getContextAttributes().alpha), false, 'desktop video stage is opaque');
    // Inspect the presented canvas, including a real WebGPU canvas when requested.
    if (r.renderer === 'webgpu') await frame.waitForFunction(() => probe.gpuColors);
    const colors = await frame.evaluate(async () => {
      if (elsewhere.store.get().renderer === 'webgpu') return probe.gpuColors;
      const bitmap = await createImageBitmap(document.querySelector('canvas.stage'));
      const canvas = new OffscreenCanvas(bitmap.width, bitmap.height),
        ctx = canvas.getContext('2d');
      ctx.drawImage(bitmap, 0, 0);
      bitmap.close();
      return [
        [0.5, 0],
        [0, 0.5],
        [1, 0.5],
        [0.5, 1]
      ].map(([x, y]) => [
        ...ctx.getImageData(
          Math.min(canvas.width - 1, Math.floor(x * canvas.width)),
          Math.min(canvas.height - 1, Math.floor(y * canvas.height)),
          1,
          1
        ).data
      ]);
    });
    for (const [i, expected] of [
      [255, 0, 0],
      [0, 0, 255],
      [255, 0, 255],
      [255, 255, 0]
    ].entries())
      assert(
        colors[i].slice(0, 3).every((v, c) => Math.abs(v - expected[c]) < 40),
        `${path}: edge ${i}: ${colors[i]}`
      );
    results.push({ path, ...r });
    console.log(JSON.stringify(results.at(-1)));
    return r;
  };
  const page = await context.newPage();
  await page.goto(url + '#token=fixture');
  await ready(page);
  await capture(page, 'desktop');
  await page.evaluate(() => elsewhere.setControlsHidden(true));
  await page.waitForTimeout(50);
  await capture(page, 'hidden-controls');
  await page.evaluate(() => elsewhere.setControlsHidden(false));
  await page.evaluate(() => {
    const b = document.createElement('button');
    b.id = 'fullscreen-test';
    b.textContent = 'Fullscreen test';
    b.onclick = () => elsewhere.fullscreen();
    document.body.prepend(b);
  });
  await page.click('#fullscreen-test');
  await page.waitForFunction(() => !!document.fullscreenElement);
  await capture(page, 'fullscreen');
  await page.evaluate(() => document.exitFullscreen());
  await page.evaluate(() => {
    const b = document.createElement('button');
    b.id = 'popup-test';
    b.textContent = 'Popout test';
    b.onclick = () => window.open('/?window=1', 'crop-window', 'popup,width=1000,height=800');
    document.body.prepend(b);
  });
  const popupPromise = context.waitForEvent('page');
  await page.click('#popup-test');
  const popup = await popupPromise;
  await popup.waitForLoadState();
  await ready(popup);
  await capture(popup, 'window-popout');
  await popup.evaluate(() => {
    const b = document.createElement('button');
    b.id = 'window-pip';
    b.textContent = 'Window PiP';
    b.onclick = () => elsewhere.pip.open(1);
    document.body.prepend(b);
  });
  const windowPipPromise = context.waitForEvent('page');
  await popup.click('#window-pip');
  const windowPip = await windowPipPromise;
  await windowPip.waitForSelector('iframe');
  const windowChild = await (await windowPip.$('iframe')).contentFrame();
  await ready(windowChild);
  await capture(windowChild, 'pip-from-window');
  await popup.evaluate(() => elsewhere.pip.close());
  await popup.close();
  for (const target of [null, 1, null]) {
    await page.evaluate((target) => {
      document.querySelector('#pip-test')?.remove();
      const b = document.createElement('button');
      b.id = 'pip-test';
      b.textContent = 'PiP test';
      b.onclick = () => elsewhere.pip.open(target);
      document.body.prepend(b);
    }, target);
    const nextPage = context.waitForEvent('page');
    await page.click('#pip-test');
    const pip = await nextPage;
    await pip.waitForSelector('iframe');
    const child = await (await pip.$('iframe')).contentFrame();
    await ready(child);
    await capture(child, target == null ? 'desktop-document-pip' : 'window-document-pip');
    await child.evaluate(() => elsewhere.setStage(480, 320));
    await capture(child, 'resized-pip');
    await page.evaluate(() => elsewhere.pip.close());
  }
  if (process.env.TEST_WEBGPU) {
    const gpu = await context.newPage();
    await gpu.goto(url + '?renderer=webgpu#token=fixture');
    const adapter = await gpu.evaluate(async () => {
      const adapter = await navigator.gpu?.requestAdapter();
      if (!adapter) return null;
      const { vendor, architecture } = adapter.info;
      return { vendor, architecture };
    });
    console.log(JSON.stringify({ adapter }));
    assert(adapter, 'WebGPU adapter unavailable');
    if (softwareGpu) assert.match(adapter.architecture, /swiftshader/i, 'crop check uses the software WebGPU adapter');
    await ready(gpu);
    const gr = await capture(gpu, 'desktop-webgpu');
    assert.equal(gr.renderer, 'webgpu');
    for (const color of [
      [0, 0, 255, 255],
      [255, 0, 0, 255]
    ]) {
      const before = await gpu.evaluate((color) => {
        probe.retain = true;
        probe.retained ??= [];
        if (probe.retained.length) probe.configure(1264, 870);
        const before = probe.imports;
        const pixels = new Uint8Array(1408 * 912 * 4);
        for (let i = 0; i < pixels.length; i += 4) pixels.set(color, i);
        probe.callbacks.at(-1)(
          new VideoFrame(pixels, { format: 'RGBA', codedWidth: 1408, codedHeight: 912, timestamp: 123, duration: 456 })
        );
        return before;
      }, color);
      await gpu.waitForFunction((before) => probe.imports > before, before);
    }
    const snapshots = await gpu.evaluate(() =>
      probe.retained.map((frame) => {
        const c = new OffscreenCanvas(1, 1),
          ctx = c.getContext('2d');
        ctx.drawImage(frame, 0, 0, 1, 1);
        const value = {
          color: [...ctx.getImageData(0, 0, 1, 1).data],
          timestamp: frame.timestamp,
          duration: frame.duration
        };
        frame.close();
        return value;
      })
    );
    assert.deepEqual(
      snapshots,
      [
        { color: [0, 0, 255, 255], timestamp: 123, duration: 456 },
        { color: [255, 0, 0, 255], timestamp: 123, duration: 456 }
      ],
      'canvas reuse and resize preserve retained RGB snapshots'
    );
  }
  if (process.env.TEST_WEBGPU) for (const blockedStorage of [false, true]) {
    const failed = await context.newPage(), attempts = [];
    await failed.exposeFunction('reportGpuFailure', value => attempts.push(value));
    await failed.addInitScript(blockedStorage => {
      if (blockedStorage) Object.defineProperty(window, 'sessionStorage', { get() { throw Error('Storage unavailable'); } });
      GPUDevice.prototype.createRenderPipeline = function () {
        const stage = document.querySelector('canvas.stage');
        reportGpuFailure({ bound: !!stage.getContext('webgpu'), socket: !!probe.socketUrl, decoders: probe.callbacks.length }).catch(() => {});
        throw Error('Injected pipeline initialization failure');
      };
    }, blockedStorage);
    await failed.goto(url + 'prefixed/?renderer=webgpu&window=1&keep=1#token=fixture');
    await failed.waitForURL(value => !value.searchParams.has('renderer'), { timeout: 5000 });
    const recovered = new URL(failed.url());
    assert.equal(recovered.pathname, '/prefixed/');
    assert.equal(recovered.searchParams.get('window'), '1');
    assert.equal(recovered.searchParams.get('keep'), '1');
    await ready(failed);
    assert.deepEqual(attempts, [{ bound: true, socket: false, decoders: 0 }]);
    const result = await capture(failed, blockedStorage ? 'gpu-init-storage-blocked' : 'gpu-init-recovery');
    assert.equal(result.renderer, '2d');
    assert.equal(result.socketPath, '/prefixed/ws/window/1');
    assert.equal(await failed.evaluate(tag => new TextDecoder().decode(new Uint8Array(probe.sent.find(bytes => bytes[0] === tag).slice(1))), AUTH), 'fixture');
    await failed.close();
  }
  if (process.env.TEST_WEBGPU) {
    const unbound = await context.newPage();
    await unbound.addInitScript(() => {
      navigator.gpu.requestAdapter = async () => { throw Error('Injected adapter request failure'); };
    });
    await unbound.goto(url + '?renderer=webgpu#token=fixture');
    await ready(unbound);
    assert.equal(new URL(unbound.url()).searchParams.get('renderer'), 'webgpu', 'unbound canvas recovers without navigation');
    assert.equal((await capture(unbound, 'gpu-adapter-recovery')).renderer, '2d');
    await unbound.close();
    const disposed = await context.newPage();
    await disposed.addInitScript(() => {
      navigator.gpu.requestAdapter = () => new Promise((resolve, reject) => { window.rejectGpu = reject; });
    });
    await disposed.goto(url + '?renderer=webgpu#token=fixture');
    await disposed.waitForFunction(() => typeof rejectGpu === 'function');
    const before = disposed.url();
    await disposed.evaluate(() => { elsewhere.dispose(); rejectGpu(Error('Delayed GPU initialization failure')); });
    await disposed.waitForTimeout(150);
    assert.equal(disposed.url(), before, 'disposed viewer does not navigate on a late GPU rejection');
    assert.deepEqual(await disposed.evaluate(() => ({ status: elsewhere.store.get().status, socket: !!probe.socketUrl, decoders: probe.callbacks.length, errors: probe.errors })), { status: 'closed', socket: false, decoders: 0, errors: [] });
    await disposed.close();
  }
  for (const [width, height, scale] of [
    [1346, 908, 1.25],
    [1264, 870, 1.5],
    [1280, 720, 2]
  ]) {
    await page.evaluate(
      ({ width, height, scale }) => {
        probe.old = probe.callbacks.at(-1);
        probe.configure(width, height, scale);
        probe.feed();
      },
      { width, height, scale }
    );
    await page.waitForFunction(
      ({ width, height }) => {
        const c = document.querySelector('canvas.stage');
        return c.width === width && c.height === height;
      },
      { width, height }
    );
    const result = await page.evaluate(() => {
      const late = new VideoFrame(new Uint8Array(16), { format: 'RGBA', codedWidth: 2, codedHeight: 2, timestamp: 99 });
      const count = probe.draws,
        keys = probe.sent.filter((b) => b[0] === tags.REQUEST_KEYFRAME).length;
      probe.old(late);
      const newKeys = probe.sent.filter((b) => b[0] === tags.REQUEST_KEYFRAME).length - keys;
      elsewhere.setCaptureOnClick(false);
      const c = document.querySelector('canvas.stage'),
        r = c.getBoundingClientRect();
      c.dispatchEvent(
        new PointerEvent('pointermove', {
          pointerType: 'mouse',
          clientX: r.left + r.width * 0.99,
          clientY: r.top + r.height * 0.99
        })
      );
      const bytes = new Uint8Array(probe.sent.findLast((b) => b[0] === tags.MOTION_ABS)),
        dv = new DataView(bytes.buffer);
      return {
        closed: late.codedWidth === 0,
        painted: probe.draws - count,
        newKeys,
        connected: elsewhere.store.get().status === 'connected',
        x: dv.getFloat32(1, true),
        y: dv.getFloat32(5, true)
      };
    });
    assert(result.closed && !result.painted && !result.newKeys && result.connected, 'stale decoder output closed before geometry check');
    assert(
      Math.abs(result.x - (width / scale) * 0.99) < 0.001 && Math.abs(result.y - (height / scale) * 0.99) < 0.001,
      'edge pointer maps to configured logical pixels'
    );
  }
  const rejected = await page.evaluate(() => {
    const output = probe.callbacks.at(-1),
      requests = probe.sent.filter((b) => b[0] === tags.REQUEST_KEYFRAME).length,
      draws = probe.draws;
    for (let i = 0; i < 3; i++)
      output(new VideoFrame(new Uint8Array(16), { format: 'RGBA', codedWidth: 2, codedHeight: 2, timestamp: i }));
    return {
      status: elsewhere.store.get().status,
      reason: elsewhere.store.get().reason,
      requests: probe.sent.filter((b) => b[0] === tags.REQUEST_KEYFRAME).length - requests,
      draws: probe.draws - draws
    };
  });
  assert.equal(rejected.status, 'error');
  assert.match(rejected.reason, /does not contain/);
  assert.equal(rejected.requests, 0);
  assert.equal(rejected.draws, 0);
  await page.evaluate(() => {
    probe.configure();
    probe.feed();
  });
  await page.waitForFunction(
    () => elsewhere.store.get().status === 'connected' && document.querySelector('canvas.stage').width === 1346
  );
  assert.equal(await page.evaluate(() => elsewhere.store.get().reason), '');
  await context.close();
  console.log(
    'Viewer crop paths and edge landmarks passed; WebGPU: ' +
      (process.env.TEST_WEBGPU ? 'tested' : 'SKIPPED (set TEST_WEBGPU=1 or software)')
  );
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}
