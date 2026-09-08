// Docker: built viewer and Chromium. Controlled clipboard HTTP responses, real browser input.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { chromium } from 'playwright-core';
import { CONFIG, ROLE, CLIPBOARD_DATA, KEY } from '../src/protocol.js';

const root = await mkdtemp('/tmp/elsewhere-clipboard-panel-');
let serial = 0, operation = 0, clipboard, queued = [], previewReads = 0, fileReads = 0, failWrite = false, delayPreview, releasePreview;
const set = (mime = null, data = Buffer.alloc(0), options = {}) => {
  clipboard = { mime, data: Buffer.from(data), observation: `check:${++serial}`, operation: null, ...options };
};
set();
const meta = restricted => ({
  observation: clipboard.observation, operation: clipboard.operation, mime: clipboard.mime,
  present: clipboard.mime !== null && !(clipboard.mime.startsWith('text/plain') && clipboard.data.length === 0),
  size: restricted ? null : clipboard.size ?? clipboard.data.length,
  preview: restricted ? 'restricted' : !clipboard.mime || clipboard.mime.startsWith('text/plain') && !clipboard.data.length ? 'empty' : clipboard.preview || 'available',
});
const server = createServer(async (req, res) => {
  const path = new URL(req.url, 'http://localhost').pathname;
  const restricted = req.headers.authorization === 'Bearer viewer' && clipboard.mime === 'text/uri-list';
  const json = (value, code = 200) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value)); };
  if (path === '/api/clipboard/state') return json(meta(restricted));
  if (path === '/api/clipboard' && req.method === 'PUT') {
    if (req.headers.authorization === 'Bearer viewer') return json({}, 403);
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    if (failWrite) return json({}, 503);
    const write = { text: Buffer.concat(chunks).toString(), operation: `write:${++operation}` }; queued.push(write);
    return json({ operation: write.operation }, 202);
  }
  if (path === '/api/clipboard') {
    previewReads++;
    if (restricted) return json({}, 403);
    if (req.headers['if-match'] && req.headers['if-match'] !== `"${clipboard.observation}"`) return json({}, 412);
    const snapshot = { ...clipboard };
    if (delayPreview) { delayPreview = false; await new Promise(resolve => { releasePreview = resolve; }); }
    res.writeHead(200, { 'Content-Type': snapshot.responseType || snapshot.mime || 'text/plain' }); return res.end(snapshot.data);
  }
  if (path.startsWith('/api/clipboard/files/')) {
    fileReads++;
    if (restricted) return json({}, 403);
    res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Disposition': "attachment; filename*=UTF-8''copied.txt" }); return res.end('copied file');
  }
  if (path.startsWith('/api/')) return json([]);
  try {
    res.setHeader('Content-Type', path.endsWith('.js') ? 'text/javascript' : path.endsWith('.css') ? 'text/css' : 'text/html');
    res.end(await readFile(new URL('../dist/' + (path === '/' ? 'index.html' : path.slice(1)), import.meta.url)));
  } catch { res.writeHead(404).end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const browser = await chromium.launch({ executablePath: '/usr/bin/chromium', env: { ...process.env, XDG_CONFIG_HOME: root }, args: ['--no-sandbox'] });
const wait = async fn => { for (let i = 0; i < 150; i++) { if (await fn()) return; await new Promise(resolve => setTimeout(resolve, 50)); } throw Error('clipboard check timed out'); };
try {
  const context = await browser.newContext();
  await context.addInitScript(() => {
    window.sent = []; window.copies = []; window.failures = []; window.liveUrls = new Set();
    addEventListener('unhandledrejection', e => failures.push(String(e.reason)));
    navigator.clipboard.writeText = text => { copies.push(text); return Promise.reject(new DOMException('denied', 'NotAllowedError')); };
    const create = URL.createObjectURL, revoke = URL.revokeObjectURL;
    URL.createObjectURL = blob => { const url = create(blob); liveUrls.add(url); return url; };
    URL.revokeObjectURL = url => { liveUrls.delete(url); revoke(url); };
    window.WebSocket = class {
      static OPEN = 1; readyState = 1;
      constructor() { window.socket = this; queueMicrotask(() => this.onopen?.({})); }
      send(data) { sent.push([...new Uint8Array(data)]); }
      close() {}
    };
    window.packet = bytes => socket.onmessage({ data: new Uint8Array(bytes).buffer });
  });
  const page = await context.newPage();
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  const connect = async (token = 'control', windowMode = false) => {
    await page.goto(`http://127.0.0.1:${server.address().port}/?check=${serial}&window=${windowMode ? '1' : ''}#token=${token}`);
    await page.waitForFunction(() => !!window.elsewhere?.store && !!window.socket);
    await page.evaluate(({ ROLE, CONFIG, token }) => {
      packet([ROLE, token === 'viewer' ? 0 : 2, 0]);
      packet([CONFIG, ...new TextEncoder().encode(JSON.stringify({ streamId: 1, codec: 'vp8', width: 1280, height: 720, scale: 1 }))]);
    }, { ROLE, CONFIG, token });
    await page.waitForFunction(() => elsewhere.store.get().clipboardState.status === 'ready');
  };
  const notify = () => page.evaluate(CLIPBOARD_DATA => packet([CLIPBOARD_DATA, ...new TextEncoder().encode('changed')]), CLIPBOARD_DATA);
  const panel = page.getByRole('dialog', { name: 'Desktop clipboard', exact: true });
  const toggle = page.locator('#clipboard-toggle');
  const open = () => toggle.click();
  const text = value => panel.locator('pre').filter({ hasText: value });
  const applyWrite = () => { const write = queued.shift(); assert.ok(write); set('text/plain;charset=utf-8', write.text, { operation: write.operation }); };

  set('text/plain;charset=utf-8', 'initial private text');
  await connect(); await open(); await text('initial private text').waitFor();
  assert.equal(await page.evaluate(() => copies.length), 0, 'opening and initial metadata do not write the browser clipboard');
  assert.equal(await toggle.textContent(), '');
  assert.doesNotMatch(await toggle.getAttribute('title'), /initial private text/);
  const width = (await toggle.boundingBox()).width;
  await page.evaluate(() => { sent.length = 0; });
  await panel.locator('pre').focus();
  await page.keyboard.press('Control+c');
  await page.keyboard.press('a');
  assert.deepEqual(await page.evaluate(KEY => sent.filter(p => p[0] === KEY), KEY), [], 'preview keydown and keyup stay local');
  const copiesBeforeOwnerClear = await page.evaluate(() => copies.length);
  set(null); await notify();
  await panel.getByText('Clipboard is empty', { exact: true }).waitFor();
  assert.equal(await page.evaluate(() => copies.length), copiesBeforeOwnerClear, 'owner clear must not erase the browser clipboard');
  set('text/plain;charset=utf-8', ' \n\t'); await notify();
  await page.waitForFunction(() => elsewhere.store.get().clipboardState.text === ' \n\t');
  assert.match(await toggle.getAttribute('aria-label'), /has contents/);
  assert.equal((await toggle.boundingBox()).width, width);
  await panel.getByRole('button', { name: 'Edit', exact: true }).click();
  await panel.getByRole('textbox').fill('  draft\n');
  await page.evaluate(() => { sent.length = 0; });
  await panel.getByRole('textbox').press('a');
  await panel.getByRole('textbox').fill('  draft\n');
  assert.deepEqual(await page.evaluate(KEY => sent.filter(p => p[0] === KEY), KEY), [], 'local typing stays local');
  set('text/plain;charset=utf-8', 'external'); await notify();
  await panel.getByText('Clipboard changed', { exact: true }).waitFor();
  assert.equal(await panel.getByRole('textbox').inputValue(), '  draft\n');
  await page.keyboard.press('Escape'); await panel.waitFor({ state: 'hidden' });
  assert.equal(await toggle.evaluate(el => document.activeElement === el), true);
  await open(); assert.equal(await panel.getByRole('textbox').inputValue(), '  draft\n');
  await panel.getByRole('button', { name: 'Replace with draft' }).click();
  await wait(() => queued.length === 1);
  await panel.getByText('Waiting for the desktop clipboard…').waitFor();
  assert.equal(clipboard.data.toString(), 'external', '202 is not treated as an observed write');
  applyWrite();
  await panel.getByRole('textbox').waitFor({ state: 'hidden' });
  await page.waitForFunction(() => elsewhere.store.get().clipboardState.text === '  draft\n');
  assert.ok((await page.evaluate(() => copies)).includes('  draft\n'), 'confirmed writes attempt ordinary clipboard sync despite denied permission');
  await panel.getByRole('button', { name: 'Clear', exact: true }).click(); await wait(() => queued.length === 1); applyWrite();
  await panel.getByText('Clipboard is empty', { exact: true }).waitFor();
  assert.match(await toggle.getAttribute('aria-label'), /empty/);

  const png = Buffer.from(await page.evaluate(() => { const c = document.createElement('canvas'); c.width = 2; c.height = 3; return c.toDataURL('image/png').split(',')[1]; }), 'base64');
  set('image/png', png); await notify();
  await panel.getByRole('img').waitFor(); await panel.getByText('2 × 3').waitFor();
  assert.equal(await page.evaluate(() => liveUrls.size), 1);
  await page.keyboard.press('Escape'); await panel.waitFor({ state: 'hidden' });
  await wait(() => page.evaluate(() => liveUrls.size === 0));
  await open(); await panel.getByRole('img').waitFor();
  set('image/png', 'corrupt'); await notify(); await panel.getByText('Preview unavailable', { exact: true }).waitFor();
  await wait(() => page.evaluate(() => liveUrls.size === 0));
  const reads = previewReads;
  set('image/png', png, { size: 17 * 1024 * 1024 }); await notify();
  await panel.getByText('17408.0 KiB').waitFor();
  assert.equal(previewReads, reads, 'oversized image is not fetched');
  const large = Buffer.from(png); large.writeUInt32BE(100000, 16); large.writeUInt32BE(100000, 20);
  set('image/png', large); await notify(); await panel.getByText('Preview unavailable', { exact: true }).waitFor();
  assert.equal(await page.evaluate(() => liveUrls.size), 0, 'pixel limit is checked before creating an image URL');
  set('application/custom', '', { preview: 'unavailable' }); await notify();
  await panel.getByText('application/custom', { exact: false }).waitFor(); assert.match(await toggle.getAttribute('aria-label'), /has contents/);
  const copiesAfterUnsupported = await page.evaluate(() => copies.length);
  set('text/plain;charset=utf-8', 'metadata-only copy');
  await page.evaluate(() => elsewhere.clipboard.refresh(true));
  await text('metadata-only copy').waitFor();
  assert.equal(await page.evaluate(() => copies.length), copiesAfterUnsupported, 'an unsupported offer cannot leave a browser copy pending for a later owner');

  set('text/plain;charset=utf-8', 'wrong response', { responseType: 'image/png' }); await notify();
  await panel.getByRole('alert').filter({ hasText: 'Clipboard preview type changed' }).waitFor();
  assert.equal(await panel.locator('pre').count(), 0);
  const copiesAfterFailure = await page.evaluate(() => copies.length);
  set('text/plain;charset=utf-8', 'after failed preview');
  await page.evaluate(() => elsewhere.clipboard.refresh(true));
  await text('after failed preview').waitFor();
  assert.equal(await page.evaluate(() => copies.length), copiesAfterFailure, 'a failed preview cannot leave a browser copy pending for a later owner');

  set('text/uri-list', 'file:///shared/copied.txt\n'); await notify();
  await panel.getByText('copied.txt', { exact: true }).waitFor();
  const download = page.waitForEvent('download'); await panel.getByRole('button', { name: 'Download copied.txt' }).click();
  assert.equal((await download).suggestedFilename(), 'copied.txt');
  await page.keyboard.press('Escape');
  await connect('viewer', true); await open();
  await panel.getByText('Preview unavailable', { exact: true }).waitFor();
  assert.equal(await panel.getByRole('button', { name: /Edit|Clear|Download/ }).count(), 0);
  assert.equal(await panel.getByText('copied.txt', { exact: true }).count(), 0);
  assert.equal(fileReads, 1);

  set('text/plain;charset=utf-8', 'before slow read'); await connect();
  delayPreview = true; await open(); await wait(() => !!releasePreview);
  set(null); await notify(); await panel.getByText('Clipboard is empty', { exact: true }).waitFor();
  releasePreview(); releasePreview = null;
  await new Promise(resolve => setTimeout(resolve, 150));
  assert.equal(await panel.locator('pre').count(), 0, 'stale preview cannot replace an external clear');
  await page.setViewportSize({ width: 320, height: 480 });
  await wait(async () => { const bounds = await panel.boundingBox(); return bounds.x >= 0 && bounds.x + bounds.width <= 320 && bounds.y >= 0 && bounds.y + bounds.height <= 480; });
  for (let i = 0; i < 8; i++) { await page.keyboard.press('Tab'); assert.equal(await panel.evaluate(el => el.contains(document.activeElement)), true); }
  await panel.getByRole('button', { name: 'Edit', exact: true }).click(); await panel.getByRole('textbox').fill('cannot save');
  failWrite = true; await panel.getByRole('button', { name: 'Save', exact: true }).click(); await panel.getByRole('alert').waitFor();
  assert.equal(await panel.getByRole('textbox').inputValue(), 'cannot save');
  failWrite = false; await panel.getByRole('button', { name: 'Save', exact: true }).click(); await wait(() => queued.length === 1);
  await panel.getByRole('alert').filter({ hasText: /not confirmed|timed out/ }).waitFor({ timeout: 12000 }); queued = [];
  await panel.getByRole('button', { name: 'Save', exact: true }).click(); await wait(() => queued.length === 1);
  await page.evaluate(() => socket.onclose({ code: 4003, reason: 'check' }));
  await panel.getByRole('alert').waitFor();
  assert.equal(await panel.getByRole('textbox').inputValue(), 'cannot save');
  assert.match(await toggle.getAttribute('aria-label'), /unavailable/);
  assert.equal(await toggle.locator('.lucide-clipboard-x').count(), 1, 'unavailable is visibly different from empty');
  queued = [];
  const copiesBeforeReconnect = await page.evaluate(() => copies.length);
  set('text/plain;charset=utf-8', 'after reconnect');
  await page.evaluate(CONFIG => packet([CONFIG, ...new TextEncoder().encode(JSON.stringify({ streamId: 2, codec: 'vp8', width: 1280, height: 720, scale: 1 }))]), CONFIG);
  await page.waitForFunction(() => elsewhere.store.get().clipboardState.text === 'after reconnect');
  assert.equal(await page.evaluate(() => copies.length), copiesBeforeReconnect, 'reconnect refresh does not copy to browser');
  assert.equal(await panel.getByRole('textbox').inputValue(), 'cannot save', 'reconnect preserves draft');
  await page.evaluate(ROLE => packet([ROLE, 0, 0]), ROLE);
  assert.equal(await panel.getByRole('button', { name: 'Replace with draft' }).isDisabled(), true);
  await page.evaluate(ROLE => packet([ROLE, 2, 0]), ROLE);
  await page.waitForFunction(() => elsewhere.store.get().clipboardState.text === 'after reconnect');
  await panel.getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.mouse.click(1, 1);
  await panel.waitFor({ state: 'hidden' });
  assert.equal(await toggle.evaluate(el => document.activeElement === el), true, 'outside click restores toggle focus');
  assert.deepEqual(errors, []);
  assert.deepEqual(await page.evaluate(() => failures), []);
  console.log('clipboard panel: state, whitespace, drafts/conflicts, observed writes, clear, PNG limits, files/restrictions, stale reads, local input, viewport, failures and disconnect passed');
} finally {
  releasePreview?.();
  await browser.close();
  await new Promise(resolve => server.close(resolve));
  await rm(root, { recursive: true, force: true });
}
