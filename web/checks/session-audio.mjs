// Docker live-session check. ELSEWHERE_TEST_TOKEN_FILE points at the rig's admin token.
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { chromium } from 'playwright-core';
import { toneCommand, tonePattern } from './audio-fixture.mjs';
const avSeconds = Number(process.argv.find(value => value.startsWith('--av-seconds='))?.split('=')[1] || 0);
assert(Number.isFinite(avSeconds) && avSeconds >= 0, 'invalid A/V measurement duration');

async function checkAvSync(page, seconds) {
  const directory = await mkdtemp(tmpdir() + '/elsewhere-av-clock-');
  try {
    await page.evaluate(() => elsewhere.spawn("pkill -f '^mpv --no-config --no-audio --length=40 --title=elsewhere-audio-check'"));
    await page.waitForFunction(() => !elsewhere.store.get().windows.some(window => window.title === 'elsewhere-audio-check'));
    const clip = directory + '/sync.mkv';
    const generated = spawnSync('ffmpeg', ['-nostdin', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i',
      'color=black:size=640x360:rate=30:duration=12', '-f', 'lavfi', '-i',
      'aevalsrc=if(gte(t\\,1)*lt(mod(t-1\\,2)\\,0.2)\\,0.25*sin(2*PI*880*t)\\,0):s=48000:d=12',
      '-vf', "drawbox=color=white:t=fill:enable='gte(t,1)*lt(mod(t-1,2),0.2)'", '-c:v', 'libx264', '-preset', 'ultrafast',
      '-crf', '0', '-pix_fmt', 'yuv420p', '-c:a', 'pcm_s16le', '-shortest', clip], { timeout: 20000 });
    assert.equal(generated.status, 0, generated.stderr?.toString());
    await page.evaluate(async () => {
      const { context, source } = elsewhere.store.get().playback;
      const module = URL.createObjectURL(new Blob([`
        class ClockPulse extends AudioWorkletProcessor {
          last = -48000;
          process(inputs) {
            const samples = inputs[0]?.[0];
            if (samples) for (let i = 0; i < samples.length; i++) {
              if (Math.abs(samples[i]) > .05 && currentFrame + i - this.last > sampleRate) {
                this.last = currentFrame + i;
                this.port.postMessage(this.last / sampleRate);
                break;
              }
            }
            return true;
          }
        }
        registerProcessor('clock-pulse', ClockPulse);
      `], { type: 'text/javascript' }));
      await context.audioWorklet.addModule(module); URL.revokeObjectURL(module);
      const detector = new AudioWorkletNode(context, 'clock-pulse');
      const silent = context.createGain(); silent.gain.value = 0;
      source.connect(detector); detector.connect(silent); silent.connect(context.destination);
      const sample = document.createElement('canvas'); sample.width = sample.height = 1;
      const pixels = sample.getContext('2d', { willReadFrequently: true });
      const state = window.avClock = { audio: [], video: [], active: true, error: null };
      detector.port.onmessage = ({ data }) => {
        const timestamp = context.getOutputTimestamp();
        if (timestamp.contextTime > 0) state.audio.push(timestamp.performanceTime + (data - timestamp.contextTime) * 1000);
      };
      let white = true;
      const observe = () => {
        if (!state.active) return;
        try {
          const canvas = document.querySelector('canvas');
          pixels.drawImage(canvas, Math.floor(canvas.width / 2), Math.floor(canvas.height / 2), 1, 1, 0, 0, 1, 1);
          const bright = pixels.getImageData(0, 0, 1, 1).data[0] > 200;
          if (bright && !white) state.video.push(performance.now());
          white = bright;
        } catch (error) { state.error = error.message; }
        requestAnimationFrame(observe);
      };
      requestAnimationFrame(observe);
      state.stop = () => { state.active = false; source.disconnect(detector); detector.disconnect(); silent.disconnect(); };
    });
    await page.evaluate(clip => elsewhere.spawn("mpv --no-config --fullscreen --no-border --title=elsewhere-av-clock --vo=wlshm --ao=pipewire --loop-file=inf --really-quiet '" + clip.replaceAll("'", "'\\''") + "'"), clip);
    await page.waitForFunction(() => avClock.audio.length >= 2 && avClock.video.length >= 2, undefined, { timeout: 20000 });
    for (let elapsed = 0; elapsed < seconds; elapsed += 60) {
      await page.waitForTimeout(Math.min(60, seconds - elapsed) * 1000);
      console.log('A/V clock progress', await page.evaluate(() => ({ audio: avClock.audio.length, video: avClock.video.length, error: avClock.error })));
    }
    const events = await page.evaluate(() => { avClock.stop(); return { audio: avClock.audio, video: avClock.video, error: avClock.error }; });
    assert.equal(events.error, null);
    assert(Math.abs(events.audio.length - events.video.length) <= 1, 'audio/video pulse counts diverged');
    const pairs = events.video.slice(0, events.audio.length).map((video, index) => ({ video, skew: events.audio[index] - video }));
    const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
    assert(pairs.length >= seconds / 2 * .9, 'too many synchronized source pulses were lost: ' + JSON.stringify({ audio: events.audio.length, video: events.video.length, pairs: pairs.length }));
    const window = Math.min(15, Math.floor(pairs.length / 2));
    const first = median(pairs.slice(0, window).map(pair => pair.skew));
    const last = median(pairs.slice(-window).map(pair => pair.skew));
    const summary = { seconds, pairs: pairs.length, startupSkewMs: pairs[0].skew, firstMedianSkewMs: first,
      lastMedianSkewMs: last, driftMs: last - first, maxAbsoluteSkewMs: Math.max(...pairs.map(pair => Math.abs(pair.skew))) };
    console.log('A/V clock measurement', JSON.stringify(summary));
    assert(Math.abs(summary.driftMs) < 100, 'A/V skew drifted by 100 ms or more');
    assert(summary.maxAbsoluteSkewMs < 500, 'A/V pulse skew reached 500 ms');
  } finally {
    await page.evaluate(() => avClock?.stop()).catch(() => {});
    spawnSync('pkill', ['-f', '^mpv --no-config --fullscreen --no-border --title=elsewhere-av-clock']);
    await rm(directory, { recursive: true, force: true });
  }
}
const cleanup = () => {
  spawnSync('pkill', ['-f', tonePattern]);
  spawnSync('pkill', ['-f', '^mpv --no-config --no-audio --length=40 --title=elsewhere-audio-check']);
};
cleanup();
const token = (await readFile(process.env.ELSEWHERE_TEST_TOKEN_FILE, 'utf8')).trim();
const browser = await chromium.launch({ executablePath: '/usr/bin/chromium', args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required', '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] });
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  await page.addInitScript(() => {
    window.renderProbe = { draws: 0, reads: 0 };
    const fill = CanvasRenderingContext2D.prototype.fillRect;
    CanvasRenderingContext2D.prototype.fillRect = function (x, y, width, height) {
      if (this.canvas.closest('[aria-label="Audio Visualizer"]') && width === this.canvas.width && height === this.canvas.height) renderProbe.draws++;
      return fill.call(this, x, y, width, height);
    };
    for (const name of ['getByteFrequencyData', 'getFloatFrequencyData']) {
      const read = AnalyserNode.prototype[name];
      AnalyserNode.prototype[name] = function (data) {
        if (this !== window.elsewhere?.store.get().playback?.source) renderProbe.reads++;
        return read.call(this, data);
      };
    }
  });
  await page.goto(`${process.env.ELSEWHERE_TEST_URL || 'http://127.0.0.1:8080'}/#token=${token}`);
  await page.waitForFunction(() => window.elsewhere?.store.get().status === 'connected');
  await page.evaluate(command => {
    elsewhere.setChoice({ codec: 'vp8', quality: 'low' });
    elsewhere.spawn(command);
    elsewhere.spawn('mpv --no-config --no-audio --length=40 --title=elsewhere-audio-check --vo=wlshm av://lavfi:testsrc2=size=640x360:rate=30');
  }, toneCommand({ seconds: 36, pulse: true }));
  // Let both decoders process about two seconds of media before measuring steady playback.
  await page.waitForFunction(() => {
    const { audio, frames } = elsewhere.store.get().stats;
    return audio?.level > 0 && audio.decoded >= 100 && frames >= 60;
  }, undefined, { timeout: 15000 });
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Performance.enable');
  const metrics = async () => Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map(m => [m.name, m.value]));
  const measure = async () => {
    await cdp.send('HeapProfiler.collectGarbage');
    const before = await metrics();
    const start = await page.evaluate(() => ({ frames: elsewhere.store.get().stats.frames, underruns: elsewhere.store.get().stats.underruns, ...renderProbe }));
    const peak = await page.evaluate(async () => {
      let peak = 0;
      for (let n = 0; n < 20; n++) {
        const source = elsewhere.store.get().playback.source, samples = new Float32Array(source.fftSize);
        source.getFloatTimeDomainData(samples);
        for (const sample of samples) peak = Math.max(peak, Math.abs(sample));
        await new Promise(resolve => setTimeout(resolve, 150));
      }
      return peak;
    });
    const after = await metrics();
    return { peak, seconds: after.Timestamp - before.Timestamp, heapBytes: after.JSHeapUsedSize, nodes: after.Nodes, taskMsPerSecond: 1000 * (after.TaskDuration - before.TaskDuration) / (after.Timestamp - before.Timestamp), ...(await page.evaluate(start => ({ frames: elsewhere.store.get().stats.frames - start.frames, draws: renderProbe.draws - start.draws, reads: renderProbe.reads - start.reads, audio: elsewhere.store.get().stats.audio, underruns: elsewhere.store.get().stats.underruns - start.underruns }), start)) };
  };
  const videoSize = await page.locator('canvas.stage').boundingBox();
  const closed = await measure();
  await page.getByRole('button', { name: 'Audio Visualizer', exact: true }).click();
  const panel = page.getByRole('region', { name: 'Audio Visualizer' });
  await panel.locator('canvas').waitFor();
  await panel.getByText('Loading…', { exact: true }).waitFor({ state: 'detached' });
  const panelSize = await panel.boundingBox();
  await page.setViewportSize({ width: 1280, height: 800 + Math.round(panelSize.height) });
  await page.waitForFunction(height => Math.abs(document.querySelector('canvas.stage').getBoundingClientRect().height - height) < 1, videoSize.height);
  await page.waitForFunction(() => renderProbe.draws > 0);
  const image1 = await panel.locator('canvas').evaluate(c => c.toDataURL());
  await page.waitForFunction(before => document.querySelector('[aria-label="Audio Visualizer"] canvas').toDataURL() !== before, image1);
  const open = await measure();
  console.log(JSON.stringify({ closed, open }));
  assert(open.frames > 30 && open.audio.level > 0);
  assert(Math.abs(open.peak - closed.peak) < .002, 'analysis does not alter playback level');
  await panel.getByRole('button', { name: 'Close Visualizer', exact: true }).click();
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.waitForFunction(height => Math.abs(document.querySelector('canvas.stage').getBoundingClientRect().height - height) < 1, videoSize.height);
  const closedAgain = await measure();
  console.log(JSON.stringify({ closed, open, closedAgain }));
  for (const sample of [closed, open, closedAgain]) {
    assert(sample.frames / sample.seconds > 25, 'live video keeps up with the 30 fps source');
    assert.equal(sample.underruns, 0, 'live audio stays supplied during measurement');
    assert(Math.abs(sample.peak - closed.peak) < .002, 'playback level stays stable');
  }
  assert(open.draws / open.seconds > 25 && open.draws <= open.seconds * 30 + 2, 'visualiser draws near its 30 fps cap');
  assert.equal(open.reads, open.draws * 2);
  assert.deepEqual([closed.draws, closed.reads, closedAgain.draws, closedAgain.reads], [0, 0, 0, 0]);
  // Stop the rig's finite test signal early, then observe the real playback analyser.
  await page.evaluate(pattern => elsewhere.spawn("pkill -f '" + pattern + "'"), tonePattern);
  await page.waitForFunction(() => elsewhere.store.get().stats.audio?.signalPeak < 0.0001);
  await page.getByRole('button', { name: 'Audio Visualizer', exact: true }).click();
  await panel.getByText('Silent', { exact: false }).waitFor();
  console.log('actual decoded session playback, animated spectrum, stable volume, video decoding and silence passed');
  assert.equal(await page.evaluate(() => elsewhere.store.get().mic), false, 'visualisation does not start capture');
  await page.context().grantPermissions(['microphone']);
  await page.evaluate(() => elsewhere.mic.start());
  await page.waitForFunction(() => elsewhere.store.get().mic);
  await page.evaluate(() => elsewhere.mic.stop());
  await page.waitForFunction(() => !elsewhere.store.get().mic);
  console.log('fake-device microphone start/stop passed');
  if (avSeconds) await checkAvSync(page, avSeconds);
} finally { await browser.close(); cleanup(); }
