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
  const page = await browser.newPage();
  await page.goto(`${process.env.ELSEWHERE_TEST_URL || 'http://127.0.0.1:8080'}/#token=${token}`);
  await page.waitForFunction(() => window.elsewhere?.store.get().status === 'connected');
  await page.evaluate(command => {
    elsewhere.setChoice({ codec: 'vp8', quality: 'low' });
    elsewhere.spawn(command);
    elsewhere.spawn('mpv --no-config --no-audio --length=40 --title=elsewhere-audio-check --vo=wlshm av://lavfi:testsrc2=size=640x360:rate=30');
  }, toneCommand({ seconds: 36, pulse: true }));
  await page.waitForFunction(() => elsewhere.store.get().stats.audio?.level > 0 && elsewhere.store.get().stats.frames > 5, undefined, { timeout: 15000 });
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Performance.enable');
  const metrics = async () => Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map(m => [m.name, m.value]));
  const measure = async () => {
    const before = await metrics();
    const start = await page.evaluate(() => elsewhere.store.get().stats.frames);
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
    return { peak, taskMsPerSecond: 1000 * (after.TaskDuration - before.TaskDuration) / 3, ...(await page.evaluate(start => ({ frames: elsewhere.store.get().stats.frames - start, audio: elsewhere.store.get().stats.audio, underruns: elsewhere.store.get().stats.underruns }), start)) };
  };
  const closed = await measure();
  await page.getByRole('button', { name: 'Audio Visualizer', exact: true }).click();
  const panel = page.getByRole('region', { name: 'Audio Visualizer' });
  await panel.locator('canvas').waitFor();
  const image1 = await panel.locator('canvas').evaluate(c => c.toDataURL());
  await page.waitForTimeout(300);
  const image2 = await panel.locator('canvas').evaluate(c => c.toDataURL());
  assert.notEqual(image1, image2, 'actual playback animates spectrum');
  const open = await measure();
  console.log(JSON.stringify({ closed, open }));
  assert(open.frames > 30 && open.audio.level > 0);
  assert(Math.abs(open.peak - closed.peak) < .002, 'analysis does not alter playback level');
  await panel.getByRole('button', { name: 'Close Visualizer', exact: true }).click();
  const closedAgain = await measure();
  console.log(JSON.stringify({ closed, open, closedAgain }));
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
