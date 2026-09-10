import { streamChoice, chooseStream } from './stream-choice.mjs';
// Docker: built viewer and Chromium. Decoder order, recovery UI and live preferences for both viewers.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright-core';

const server = createServer(async (req, res) => {
  const path = new URL(req.url, 'http://localhost').pathname;
  if (path.startsWith('/api/')) {
    res.setHeader('Content-Type', 'application/json');
    return res.end(JSON.stringify([]));
  }
  try {
    res.setHeader('Content-Type', path.endsWith('.js') ? 'text/javascript' : path.endsWith('.css') ? 'text/css' : 'text/html');
    res.end(await readFile(new URL('../dist/' + (path === '/' ? 'index.html' : path.slice(1)), import.meta.url)));
  } catch { res.writeHead(404).end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const browser = await chromium.launch({ executablePath: '/usr/bin/chromium', args: ['--no-sandbox'] });
try {
  for (const query of ['', '?window=1']) {
    const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.addInitScript(() => {
      window.sent = []; window.sockets = []; window.requests = 0; window.probed = [];
      const fetch = window.fetch;
      window.fetch = (url, init) => { if (String(url).endsWith('/api/codecs')) requests++; return fetch(url, init); };
      VideoDecoder.isConfigSupported = async config => { probed.push(config.codec); return { supported: !config.codec.startsWith('vp09') }; };
      window.WebSocket = class {
        static OPEN = 1; readyState = 1;
        constructor() { sockets.push(this); queueMicrotask(() => { this.onopen?.({}); this.onmessage?.({ data: new Uint8Array([0x15, ...new TextEncoder().encode(JSON.stringify(["desktop.view"]))]).buffer }); }); }
        send(data) { sent.push([...new Uint8Array(data)]); }
        close() { this.readyState = 3; this.onclose?.({ code: 1006, reason: '' }); }
      };
      window.message = (tag, object) => sockets.at(-1).onmessage({ data: new Uint8Array([tag, ...new TextEncoder().encode(JSON.stringify(object))]).buffer });
      window.streamState = (status, codec, attempt = 1) => message(0x0c, { status, codec, attempt, codecs: [{ codec: 'h264', hardware: true }, { codec: 'hevc', hardware: true }, { codec: 'vp9', hardware: true }], preset: 'medium', medium_kbps: 8000, ceiling_kbps: 8000, bitrate_kbps: 8000, max_fps: 0 });
      window.payload = tag => JSON.parse(new TextDecoder().decode(new Uint8Array(sent.filter(p => p[0] === tag).at(-1).slice(1))));
    });
    await page.goto(`http://127.0.0.1:${server.address().port}/${query}#token=test`);
    await page.waitForFunction(() => sent.some(p => p[0] === 0x81));
    assert.equal(await page.evaluate(() => requests), 0);
    assert.deepEqual(await page.evaluate(() => payload(0x81)), { codecs: ['h264', 'hevc', 'av1', 'vp8'], quality: 'medium', effort: 'fast' });
    assert.equal(await page.evaluate(() => probed.length), 5);
    await page.evaluate(() => streamState('starting', 'h264'));
    await page.getByTitle('Video Codec', { exact: true }).waitFor();
    const field = await streamChoice(page, 'Video Codec');
    assert.deepEqual(await field.locator('input').evaluateAll(options => options.map(o => o.value)), ['auto', 'h264', 'hevc']);
    await page.keyboard.press('Escape');
    await chooseStream(page, 'Video Codec', 'hevc');
    assert.deepEqual(await page.evaluate(() => payload(0x8f)), { codecs: ['hevc', 'h264', 'av1', 'vp8'] });
    await page.evaluate(() => streamState('retrying', 'hevc', 2));
    await page.getByRole('status').filter({ hasText: 'Retrying HEVC' }).waitFor();
    await page.evaluate(() => streamState('switching', 'h264', 3));
    await page.getByRole('status').filter({ hasText: 'Switching to H.264' }).waitFor();
    assert(await page.evaluate(() => { const first = elsewhere.store.get().notice; streamState('switching', 'h264', 3); return elsewhere.store.get().notice === first; }), 'repeat state does not repeat the switch notice');
    assert.match(await page.getByTitle('Video Codec', { exact: true }).textContent(), /Using H\.264/);
    await page.evaluate(() => { streamState('failed', null, 4); streamState('starting', 'h264', 1); });
    assert.equal(await page.evaluate(() => elsewhere.store.get().streamState.status), 'failed');
    await page.getByRole('button', { name: 'Retry Video', exact: true }).click();
    assert.deepEqual(await page.evaluate(() => payload(0x8f)), { codecs: ['hevc', 'h264', 'av1', 'vp8'] });
    assert.equal(await page.evaluate(() => sockets.length), 1);
    // An old RTC configuration cannot revive exhausted video.
    await page.evaluate(() => message(1, { attempt: 3, streamId: 1, codec: 'avc1.640028', width: 640, height: 480, scale: 1 }));
    assert.equal(await page.evaluate(() => elsewhere.store.get().stream), null);
    // A new RTC config may beat its WebSocket state. A delayed old config must not replace it.
    await page.evaluate(() => {
      message(1, { attempt: 6, streamId: 6, codec: 'avc1.640028', width: 640, height: 480, scale: 1 });
      message(1, { attempt: 5, streamId: 5, codec: 'avc1.640028', width: 640, height: 480, scale: 1 });
    });
    assert.equal(await page.evaluate(() => elsewhere.store.get().stream.attempt), 6);
    await chooseStream(page, 'Video Codec', 'auto');
    assert.deepEqual(await page.evaluate(() => payload(0x8f)), { codecs: ['h264', 'hevc', 'av1', 'vp8'] });
    await page.evaluate(() => { elsewhere.setChoice({ codec: 'hevc', quality: 'high' }); sockets[0].close(); });
    await page.waitForFunction(() => sockets.length === 2 && sent.filter(p => p[0] === 0x81).length === 2);
    assert.deepEqual(await page.evaluate(() => payload(0x81)), { codecs: ['hevc', 'h264', 'av1', 'vp8'], quality: 'high', effort: 'fast' });
    await page.evaluate(() => streamState('starting', 'hevc', 1));
    assert.equal(await page.evaluate(() => elsewhere.store.get().streamState.attempt), 1);
    assert.deepEqual(errors, []);
    await page.close();
    const unsupported = await browser.newPage();
    await unsupported.addInitScript(() => { window.VideoDecoder = undefined; });
    await unsupported.goto(`http://127.0.0.1:${server.address().port}/${query}#token=test`);
    await unsupported.waitForFunction(() => elsewhere.store.get().status === 'error');
    await unsupported.close();
  }
  console.log('desktop/window ordered negotiation, filtering, recovery, retry and reconnect passed');
} finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
