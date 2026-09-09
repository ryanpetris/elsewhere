// Docker: built viewer and Chromium. Capability discovery must precede the video socket.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright-core';

const server = createServer(async (req, res) => {
  const path = new URL(req.url, 'http://localhost').pathname;
  if (path.startsWith('/api/')) {
    res.setHeader('Content-Type', 'application/json');
    return res.end(JSON.stringify(path === '/api/me' ? { permissions: ['desktop.view'] } : []));
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
    const page = await browser.newPage();
    await page.addInitScript(() => {
      localStorage.setItem('elsewhere.codec', 'vp9');
      window.sent = []; window.sockets = []; window.requests = 0; window.probed = [];
      const fetch = window.fetch;
      window.fetch = (url, init) => String(url).endsWith('/api/codecs') ? new Promise(resolve => {
        requests++;
        window.releaseCodecs = (list, status = 200) => resolve(new Response(JSON.stringify(list), { status }));
      }) : fetch(url, init);
      VideoDecoder.isConfigSupported = async config => { probed.push(config.codec); return { supported: true }; };
      window.WebSocket = class {
        static OPEN = 1; readyState = 1;
        constructor() { sockets.push(this); queueMicrotask(() => this.onopen?.()); }
        send(data) { sent.push([...new Uint8Array(data)]); }
        close() { this.readyState = 3; this.onclose?.({ code: 1006, reason: '' }); }
      };
    });
    await page.goto(`http://127.0.0.1:${server.address().port}/${query}#token=test`);
    await page.waitForFunction(() => requests === 1);
    assert.equal(await page.evaluate(() => sockets.length), 0);
    await page.evaluate(() => releaseCodecs([{ codec: 'h264', hardware: true }, { codec: 'hevc', hardware: true }]));
    await page.waitForFunction(() => sent.some(p => p[0] === 0x81));
    assert.deepEqual(await page.evaluate(() => sent.find(p => p[0] === 0x81)), [0x81, 0, 3, 0, 3, 0]);
    assert.equal(await page.evaluate(() => elsewhere.store.get().choice.codec), 'auto');
    assert.deepEqual(await page.evaluate(() => [...new Set(probed)]), ['avc1.640028', 'hev1.1.6.L120.90']);

    await page.evaluate(() => { elsewhere.setChoice({ codec: 'hevc', quality: 'high' }); sockets[0].close(); });
    await page.waitForFunction(() => requests === 2);
    assert.equal(await page.evaluate(() => sockets.length), 1);
    await page.evaluate(() => releaseCodecs([{ codec: 'hevc', hardware: true }]));
    await page.waitForFunction(() => sent.filter(p => p[0] === 0x81).length === 2);
    assert.deepEqual(await page.evaluate(() => sent.filter(p => p[0] === 0x81)[1]), [0x81, 0, 2, 2, 4, 0]);

    await page.evaluate(() => sockets[1].close());
    await page.waitForFunction(() => requests === 3);
    await page.evaluate(() => releaseCodecs([], 503));
    await page.waitForFunction(() => requests === 4);
    assert.equal(await page.evaluate(() => sockets.length), 2);
    await page.evaluate(() => releaseCodecs([]));
    await page.waitForFunction(() => elsewhere.store.get().status === 'error');
    assert.equal(await page.evaluate(() => sockets.length), 2);
    await page.getByText('No video codec in common', { exact: true }).waitFor();
    assert.equal(await page.getByText('This tab showed one window; it is gone.').count(), 0);
    await page.reload();
    await page.waitForFunction(() => requests === 1);
    await page.evaluate(() => {
      window.VideoDecoder = undefined;
      releaseCodecs([{ codec: 'h264', hardware: true }]);
    });
    await page.waitForFunction(() => elsewhere.store.get().status === 'error');
    assert.equal(await page.evaluate(() => sockets.length), 0);
    await page.close();
  }
  console.log('codec discovery precedes desktop/window streaming; defaults, choices, reconnects and failures verified');
} finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
