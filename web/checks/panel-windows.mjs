// Run against the built viewer in the Docker image with Node and Chromium.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright-core';
import { MIXER_CLIENT } from '../src/protocol.js';

const dist = new URL('../dist/', import.meta.url);
const server = createServer(async (req, res) => {
  try {
    const path = new URL(req.url, 'http://localhost').pathname.replace(/^\/nested/, '');
    let data = await readFile(new URL(path === '/' ? 'index.html' : path.slice(1), dist));
    if (path === '/') data = Buffer.from(data.toString().replace('<base href="/">', '<base href="/nested/">'));
    res.setHeader('Content-Type', path.endsWith('.js') ? 'text/javascript' : path.endsWith('.css') ? 'text/css' : 'text/html');
    res.end(data);
  } catch { res.writeHead(404).end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
// An externally launched browser exercises real focus/visibility without Playwright's overrides.
const browser = process.env.BROWSER_CDP
  ? await chromium.connectOverCDP(process.env.BROWSER_CDP, { noDefaults: true })
  : await chromium.launch({ executablePath: process.env.CHROMIUM || '/usr/bin/chromium', args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required'] });
const until = async (condition, message) => {
  const deadline = Date.now() + 5000;
  while (!await condition()) { assert(Date.now() < deadline, message); await delay(25); }
};
let context;
try {
  context = process.env.BROWSER_CDP ? browser.contexts()[0] : await browser.newContext({ deviceScaleFactor: 2 });
  context.setDefaultTimeout(5000);
  const errors = [], commands = [];
  let connections = 0;
  context.on('page', page => page.on('pageerror', error => errors.push(error.message)));
  await context.route('**/api/me', route => route.fulfill({ json: { permissions: ['desktop.view', 'desktop.control', 'audio.listen'] } }));
  await context.addInitScript(() => {
    try { sessionStorage.setItem('elsewhere:/nested.token', 'test'); } catch {}
    window.paints = 0;
    const fill = CanvasRenderingContext2D.prototype.fillRect;
    CanvasRenderingContext2D.prototype.fillRect = function (...args) { window.paints++; return fill.apply(this, args); };
    window.edges = [];
    const connect = AudioNode.prototype.connect, disconnect = AudioNode.prototype.disconnect;
    AudioNode.prototype.connect = function (node, ...args) { edges.push([this, node]); return connect.call(this, node, ...args); };
    AudioNode.prototype.disconnect = function (node, ...args) {
      window.edges = edges.filter(([from, to]) => from !== this || (node && to !== node));
      return node ? disconnect.call(this, node, ...args) : disconnect.call(this);
    };
  });
  await context.routeWebSocket('**/ws', socket => {
    connections++;
    socket.onMessage(data => { if (typeof data !== 'string' && data[0] === MIXER_CLIENT) commands.push(JSON.parse(data.subarray(1).toString())); });
  });
  const initialPages = context.pages();
  const page = await context.newPage();
  for (const initial of initialPages) await initial.close();
  const base = `http://127.0.0.1:${server.address().port}/nested/`;
  await page.goto(base);
  await page.waitForFunction(() => !!window.elsewhere?.store);
  await until(() => connections === 1, 'main viewer connects');
  await page.waitForFunction(() => elsewhere.store.get().status === 'connecting');
  await page.evaluate(async () => {
    const context = new AudioContext(); await context.resume();
    const source = context.createAnalyser(), oscillator = context.createOscillator();
    source.connect(context.destination); oscillator.connect(source); oscillator.start();
    window.playback = { context, source, oscillator };
    elsewhere.store.set({ status: 'connected', role: 'controller', permissions: ['desktop.view', 'desktop.control', 'audio.listen'],
      audioAvailable: true, playback: { context, source },
      stats: { ...elsewhere.store.get().stats, audio: { state: 'running', signalPeak: 0.1, packets: 1, decoded: 1, lead: 0, level: 0 } },
      mixer: { available: true, generation: 'test', routing: true, nodes: [
        { id: 'output', name: 'Speakers', kind: 'output', state: 'running', volume: 50, mute: false,
          volume_writable: true, mute_writable: true, routing_writable: true, targets: [], meter_active: true },
      ] },
    });
  });
  const region = (owner, name) => owner.getByRole('region', { name, exact: true });
  const show = async name => {
    assert.equal(errors.length, 0, errors.join('\n'));
    await page.getByRole('button', { name, exact: true }).click();
  };
  const open = async (name, button) => {
    await show(name);
    const pending = page.waitForEvent('popup');
    await page.getByRole('button', { name: button, exact: true }).click();
    const popup = await pending;
    await region(popup, name).waitFor();
    assert.equal(await region(page, name).count(), 0, 'dock closes when popped out');
    return popup;
  };
  const edges = () => page.evaluate(() => window.edges.filter(([from]) => from === playback.source).length);
  let audio = await open('Audio Visualizer', 'Pop Out Visualizer');
  assert.equal(new URL(audio.url()).pathname, '/nested/', 'popout preserves URL prefix');
  await audio.waitForFunction(() => window.paints > 3);
  await until(async () => await edges() === 2, 'one analysis branch and one speaker connection');
  assert.equal(connections, 1, 'popout shares the viewer socket');
  assert.equal(await audio.evaluate(() => typeof window.elsewhere), 'undefined', 'popout does not create a viewer');
  const focusAudio = page.getByRole('button', { name: 'Focus Audio Visualizer Window', exact: true });
  assert.equal(await focusAudio.getAttribute('aria-expanded'), null, 'window focus is not a collapsed-panel action');
  const appearance = () => focusAudio.evaluate(button => {
    const style = getComputedStyle(button);
    return [style.color, style.backgroundColor];
  });
  const activeAppearance = await appearance();
  await focusAudio.hover();
  await delay(200);
  assert.deepEqual(await appearance(), activeAppearance, 'hover preserves the open-window highlight');
  await focusAudio.click();
  assert.equal(context.pages().length, 2, 'status button focuses the existing popout');
  assert.equal(await region(page, 'Audio Visualizer').count(), 0);
  await audio.getByRole('combobox', { name: /^Style/ }).selectOption('radial');
  await audio.getByRole('combobox', { name: /^Colours/ }).selectOption('rainbow');
  await audio.getByLabel('Animate', { exact: true }).uncheck();
  await until(async () => await edges() === 1, 'animation off disconnects analysis only');
  await audio.getByLabel('Animate', { exact: true }).check();
  await audio.emulateMedia({ reducedMotion: 'reduce' });
  await until(async () => await edges() === 1, 'reduced motion disconnects analysis');
  await audio.emulateMedia({ reducedMotion: 'no-preference' });
  await until(async () => await edges() === 2, 'analysis resumes');
  const beforeSize = await region(audio, 'Audio Visualizer').locator('canvas').evaluate(canvas => canvas.width);
  await audio.setViewportSize({ width: 950, height: 650 });
  await audio.waitForFunction(before => document.querySelector('canvas').width !== before, beforeSize);
  assert.equal(await audio.evaluate(() => {
    const canvas = document.querySelector('canvas');
    return Math.abs(canvas.width - canvas.clientWidth * devicePixelRatio) <= 1;
  }), true, 'canvas follows display pixel ratio');
  await audio.getByRole('button', { name: 'Fullscreen Visualizer', exact: true }).click();
  await audio.waitForFunction(() => document.fullscreenElement?.getAttribute('aria-label') === 'Audio Visualizer');
  await audio.getByRole('button', { name: 'Exit Fullscreen', exact: true }).click();

  const mixer = await open('Audio Mixer', 'Pop Out Mixer');
  await until(() => commands.at(-1)?.op === 'subscribe' && commands.at(-1).enabled, 'mixer subscription survives dock cleanup');
  if (process.env.BROWSER_CDP) {
    await page.bringToFront();
    const newTab = page.waitForEvent('popup');
    await page.evaluate(() => window.open('about:blank', '_blank'));
    const background = await newTab;
    await background.bringToFront();
    await page.waitForFunction(() => document.visibilityState === 'hidden', undefined, { polling: 100 });
    await audio.bringToFront();
    await audio.waitForFunction(() => document.visibilityState === 'visible');
    const before = await audio.evaluate(() => window.paints);
    await audio.waitForFunction(before => window.paints > before + 3, before);
    await mixer.bringToFront();
    const volume = mixer.getByRole('slider', { name: 'Speakers Volume', exact: true });
    await volume.focus();
    await volume.press('ArrowRight');
    await until(() => commands.some(c => c.op === 'volume' && c.value === 51), 'volume command works with real background opener');
    await background.close();
    console.log('headed browser: real background opener, visible popup animation and mixer volume command passed');
  } else {
    await page.evaluate(() => {
      Object.defineProperty(document, 'hidden', { configurable: true, value: true });
      document.dispatchEvent(new Event('visibilitychange'));
      elsewhere.setControlsHidden(true);
      elsewhere.store.set({ mixerLevels: { output: 0.5 } });
    });
    await mixer.waitForFunction(() => document.querySelector('meter').value === 0.5);
    const paints = await audio.evaluate(() => window.paints);
    await audio.waitForFunction(before => window.paints > before + 3, paints);
    assert.equal(await edges(), 2, 'hidden parent controls and document do not pause visible popout');
    await mixer.getByRole('button', { name: 'Speakers Mute', exact: true }).click();
    await until(() => commands.some(c => c.op === 'mute' && c.id === 'output' && c.value), 'mixer sends through shared socket');
    await page.evaluate(() => elsewhere.store.set({ role: 'viewer' }));
    await mixer.getByText('Read Only', { exact: true }).waitFor();
    assert.equal(await mixer.getByRole('button', { name: 'Speakers Mute', exact: true }).isDisabled(), true);
    // Playback can close before React disposes the analysis branch. Exercise that interval.
    const beforeClose = await audio.evaluate(() => window.paints);
    assert.equal(await page.evaluate(async () => {
      await playback.context.close();
      playback.source.getByteFrequencyData(new Uint8Array(playback.source.frequencyBinCount));
      return playback.context.state;
    }), 'closed');
    await audio.waitForFunction(before => window.paints > before + 3, beforeClose);
    assert.equal(errors.length, 0, 'analysis remains safe until the closed playback source is unpublished');
    await page.evaluate(() => {
      Object.defineProperty(document, 'hidden', { configurable: true, value: false });
      document.dispatchEvent(new Event('visibilitychange'));
      elsewhere.setControlsHidden(false);
      elsewhere.store.set({ status: 'retrying', playback: null });
    });
    await audio.getByText('Connecting…', { exact: true }).waitFor();
    await until(async () => await edges() === 1, 'disconnect disposes the old analysis branch');
    await page.evaluate(async () => {
      window.oldPlayback = playback;
      const context = new AudioContext(); await context.resume();
      const source = context.createAnalyser(); source.connect(context.destination);
      window.playback = { context, source };
      elsewhere.store.set({ status: 'connected', playback: { context, source } });
    });
    await until(async () => await edges() === 2, 'replacement source attaches');
    await until(() => commands.at(-1)?.op === 'subscribe' && commands.at(-1).enabled, 'mixer resubscribes after reconnect');
    await mixer.close();
    await until(() => commands.at(-1)?.op === 'subscribe' && !commands.at(-1).enabled, 'closing mixer unsubscribes');
    assert.equal(await region(page, 'Audio Mixer').count(), 0, 'closing popup leaves dock closed');
    await audio.close();
    await until(async () => await edges() === 1, 'window close disposes analysis');
    assert.equal(await page.evaluate(() => playback.context.state), 'running');
    assert.equal(await region(page, 'Audio Visualizer').count(), 0);
    await show('Audio Visualizer');
    assert.equal(await page.getByRole('combobox', { name: /^Style/ }).inputValue(), 'radial', 'preferences survive reopening');
    await page.evaluate(() => { window.originalOpen = window.open; window.open = () => null; });
    await page.getByRole('button', { name: 'Pop Out Visualizer', exact: true }).click();
    assert.equal(await region(page, 'Audio Visualizer').count(), 1, 'blocked popup keeps dock open');
    await page.getByText(/Allow pop-ups for this site/).waitFor();
    await page.evaluate(() => { window.open = window.originalOpen; });
    await page.getByRole('button', { name: 'Close Visualizer', exact: true }).click();
    for (let i = 0; i < 3; i++) {
      audio = await open('Audio Visualizer', 'Pop Out Visualizer');
      await until(async () => await edges() === 2, 'analysis attached');
      await audio.getByRole('button', { name: 'Close Visualizer', exact: true }).click();
      await until(() => audio.isClosed(), 'panel close closes popup');
      await until(async () => await edges() === 1, 'repeated popup cleanup');
    }
    audio = await open('Audio Visualizer', 'Pop Out Visualizer');
    await page.evaluate(() => elsewhere.setPlaybackEnabled(false));
    await until(() => audio.isClosed(), 'desktop PiP playback handoff closes visualizer popup');
    // An isolated teardown failure must not prevent the other window from closing.
    await page.evaluate(() => {
      elsewhere.store.set({ playback: { context: playback.context, source: playback.source } });
      const attach = elsewhere.panels.attach;
      elsewhere.panels.attach = (win, kind) => {
        const owner = attach(win, kind);
        if (owner && kind === 'audio') {
          elsewhere.panels.attach = attach;
          const ready = owner.ready;
          owner.ready = cleanup => ready(() => { cleanup(); throw new Error('Injected cleanup failure'); });
        }
        return owner;
      };
    });
    const brokenAudio = await open('Audio Visualizer', 'Pop Out Visualizer');
    await until(async () => await edges() === 2, 'real analysis branch exists before teardown failure');
    const endedMixer = await open('Audio Mixer', 'Pop Out Mixer');
    await page.evaluate(() => elsewhere.store.set({ status: 'quit' }));
    await until(() => brokenAudio.isClosed() && endedMixer.isClosed(), 'session end closes both windows despite failed cleanup');
    assert.equal(await edges(), 1, 'real analysis cleanup ran before the injected failure');
    assert.equal(await page.getByRole('button', { name: 'Audio Mixer', exact: true }).getAttribute('aria-expanded'), 'false');
    await page.evaluate(() => elsewhere.store.set({ status: 'connected' }));
    const lastMixer = await open('Audio Mixer', 'Pop Out Mixer');
    await page.reload();
    await until(() => lastMixer.isClosed(), 'parent navigation closes popup');
    assert.equal(errors.length, 0, errors.join('\n'));
    const orphan = await context.newPage();
    await orphan.goto(`${base}?panel=mixer`);
    await orphan.getByText('Open this panel from the main Elsewhere viewer.').waitFor();
    assert.equal(await orphan.evaluate(() => typeof window.elsewhere), 'undefined');
    console.log('panel popouts: shared connection/audio, URL prefix, controls, permissions, visibility, sizing, fullscreen, preferences, reconnect, blocked popup, repeated cleanup, PiP handoff and parent navigation passed');
  }
  assert.equal(errors.length, 0, errors.join('\n'));
} finally {
  for (const page of context?.pages() ?? []) await page.close();
  await browser.close(); server.close();
}
