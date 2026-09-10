// Exercise the emitted Wave.js renderer with real Web Audio and deterministic scheduling in Docker.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, readdir } from 'node:fs/promises';
import { chromium, firefox } from 'playwright-core';
import { Lines, Wave } from '@foobar404/wave';

for (const length of [0, 1, 2, 8, 64]) for (const count of [1, 2, 4, 128, 256, 1000]) for (const value of [.75, NaN, -1, 2]) {
  const points = [], canvas = { canvas: { width: 640, height: 480 }, beginPath() {}, closePath() {}, stroke() {}, fill() {},
    moveTo(x, y) { points.push([x, y]); }, lineTo(x, y) { points.push([x, y]); } };
  const data = new Float32Array(length).fill(value);
  for (const animation of [new Lines({ count }), new Lines({ count, radial: true }), new Wave({ count })]) animation.draw(data, canvas);
  assert(points.every(([x, y]) => Number.isFinite(x) && Number.isFinite(y) && x >= 0 && x <= 640 && y >= 0 && y <= 480), 'bounded small-array geometry');
}


const dist = new URL('../dist/', import.meta.url);
const chunk = (await readdir(new URL('assets/', dist))).find(name => /^visualiser-.*\.js$/.test(name));
const server = createServer(async (req, res) => {
  if (req.url === '/') return res.end('<div id="canvas" style="width:640px;height:240px"></div>');
  try { res.setHeader('Content-Type', 'text/javascript'); res.end(await readFile(new URL(req.url.slice(1), dist))); }
  catch { res.writeHead(404).end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const browser = process.env.BROWSER === 'firefox'
  ? await firefox.launch({ firefoxUserPrefs: { 'media.autoplay.default': 0, 'media.autoplay.block-webaudio': false } })
  : await chromium.launch({ executablePath: '/usr/bin/chromium', args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required'] });
try {
  const page = await browser.newPage({ deviceScaleFactor: 2 });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.evaluate(async chunk => {
    window.module = await import('/assets/' + chunk);
    const p = window.probe = { frames: 0, reads: 0, callbacks: 0, edges: [], points: [], failures: [], observers: 0, listeners: [], captures: 0 };
    const add = EventTarget.prototype.addEventListener, remove = EventTarget.prototype.removeEventListener;
    EventTarget.prototype.addEventListener = function (type, fn, ...args) {
      if (['statechange', 'visibilitychange', 'pagehide', 'resize'].includes(type)) p.listeners.push([this, type, fn]);
      return add.call(this, type, fn, ...args);
    };
    EventTarget.prototype.removeEventListener = function (type, fn, ...args) {
      p.listeners = p.listeners.filter(([target, event, listener]) => target !== this || event !== type || listener !== fn);
      return remove.call(this, type, fn, ...args);
    };
    navigator.mediaDevices.getUserMedia = () => { p.captures++; throw Error('Unexpected capture request'); };
    const connect = AudioNode.prototype.connect, disconnect = AudioNode.prototype.disconnect;
    AudioNode.prototype.connect = function (to, ...args) { const value = connect.call(this, to, ...args); p.edges.push([this, to]); return value; };
    AudioNode.prototype.disconnect = function (...args) {
      p.edges = p.edges.filter(([from, to]) => from !== this || (args.length && to !== args[0]));
      return disconnect.apply(this, args);
    };
    const read = AnalyserNode.prototype.getByteFrequencyData;
    AnalyserNode.prototype.getByteFrequencyData = function (data) { p.reads++; return read.call(this, data); };
    const raf = requestAnimationFrame;
    window.requestAnimationFrame = fn => raf(time => { p.callbacks++; fn(time); });
    const Observer = ResizeObserver;
    window.ResizeObserver = class extends Observer {
      constructor(fn) { super(fn); p.observers++; }
      disconnect() { p.observers--; return super.disconnect(); }
    };
    const fill = CanvasRenderingContext2D.prototype.fillRect;
    CanvasRenderingContext2D.prototype.fillRect = function (...args) { p.frames++; p.points = []; return fill.apply(this, args); };
    for (const name of ['moveTo', 'lineTo']) {
      const original = CanvasRenderingContext2D.prototype[name];
      CanvasRenderingContext2D.prototype[name] = function (x, y) {
        if (!Number.isFinite(x) || !Number.isFinite(y)) throw Error('Non-finite geometry');
        p.points.push([name, x, y]); return original.call(this, x, y);
      };
    }
    const context = new AudioContext({ sampleRate: 48000 }); await context.resume();
    const source = context.createAnalyser(); source.fftSize = 1024; source.smoothingTimeConstant = .321;
    source.minDecibels = -85; source.maxDecibels = -10; source.connect(context.destination);
    const merger = context.createChannelMerger(2), gains = [], oscillators = [];
    for (let i = 0; i < 2; i++) {
      const gain = context.createGain(), oscillator = context.createOscillator();
      gain.gain.value = i ? 0 : .1;
      oscillator.frequency.value = 80; oscillator.connect(gain); gain.connect(merger, 0, i); oscillator.start();
      gains.push(gain); oscillators.push(oscillator);
    }
    merger.connect(source);
    window.audio = { context, source, gains, oscillators };
    window.make = () => module.createVisualiser(document.getElementById('canvas'), { context, source, onError: error => p.failures.push(error.message) });
    window.renderer = make();
    window.initialEdges = p.edges.length - 3;
  }, chunk);
  // A new renderer is paused, with no source branch, analysis or recurring callbacks.
  await page.waitForTimeout(100);
  assert.deepEqual(await page.evaluate(() => [probe.frames, probe.reads, probe.callbacks]), [0, 0, 0]);
  const baselineEdges = await page.evaluate(() => probe.edges.filter(([from]) => from === audio.source).length);
  assert.equal(baselineEdges, 1);
  await page.evaluate(() => renderer.pause(false));
  await page.waitForFunction(() => probe.frames > 2 && probe.points.length > 0);
  assert.deepEqual(await page.evaluate(() => [audio.source.fftSize, audio.source.smoothingTimeConstant, audio.source.minDecibels, audio.source.maxDecibels]), [1024, .321, -85, -10]);
  assert.equal(await page.evaluate(() => probe.edges.filter(([from, to]) => to === audio.context.destination).length), 1);
  assert.equal(await page.locator('canvas').evaluate(canvas => canvas.width), 1280);
  for (const style of ['bars', 'line', 'radial', 'stereo']) {
    const images = [];
    for (const palette of ['classic', 'rainbow', 'steelblue']) {
      for (const frequency of [80, 1000, 8000]) {
        const before = await page.evaluate(({ style, palette, frequency }) => {
          renderer.style(style, palette);
          audio.gains[0].gain.value = .1; audio.gains[1].gain.value = 0;
          audio.oscillators[0].frequency.value = frequency;
          return probe.frames;
        }, { style, palette, frequency });
        await page.waitForFunction(({ style, frequency, before }) => {
          if (probe.frames <= before + 2 || !probe.points.length) return false;
          const canvas = document.querySelector('canvas'), width = canvas.width, height = canvas.height;
          let strongest = -1, position = 0;
          for (const [kind, x, y] of probe.points) {
            if (kind !== 'lineTo') continue;
            if (style === 'stereo' && x > width / 2) continue;
            const strength = style === 'radial' ? Math.hypot(x - width / 2, y - height / 2) - Math.min(width, height) * .18 : height - y;
            if (strength > strongest) {
              strongest = strength;
              position = style === 'radial' ? ((Math.atan2(y - height / 2, x - width / 2) + Math.PI / 2 + Math.PI * 2) % (Math.PI * 2)) / (Math.PI * 2)
                : x / (style === 'stereo' ? (width - 16) / 2 : width);
            }
          }
          const span = style === 'radial' ? Math.min(width, height) * .28 : height * .95;
          return strongest > span * .21 && Math.abs(position - Math.log(frequency / 20) / Math.log(1000)) < .07;
        }, { style, frequency, before });
      }
      images.push(await page.locator('canvas').evaluate(canvas => canvas.toDataURL()));
    }
    assert.equal(new Set(images).size, 3, `${style} palettes produce distinct images`);
  }
  await page.evaluate(() => { renderer.style('stereo', 'classic'); audio.gains[0].gain.value = 0; audio.gains[1].gain.value = .1; audio.oscillators[1].frequency.value = 1000; });
  const separation = right => page.waitForFunction(right => {
    const canvas = document.querySelector('canvas'), peaks = [0, 0];
    for (const [kind, x, y] of probe.points) if (kind === 'lineTo') {
      const channel = x < canvas.width / 2 ? 0 : 1;
      peaks[channel] = Math.max(peaks[channel], canvas.height - y);
    }
    return peaks[right ? 1 : 0] > canvas.height * .3 && peaks[right ? 0 : 1] < canvas.height * .02;
  }, right);
  await separation(true);
  await page.evaluate(() => { audio.gains[0].gain.value = .1; audio.gains[1].gain.value = 0; });
  await separation(false);
  await page.evaluate(() => { audio.source.channelCount = 1; audio.source.channelCountMode = 'explicit'; });
  await page.waitForFunction(() => {
    const width = document.querySelector('canvas').width, peaks = [0, 0];
    for (const [kind, x, y] of probe.points) if (kind === 'lineTo') peaks[x < width / 2 ? 0 : 1] = Math.max(peaks[x < width / 2 ? 0 : 1], 480 - y);
    return peaks[0] > 150 && Math.abs(peaks[0] - peaks[1]) < 1;
  });
  await page.evaluate(() => audio.gains.forEach(gain => gain.gain.value = 0));
  await page.waitForFunction(() => probe.points.length === 0);
  const active = await page.evaluate(() => ({ ...probe, edges: undefined, points: undefined, listeners: undefined }));
  await page.waitForTimeout(1000);
  const rate = await page.evaluate(before => ({ frames: probe.frames - before.frames, reads: probe.reads - before.reads, callbacks: probe.callbacks - before.callbacks }), active);
  assert(rate.frames > 15 && rate.frames <= 31 && rate.reads === rate.frames * 2, JSON.stringify(rate));
  await page.evaluate(() => { document.getElementById('canvas').style.width = '0px'; });
  await page.waitForFunction(() => document.querySelector('canvas').width === 0 && probe.edges.filter(([from]) => from === audio.source).length === 1);
  const zeroSized = await page.evaluate(() => [probe.frames, probe.reads, probe.callbacks]);
  await page.waitForTimeout(150);
  assert.deepEqual(await page.evaluate(() => [probe.frames, probe.reads, probe.callbacks]), zeroSized);
  await page.evaluate(() => { document.getElementById('canvas').style.width = '640px'; });
  await page.waitForFunction(before => probe.frames > before, zeroSized[0]);
  await page.evaluate(() => { renderer.pause(true); renderer.pause(true); });
  await page.evaluate(() => {
    Object.defineProperty(window, 'devicePixelRatio', { configurable: true, value: 1 });
    dispatchEvent(new Event('resize'));
  });
  assert.equal(await page.locator('canvas').evaluate(canvas => canvas.width), 640, 'owner pixel-ratio change resizes backing canvas');
  const paused = await page.evaluate(() => [probe.frames, probe.reads, probe.callbacks]);
  await page.waitForTimeout(150);
  assert.deepEqual(await page.evaluate(() => [probe.frames, probe.reads, probe.callbacks]), paused);
  assert.equal(await page.evaluate(() => probe.edges.filter(([from]) => from === audio.source).length), 1);
  await page.evaluate(() => { renderer.dispose(); renderer.dispose(); });
  assert.equal(await page.locator('canvas').count(), 0);
  assert.equal(await page.evaluate(() => probe.observers), 0);
  // A 144 Hz display still gets at most 30 draws/second. Cancelled callbacks cannot restart a paused loop.
  const highRefresh = await page.evaluate(() => {
    let next = 0; const pending = new Map();
    window.requestAnimationFrame = fn => { pending.set(++next, fn); return next; };
    window.cancelAnimationFrame = id => pending.delete(id);
    renderer = make(); renderer.pause(false);
    const before = { frames: probe.frames, reads: probe.reads }, start = performance.now();
    for (let i = 0; i < 288; i++) {
      const callbacks = [...pending.values()]; pending.clear();
      callbacks.forEach(fn => fn(start + i * 1000 / 144));
    }
    const result = { frames: probe.frames - before.frames, reads: probe.reads - before.reads };
    const stale = [...pending.values()]; renderer.pause(true);
    const stopped = probe.reads; stale.forEach(fn => fn(start + 3000));
    result.stopped = probe.reads === stopped && pending.size === 0;
    renderer.dispose();
    return result;
  });
  assert(highRefresh.frames >= 58 && highRefresh.frames <= 61 && highRefresh.reads === highRefresh.frames * 2 && highRefresh.stopped, JSON.stringify(highRefresh));
  const teardown = await page.evaluate(() => {
    let queued;
    window.requestAnimationFrame = fn => { queued = fn; return 1; };
    window.cancelAnimationFrame = () => { throw Error('Injected cancellation failure'); };
    renderer = make(); renderer.pause(false);
    const reads = probe.reads;
    renderer.dispose();
    queued(performance.now() + 100);
    return { stopped: probe.reads === reads, observers: probe.observers, edges: probe.edges.filter(([from]) => from === audio.source).length };
  });
  assert.deepEqual(teardown, { stopped: true, observers: 0, edges: 1 });
  const failure = await page.evaluate(() => {
    let queued; window.requestAnimationFrame = fn => { queued = fn; return 1; }; window.cancelAnimationFrame = () => { queued = null; };
    renderer = make(); renderer.pause(false);
    const stroke = CanvasRenderingContext2D.prototype.stroke;
    CanvasRenderingContext2D.prototype.stroke = () => { throw Error('Injected draw failure'); };
    const run = queued; queued = null; run(performance.now() + 100);
    CanvasRenderingContext2D.prototype.stroke = stroke;
    return { failures: probe.failures, canvases: document.querySelectorAll('canvas').length, pending: !!queued, observers: probe.observers,
      edges: probe.edges.filter(([from]) => from === audio.source).length, state: audio.context.state };
  });
  assert.deepEqual(failure, { failures: ['Injected draw failure'], canvases: 0, pending: false, observers: 0, edges: 1, state: 'running' });
  await page.evaluate(() => {
    for (let i = 0; i < 20; i++) { const instance = make(); instance.style('line', 'rainbow'); instance.pause(false); instance.dispose(); }
    const create = audio.context.createAnalyser;
    let creations = 0;
    audio.context.createAnalyser = function () { if (++creations === 2) throw Error('Injected setup failure'); return create.call(this); };
    try { make(); throw Error('Setup unexpectedly succeeded'); } catch (error) { if (error.message !== 'Injected setup failure') throw error; }
    audio.context.createAnalyser = create;
  });
  assert.equal(await page.evaluate(() => probe.observers), 0);
  assert.equal(await page.evaluate(() => probe.edges.length === initialEdges), true, 'all owned graph edges released after partial setup and repeated disposal');
  assert.equal(await page.locator('canvas').count(), 0);
  assert.equal(await page.evaluate(() => probe.edges.filter(([from]) => from === audio.source).length), 1);
  assert.deepEqual(await page.evaluate(() => [probe.listeners.length, probe.captures]), [0, 0], 'owned listeners released without capture');
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ browser: process.env.BROWSER || 'chromium', rate, highRefresh, failure }));
  console.log('Wave frequency plots, three palettes, true stereo, mono, silence, HiDPI, graph ownership, pause, high refresh, setup/draw failures and repeated disposal passed');
} finally { await browser.close(); server.close(); }
