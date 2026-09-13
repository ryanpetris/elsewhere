// Run in Docker against the built viewer and Chromium.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright-core';
import { KEY, BLUR, CONTROL } from '../src/protocol.js';

let requests = 0, launches = 0, finishLaunch, delayLaunch = false;
const server = createServer(async (req, res) => {
  const path = new URL(req.url, 'http://localhost').pathname;
  if (path.startsWith('/api/')) {
    res.setHeader('Content-Type', 'application/json');
    if (path === '/api/applications') { requests++; return res.end(JSON.stringify(Array.from({ length: 500 }, (_, i) => ({ id: `app${i}`, name: i < 2 ? 'Duplicate application' : `Application ${i}`, comment: 'Palette fixture', categories: [] })))); }
    if (path === '/api/control') { launches++; if (delayLaunch) { finishLaunch = () => res.end('{}'); return; } return res.end('{}'); }
    if (path.endsWith('/icon')) { res.writeHead(404); return res.end('{}'); }
    return res.end('[]');
  }
  try {
    res.setHeader('Content-Type', path.endsWith('.js') ? 'text/javascript' : path.endsWith('.css') ? 'text/css' : 'text/html');
    res.end(await readFile(new URL('../dist/' + (path === '/' ? 'index.html' : path.slice(1)), import.meta.url)));
  } catch { res.writeHead(404).end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const browser = await chromium.launch({ executablePath: '/usr/bin/chromium', headless: true, args: ['--no-sandbox'] });
try {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.addInitScript(() => {
    window.sent = [];
    window.WebSocket = class {
      static OPEN = 1; readyState = 1;
      constructor() { queueMicrotask(() => this.onopen?.({})); }
      send(data) { sent.push([...new Uint8Array(data)]); }
      close() {}
    };
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  await page.goto(origin + '/#token=fixture');
  await page.waitForFunction(() => !!window.elsewhere?.store);
  const permissions = ['desktop.view', 'desktop.control', 'apps.launch', 'files.browse', 'commands.execute'];
  await page.evaluate(permissions => elsewhere.store.set({ status: 'connected', permissions, role: 'controller', windows: [
    { id: 1, title: 'Duplicate', app_id: 'fixture', z: 1 }, { id: 2, title: 'Duplicate', app_id: 'fixture', minimized: true, z: 2 },
  ] }), permissions);
  const input = page.getByRole('combobox', { name: 'Search commands' });
  const open = async () => { await page.keyboard.press('Control+Alt+Shift+P'); await input.waitFor(); };
  const begin = performance.now();
  await open();
  await page.locator('[data-entry="app:app499"]').waitFor();
  console.log('500 applications open in ms:', Math.round(performance.now() - begin));
  assert.match(await page.locator('[data-entry="app:app0"]').innerText(), /app0/);
  assert.match(await page.locator('[data-entry="app:app1"]').innerText(), /app1/);
  assert.equal(await page.getByRole('group', { name: 'Windows', exact: true }).getByRole('option').count(), 2);
  assert.match(await page.locator('[data-entry="window:2"]').innerText(), /#2.*Minimized/);
  assert.equal(await page.getByRole('group', { name: 'Viewer actions' }).getByRole('option').count(), 6);
  const filterStart = performance.now();
  await input.fill('application 499');
  await page.waitForFunction(() => document.querySelectorAll('[data-entry]').length === 1);
  console.log('500 applications filter in ms:', Math.round(performance.now() - filterStart));
  await input.press('Enter');
  await input.waitFor({ state: 'hidden' });
  assert.equal(launches, 1);
  await open();
  await input.fill('fixture · #');
  await input.press('ArrowDown');
  await page.evaluate(() => elsewhere.store.set({ windows: elsewhere.store.get().windows.filter(w => w.id !== 2) }));
  await input.press('Enter');
  assert.match(await page.getByRole('alert').innerText(), /no longer available/);
  assert.equal(await page.evaluate(tag => sent.filter(bytes => bytes[0] === tag).length, CONTROL), 0);
  await input.press('ArrowDown');
  await input.press('Enter');
  await input.waitFor({ state: 'hidden' });
  assert.equal(await page.evaluate(tag => sent.filter(bytes => bytes[0] === tag).length, CONTROL), 1);
  await page.locator('canvas.stage').focus();
  await page.keyboard.down('a');
  await open();
  const afterOpen = await page.evaluate(() => sent.length);
  await input.fill('Settings');
  await input.dispatchEvent('compositionstart');
  await input.press('Enter');
  assert.equal(await input.isVisible(), true);
  await input.dispatchEvent('compositionend');
  await input.press('Escape');
  await page.keyboard.up('a');
  assert.equal(await page.evaluate(({ start, key }) => sent.slice(start).filter(b => b[0] === key).length, { start: afterOpen, key: KEY }), 0);
  assert(await page.evaluate(tag => sent.some(b => b[0] === tag), BLUR));
  let delayedTerminal;
  await page.route('**/assets/TerminalPanel-*.js', route => { delayedTerminal = route; });
  await open(); await input.fill('Terminal');
  await page.locator('[data-entry="action:terminal"]').click();
  for (let i = 0; !delayedTerminal && i < 100; i++) await page.waitForTimeout(10);
  assert(delayedTerminal);
  await input.press('Escape'); await open();
  await delayedTerminal.continue();
  await page.waitForTimeout(100);
  assert(await input.isVisible());
  assert.equal(await page.getByRole('region', { name: 'Terminal' }).count(), 0, 'dismissed terminal import cannot open a panel');
  await input.press('Escape');
  const beforeRequests = requests;
  for (let i = 0; i < 3; i++) {
    await open(); await page.locator('[data-entry="app:app499"]').waitFor(); await input.press('Escape');
  }
  assert.equal(requests - beforeRequests, 3, 'one application request per opening');
  delayLaunch = true;
  await open(); await input.fill('application 3');
  await page.locator('[data-entry="app:app3"]').waitFor();
  await input.press('Enter');
  for (let i = 0; !finishLaunch && i < 100; i++) await page.waitForTimeout(10);
  assert(finishLaunch);
  await input.press('Escape'); await open();
  finishLaunch(); delayLaunch = false;
  await page.waitForTimeout(50);
  assert(await input.isVisible(), 'an old launch cannot dismiss a reopened palette');
  await input.fill('Duplicate');
  await page.evaluate(() => elsewhere.store.set({ windows: elsewhere.store.get().windows.map(w => ({ ...w, title: 'Renamed window' })) }));
  await page.waitForFunction(() => !document.querySelector('[data-entry^="window:"]'));
  await input.fill('Renamed');
  await page.locator('[data-entry="window:1"]').waitFor();
  const completedLaunches = launches;
  await input.fill('application');
  await page.evaluate(() => elsewhere.store.set({ permissions: ['desktop.view'] }));
  await page.waitForFunction(() => !document.querySelector('[data-entry^="app:"]'));
  await input.press('Enter');
  assert.equal(launches, completedLaunches);
  await input.fill('');
  assert.equal(await page.locator('[data-entry="action:files"]').count(), 0);
  assert.equal(await page.locator('[data-entry="action:terminal"]').count(), 0);
  await input.press('Escape');
  await page.evaluate(() => elsewhere.setControlsHidden(true));
  await open();
  const pointerStart = await page.evaluate(() => sent.length);
  await page.mouse.click(5, 5);
  await input.waitFor({ state: 'hidden' });
  assert.equal(await page.evaluate(start => sent.slice(start).filter(b => [0x83, 0x84, 0x85].includes(b[0])).length, pointerStart), 0, 'hidden top edge dismisses without desktop pointer input');
  assert.equal(await page.locator('canvas.stage').evaluate(el => el === document.activeElement), true);
  await page.evaluate(() => elsewhere.setControlsHidden(false));
  await page.locator('#apps-toggle').click();
  await input.press('Tab'); assert(await input.evaluate(el => el === document.activeElement));
  await page.keyboard.press('Control+Alt+Shift+P');
  await input.waitFor({ state: 'hidden' });
  assert(await page.locator('#apps-toggle').evaluate(el => el === document.activeElement));
  await open();
  await input.fill('settings');
  await input.press('Enter');
  await page.locator('#viewer-settings').waitFor();
  await page.keyboard.press('Escape');
  const before = requests;
  for (let i = 0; i < 10; i++) { await open(); await input.press('Escape'); }
  assert.equal(requests, before, 'no application requests without apps.launch');
  await page.goto(origin + '/?window=1#token=fixture');
  await page.waitForFunction(() => !!window.elsewhere?.store);
  await page.evaluate(permissions => elsewhere.store.set({ status: 'connected', permissions, role: 'controller' }), permissions);
  await open();
  assert.deepEqual(await page.getByRole('option').allTextContents(), ['Fullscreen', 'Hide Controls']);
  await input.press('Escape');
  await page.evaluate(() => elsewhere.store.set({ status: 'unauthorized', permissions: [] }));
  await page.waitForFunction(() => !document.getElementById('apps-toggle'));
  await page.keyboard.press('Control+Alt+Shift+P');
  assert.equal(await input.count(), 0, 'authorization form keeps the palette unavailable');
  assert.deepEqual(errors, []);
  console.log('Palette search, stale selection, grants, composition, held input, hidden controls, settings, popup and repeated opening passed');
} finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
