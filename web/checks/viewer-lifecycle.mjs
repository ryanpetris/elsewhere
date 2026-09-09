import { createToken } from './token-fixture.mjs';
// Run in Docker with the release build, Chromium and Wayland development tools.
// --colors checks decoded charts only; ELSEWHERE_SOFTWARE_ENCODING retains GPU rendering.
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, open, readFile, readdir, readlink, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright-core';

const root = await mkdtemp('/tmp/elsewhere-viewer-lifecycle-');
const renderNode = process.env.ELSEWHERE_RENDER_NODE ?? 'none';
const codec = renderNode === 'none' || process.env.ELSEWHERE_SOFTWARE_ENCODING ? 'vp8' : 'h264';
const colorsOnly = process.argv.includes('--colors');
const origin = 'http://127.0.0.1:8850';
await mkdir(root + '/runtime', { mode: 0o700 });
const log = await open(root + '/server.log', 'w');
const xml = '/usr/share/wayland-protocols/stable/xdg-shell/xdg-shell.xml';
execFileSync('wayland-scanner', ['client-header', xml, root + '/xdg-shell-client-protocol.h']);
execFileSync('wayland-scanner', ['private-code', xml, root + '/xdg-shell-protocol.c']);
execFileSync('cc', ['-I' + root, '/src/crates/elsewhere-compositor/checks/thumbnail-client.c', root + '/xdg-shell-protocol.c', '-lwayland-client', '-o', root + '/source']);
const environment = { ...process.env, XDG_CONFIG_HOME: root + '/config', XDG_RUNTIME_DIR: root + '/runtime' };
const server = spawn(process.env.ELSEWHERE_BINARY ?? '/src/target/release/elsewhere', [
  '--no-audio', '--no-rtc', '--no-tls', '--render-node', renderNode, '--codec', codec,
  ...(process.env.ELSEWHERE_SOFTWARE_ENCODING ? ['--software-encoding'] : []),
  '--listen', '127.0.0.1:8850', '--socket-name', 'wayland-lifecycle',
], { env: environment, stdio: ['ignore', log.fd, log.fd] });
const clients = new Set();
const counters = async () => {
  const [fds, threads, status] = await Promise.all([
    readdir(`/proc/${server.pid}/fd`), readdir(`/proc/${server.pid}/task`), readFile(`/proc/${server.pid}/status`, 'utf8'),
  ]);
  const targets = await Promise.all(fds.map(id => readlink(`/proc/${server.pid}/fd/${id}`).catch(() => 'closed')));
  const sockets = new Set(targets.map(target => /^socket:\[(\d+)\]$/.exec(target)?.[1]).filter(Boolean));
  const httpConnections = (await readFile(`/proc/${server.pid}/net/tcp`, 'utf8')).trim().split('\n').slice(1)
    .map(line => line.trim().split(/\s+/))
    .filter(row => sockets.has(row[9]) && parseInt(row[1].split(':')[1], 16) === Number(new URL(origin).port) && row[3] !== '0A').length;
  return { fds: fds.length, httpConnections, dmaBufFds: targets.filter(target => target.startsWith('/dmabuf:')).length, threads: threads.length, rssKiB: Number(/^VmRSS:\s+(\d+)/m.exec(status)[1]) };
};
const resourceDetails = async () => ({
  fds: await Promise.all((await readdir(`/proc/${server.pid}/fd`)).map(async id => {
    const target = await readlink(`/proc/${server.pid}/fd/${id}`).catch(() => 'closed');
    return [id, target, target.startsWith('/dmabuf:') ? await readFile(`/proc/${server.pid}/fdinfo/${id}`, 'utf8').catch(() => 'closed') : null];
  })),
  threads: await Promise.all((await readdir(`/proc/${server.pid}/task`)).map(async id => [id, (await readFile(`/proc/${server.pid}/task/${id}/comm`, 'utf8').catch(() => 'closed')).trim()])),
});
const wait = async predicate => {
  for (let n = 0; n < 200; n++) { if (await predicate()) return; await new Promise(resolve => setTimeout(resolve, 50)); }
  throw new Error('viewer lifecycle condition timed out');
};
const stop = async child => {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise(resolve => child.once('exit', resolve));
  let timedOut = false;
  child.kill('SIGTERM');
  const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, 5000);
  await exited; clearTimeout(timer);
  assert(!timedOut, 'child shutdown exceeded five seconds');
};
let browser;
const samples = [];
try {
  await wait(async () => { try { return (await fetch(origin)).ok; } catch { return false; } });
  const token = await createToken(root);
  const viewerToken = await createToken(root, ['desktop.view', 'audio.listen', 'clipboard.read']);
  browser = await chromium.launch({ executablePath: '/usr/bin/chromium', args: ['--no-sandbox'] });
  const errors = [];
  const connect = async (id, quality = 'high', readOnly = false) => {
    const context = await browser.newContext({ viewport: { width: 800, height: 600 } });
    await context.addInitScript(({ codec, quality }) => {
      localStorage.setItem('elsewhere.codec', codec); localStorage.setItem('elsewhere.quality', quality);
      const Socket = WebSocket;
      window.lifecycleReport = () => Socket.prototype.send.call(lifecycleSocket, new Uint8Array([0x96, 200, 0, 0, 0]));
      window.WebSocket = class extends Socket {
        constructor(...args) { super(...args); window.lifecycleSocket = this; }
        send(data) { if (new Uint8Array(data)[0] !== 0x96) super.send(data); }
      };
    }, { codec, quality });
    const page = await context.newPage();
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(`${origin}/${id ? '?window=' + id : ''}#token=${readOnly ? viewerToken : token}`);
    await page.waitForFunction(() => elsewhere.store.get().stats.frames > 0 && !elsewhere.store.get().streamState?.effort.pending);
    return page;
  };
  const paintedColor = (page, painted, wanted) => page.waitForFunction(({ painted, wanted }) => {
    const canvas = document.querySelector('canvas'), pixel = document.createElement('canvas');
    pixel.width = pixel.height = 1;
    const context = pixel.getContext('2d');
    context.drawImage(canvas, canvas.width / 2, canvas.height / 2, 1, 1, 0, 0, 1, 1);
    const rgb = context.getImageData(0, 0, 1, 1).data;
    return elsewhere.store.get().stats.frames > painted && wanted.every((value, index) => Math.abs(rgb[index] - value) < 12);
  }, { painted, wanted }).catch(async error => {
    console.error('static picture failed', await page.evaluate(() => {
      const canvas = document.querySelector('canvas'), pixel = document.createElement('canvas');
      pixel.width = pixel.height = 1;
      const context = pixel.getContext('2d');
      context.drawImage(canvas, canvas.width / 2, canvas.height / 2, 1, 1, 0, 0, 1, 1);
      const state = elsewhere.store.get();
      return { pixel: [...context.getImageData(0, 0, 1, 1).data], stats: state.stats, stream: state.stream, state: state.streamState, role: state.role, status: state.status, awaitingKey: elsewhere().awaitingKey };
    }));
    throw error;
  });
  const main = await connect();
  if (colorsOnly) {
    const command = root + '/color-picture';
    const child = spawn(root + '/source', [command], { env: { ...environment, WAYLAND_DISPLAY: 'wayland-lifecycle' }, stdio: 'ignore' });
    clients.add(child); child.once('exit', () => clients.delete(child));
    await main.waitForFunction(() => elsewhere.store.get().windows.length === 1);
    const id = await main.evaluate(() => elsewhere.store.get().windows[0].id);
    const windowPage = await connect(id);
    await main.evaluate(id => elsewhere.control({ id, op: 'resize', w: 400, h: 300 }), id);
    await main.waitForFunction(() => { const window = elsewhere.store.get().windows[0]; return window.w === 400 && window.h === 300; });
    await windowPage.waitForFunction(() => { const stream = elsewhere.store.get().stream; return stream.width === 400 && stream.height === 300; });
    const geometry = await main.evaluate(() => elsewhere.store.get().windows[0]);
    const desktop = await main.evaluate(() => { const stream = elsewhere.store.get().stream; return { width: stream.width / stream.scale, height: stream.height / stream.scale }; });
    assert(geometry.x >= 0 && geometry.y >= 0 && geometry.x + geometry.w <= desktop.width && geometry.y + geometry.h <= desktop.height, 'chart fits in the desktop');
    const patches = [[255, 0, 0], [0, 255, 0], [0, 0, 255], [0, 0, 0], [64, 64, 64], [128, 128, 128], [192, 192, 192], [255, 255, 255]];
    const points = patches.map((expected, index) => ({ x: Math.floor((index + .5) * geometry.w / 8), y: Math.floor(geometry.h / 4), expected }));
    for (let index = 1; index < 16; index++) {
      const x = Math.floor(index * (geometry.w - 1) / 16), gray = Math.floor(x * 255 / (geometry.w - 1));
      points.push({ x, y: Math.floor(geometry.h * .75), expected: [gray, gray, gray] });
    }
    const checkPicture = async (text, points) => {
      const before = await Promise.all([main, windowPage].map(page => page.evaluate(() => elsewhere.store.get().stats.frames)));
      const revision = await main.evaluate(() => elsewhere.store.get().windows[0].content_revision);
      await writeFile(command, text);
      await main.waitForFunction(revision => elsewhere.store.get().windows[0].content_revision > revision, revision);
      for (const [index, page] of [main, windowPage].entries()) {
        let reference;
        await wait(async () => {
          reference = await page.evaluate(async ({ id, geometry, points }) => {
            const bitmap = await createImageBitmap(await elsewhere.snapshot(id));
            const canvas = document.createElement('canvas'); canvas.width = bitmap.width; canvas.height = bitmap.height;
            const video = document.querySelector('canvas');
            if (video.width !== canvas.width || video.height !== canvas.height) throw new Error('snapshot and decoded canvas dimensions differ');
            const context = canvas.getContext('2d'); context.drawImage(bitmap, 0, 0); bitmap.close();
            const scale = id ? canvas.width / geometry.w : elsewhere.store.get().stream.scale;
            return points.map(point => {
              const x = Math.floor((point.x + (id ? 0 : geometry.x)) * scale), y = Math.floor((point.y + (id ? 0 : geometry.y)) * scale);
              return { x, y, rgb: [...context.getImageData(x, y, 1, 1).data].slice(0, 3), expected: point.expected };
            });
          }, { id: index ? id : null, geometry, points });
          return reference.every(point => !point.expected || point.expected.every((value, channel) => Math.abs(point.rgb[channel] - value) <= 2))
            && (!text.startsWith('sub ') || reference[0].rgb.slice(0, 2).every(value => value > 20 && value < 230));
        }).catch(error => {
          console.error('compositor picture readiness failed', { picture: text, stream: index ? 'window' : 'desktop', geometry, reference });
          throw error;
        });
        for (const point of reference) if (point.expected) assert(point.expected.every((value, channel) => Math.abs(point.rgb[channel] - value) <= 2), 'compositor chart matches the source patches: ' + JSON.stringify({ picture: text, stream: index ? 'window' : 'desktop', geometry, point }));
        if (text.startsWith('sub ')) assert(reference[0].rgb.slice(0, 2).every(value => value > 20 && value < 230), 'transparent green and the red background both contribute');
        await page.waitForFunction(({ before, reference }) => {
          const canvas = document.querySelector('canvas'), scratch = document.createElement('canvas');
          scratch.width = canvas.width; scratch.height = canvas.height;
          const context = scratch.getContext('2d'); context.drawImage(canvas, 0, 0);
          return elsewhere.store.get().stats.frames > before && reference.every(({ x, y, rgb }) => {
            const actual = context.getImageData(x, y, 1, 1).data;
            return rgb.every((value, channel) => Math.abs(actual[channel] - value) <= 12);
          });
        }, { before: before[index], reference });
        console.log(JSON.stringify({ picture: text, stream: index ? 'window' : 'desktop', reference }));
        assert.equal(await page.evaluate(() => elsewhere.store.get().stats.decodeErrors), 0);
      }
    };
    await checkPicture('chart', points);
    await checkPicture('root ffff0000', [{ x: 90, y: 90, expected: [255, 0, 0] }]);
    // Compare composition to the compositor's own PNG, without prescribing its blend transfer curve.
    await checkPicture('sub 80008000', [{ x: 90, y: 90 }, { x: 180, y: 180, expected: [255, 0, 0] }]);
    await windowPage.context().close(); await stop(child);
    console.log('desktop/window primary colors, gray ramp and transparent subsurface match compositor snapshots');
  }
  let baseline, baselineResources, baselineDesktop, baselineDmaSizes;
  for (let cycle = 0; cycle < (colorsOnly ? 0 : 5); cycle++) {
    const viewers = [];
    for (let index = 0; index < 3; index++) {
      const known = await main.evaluate(() => elsewhere.store.get().windows.map(window => window.id));
      const command = `${root}/picture-${cycle}-${index}`;
      const child = spawn(root + '/source', [command], { env: { ...environment, WAYLAND_DISPLAY: 'wayland-lifecycle' }, stdio: 'ignore' });
      clients.add(child); child.once('exit', () => clients.delete(child));
      await main.waitForFunction(known => elsewhere.store.get().windows.some(window => !known.includes(window.id)), known);
      const id = await main.evaluate(known => elsewhere.store.get().windows.find(window => !known.includes(window.id)).id, known);
      const quality = index % 2 ? 'high' : 'very-low';
      const page = await connect(id, quality);
      await page.waitForFunction(cap => elsewhere.store.get().streamState.max_fps === cap, quality === 'very-low' ? 30 : 0);
      viewers.push({ page, child, command, id, quality });
    }
    const observer = await connect(viewers[1].id, 'high', true);
    await observer.waitForFunction(() => elsewhere.store.get().role === 'viewer' && elsewhere.store.get().streamState.bitrate_kbps === 12000);
    const geometry = await main.evaluate(id => { const window = elsewhere.store.get().windows.find(window => window.id === id); return [window.w, window.h]; }, viewers[1].id);
    await observer.evaluate(id => {
      lifecycleSocket.send(new Uint8Array([0x8b, ...new TextEncoder().encode(JSON.stringify({ id, op: 'resize', w: 111, h: 117 }))]));
    }, viewers[1].id);
    await observer.waitForTimeout(250);
    assert.deepEqual(await main.evaluate(id => { const window = elsewhere.store.get().windows.find(window => window.id === id); return [window.w, window.h]; }, viewers[1].id), geometry);
    // Exercise deliberate reports on a settled picture before adding motion and resize load.
    // Automatic browser reports are suppressed by the fixture socket above.
    await observer.waitForTimeout(1200);
    await observer.evaluate(() => elsewhere.setChoice({ quality: 'high' }));
    await observer.waitForFunction(() => elsewhere.store.get().streamState.bitrate_kbps === 12000 && !elsewhere.store.get().streamState.effort.pending);
    const observerPaints = await observer.evaluate(() => elsewhere.store.get().stats.frames);
    await observer.evaluate(() => { window.reportTimer = setInterval(lifecycleReport, 100); });
    try {
      await observer.waitForFunction(() => elsewhere.store.get().streamState.bitrate_kbps < 12000
        && elsewhere.store.get().role === 'viewer', undefined, { timeout: 5000 });
    } finally { await observer.evaluate(() => clearInterval(reportTimer)); }
    const readOnlyTarget = await observer.evaluate(() => elsewhere.store.get().streamState.bitrate_kbps);
    await writeFile(viewers[1].command, 'root ffe08020');
    await paintedColor(observer, observerPaints, [224, 128, 32]);
    for (let frame = 0; frame < 80; frame++) {
      await Promise.all(viewers.map(({ command }) => writeFile(command, frame % 2 ? 'root ffe08020' : 'root ff2040c0')));
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    // Each cycle exercises the same sizes and presets before comparing retained resources.
    for (let step = 0; step < 12; step++) {
      await Promise.all(viewers.map(async ({ page }, index) => {
        await page.setViewportSize({ width: 640 + (step % 3) * 160, height: 480 + ((step + index) % 3) * 80 });
        await page.evaluate(effort => elsewhere.setChoice({ effort }), ['fast', 'balanced', 'high'][step % 3]);
      }));
      await new Promise(resolve => setTimeout(resolve, 80));
    }
    for (const { page, command, quality } of viewers) {
      await page.waitForFunction(({ quality, cap }) => elsewhere.store.get().streamState.preset === quality
        && elsewhere.store.get().streamState.max_fps === cap && elsewhere.store.get().streamState.effort.requested === 'high'
        && !elsewhere.store.get().streamState.effort.pending && !elsewhere().awaitingKey,
      { quality, cap: quality === 'very-low' ? 30 : 0 });
      const painted = await page.evaluate(() => elsewhere.store.get().stats.frames);
      await writeFile(command, 'root ff20c080');
      await paintedColor(page, painted, [32, 192, 128]);
      assert.equal(await page.evaluate(() => elsewhere.store.get().stats.decodeErrors), 0);
    }
    const active = await counters();
    if (baseline) assert(active.threads >= baseline.threads + viewers.length + 1, 'each window viewer has a live media worker');
    // Close viewers and source windows together while teardown still has media work to cancel.
    await Promise.all(viewers.map(({ page }) => page.evaluate(() => elsewhere.setChoice({ effort: 'fast' }))));
    await Promise.all([observer.context().close(), ...viewers.flatMap(({ page, child }) => [page.context().close(), stop(child)])]);
    await main.waitForFunction(() => elsewhere.store.get().windows.length === 0);
    // The live desktop retains up to four lazily allocated swapchain buffers.
    if (baseline) await wait(async () => {
      const current = await counters();
      // The remaining page's HTTP keep-alive sockets vary; bound them separately from media resources.
      return current.fds - current.dmaBufFds - current.httpConnections <= baseline.fds - baseline.dmaBufFds - baseline.httpConnections
        && current.httpConnections <= 3
        && current.dmaBufFds <= (renderNode === 'none' ? 0 : 4) && current.threads <= baseline.threads;
    }).catch(async error => {
      console.error('teardown resources did not return', JSON.stringify({ baseline, current: await counters(), baselineResources, currentResources: await resourceDetails() }, null, 2));
      await main.evaluate(() => lifecycleSocket.send(new Uint8Array([0x88])));
      await main.waitForTimeout(1000);
      console.error('resources after explicit redraw', JSON.stringify({ current: await counters(), resources: await resourceDetails() }, null, 2));
      throw error;
    });
    else await new Promise(resolve => setTimeout(resolve, 1000));
    const idle = await counters();
    baseline ??= idle;
    const resources = await resourceDetails();
    baselineResources ??= resources;
    const dmaBuffers = resources.fds.filter(([, target]) => target.startsWith('/dmabuf:'));
    const desktop = await main.evaluate(() => { const stream = elsewhere.store.get().stream; return { width: stream.width, height: stream.height }; });
    const sizes = dmaBuffers.map(([, , info]) => Number(/^size:\s+(\d+)/m.exec(info)?.[1]));
    assert(sizes.every(size => Number.isSafeInteger(size) && size > 0), 'retained DMA-buf sizes are available');
    baselineDesktop ??= desktop;
    baselineDmaSizes ??= new Set(sizes);
    assert.deepEqual(desktop, baselineDesktop, 'the retained desktop allocation geometry stays fixed');
    assert(sizes.every(size => baselineDmaSizes.has(size)), 'retained DMA-bufs fit the warmed desktop allocation sizes');
    const sample = { cycle, active, idle, readOnlyTarget, desktop, dmaBuffers }; samples.push(sample); console.log(JSON.stringify(sample));
    await writeFile(root + '/results.json', JSON.stringify(samples, null, 2));
    assert(idle.rssKiB <= baseline.rssKiB + 64 * 1024, 'retained RSS grew by more than 64 MiB after warmup: ' + JSON.stringify({ baseline, idle }));
  }
  assert.deepEqual(errors, []);
  if (!colorsOnly) console.log('viewer resize/effort storms, simultaneous 30fps/unlimited streams, read-only pressure feedback, static final pictures and teardown passed');
} finally {
  await browser?.close().catch(() => {});
  await Promise.allSettled([...clients].map(stop));
  try { await stop(server); } finally { await log.close(); }
  console.log('Viewer lifecycle artifacts:', root);
}
