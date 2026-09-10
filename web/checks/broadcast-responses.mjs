// Run in the Docker browser image after npm run build.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright-core';

const dist = new URL('../dist/', import.meta.url);
const server = createServer(async (req, res) => {
  try {
    const path = new URL(req.url, 'http://localhost').pathname;
    const data = await readFile(new URL(path === '/' ? 'index.html' : path.slice(1), dist));
    res.setHeader('Content-Type', path.endsWith('.js') ? 'text/javascript' : path.endsWith('.css') ? 'text/css' : 'text/html');
    res.end(data);
  } catch { res.writeHead(404).end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || '/usr/bin/chromium', args: ['--no-sandbox'] });
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, locale: 'da-DK' });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const settings = { label: 'Test broadcast', url: 'rtmp://example.invalid/live', stream_key: '', width: 640, height: 360, fps: 30, bitrate_kbps: 800, audio: 'silence', cursor: true };
  const record = (id, state) => ({ ...settings, id, state, frames: 0, bytes: 0, retries: 0, error: null });
  let runs = [record('ee', 'sending')], lists = 0, heldList, heldMutation;
  let holdLists = false, failLists = false, holdMutation = false, failMutation = false;
  const requests = [];
  await page.route('**/api/broadcasts{,/**}', async route => {
    const path = new URL(route.request().url()).pathname;
    const json = body => route.fulfill({ json: body });
    if (path.endsWith('/capabilities')) return json({ available: true, desktop_audio: false });
    if (route.request().method() === 'GET') {
      lists++;
      const snapshot = structuredClone(runs).sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
      if (holdLists) await new Promise(resolve => { heldList = resolve; });
      return failLists ? route.fulfill({ status: 503, json: { error: 'List unavailable' } }) : json(snapshot);
    }
    requests.push({ path, body: route.request().postDataJSON() });
    if (holdMutation) await new Promise(resolve => { heldMutation = resolve; });
    if (failMutation) return route.fulfill({ status: 503, json: { error: 'Start uncertain' } });
    const run = record('aa', path.endsWith('/stop') ? 'stopping' : 'starting');
    runs = [...runs.filter(s => s.id !== run.id), run];
    return json(run);
  });
  await page.addInitScript(settings => localStorage.setItem('elsewhere.broadcastPreset.test', JSON.stringify({ ...settings, preset_id: 'test' })), settings);
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.waitForFunction(() => !!window.elsewhere?.store);
  await page.evaluate(() => elsewhere.store.set({ status: 'connected', role: 'controller', permissions: ['desktop.view', 'broadcasts.manage'] }));
  const tab = page.getByRole('button', { name: 'Broadcasts', exact: true });
  if (!await tab.isVisible()) await page.getByRole('button', { name: 'Windows and Statistics', exact: true }).click();
  await tab.click();
  const panel = page.locator('[data-broadcasts]');
  const start = panel.getByRole('button', { name: 'Start', exact: true });
  const run = panel.locator('[data-broadcast-id="aa"]');
  await panel.locator('[data-broadcast-id="ee"]').waitFor();
  async function waitFor(label, predicate) {
    const deadline = Date.now() + 5000;
    while (!await predicate()) {
      if (Date.now() > deadline) throw new Error(`Timed out: ${label}`);
      await new Promise(resolve => setTimeout(resolve, 20));
    }
  }
  holdLists = true;
  await waitFor('poll started before mutation', () => heldList);
  const before = lists, started = Date.now();
  await start.click();
  await run.getByText('starting', { exact: true }).waitFor({ timeout: 1000 });
  assert.equal(await start.isEnabled(), true, 'busy clears with mutation response');
  assert.equal(lists, before, 'start does not fetch the list');
  console.log(JSON.stringify({ action: 'start', listRequests: lists - before, updateMs: Date.now() - started, stalePollHeld: true }));
  holdLists = false; heldList(); heldList = null;
  await page.waitForTimeout(100);
  assert.equal(await run.count(), 1, 'older poll cannot erase new record');
  const order = () => panel.locator('[data-broadcast-id]').evaluateAll(nodes => nodes.map(node => node.dataset.broadcastId));
  assert.deepEqual(await order(), ['aa', 'ee'], 'new record preserves unrelated records and server ordering');

  // A poll begun during the mutation also predates its returned status.
  holdMutation = true;
  await run.getByRole('button', { name: 'Stop', exact: true }).click();
  await waitFor('stop request', () => heldMutation);
  holdLists = true;
  await waitFor('poll during mutation', () => heldList);
  const beforeStop = lists, stopped = Date.now();
  holdMutation = false; heldMutation(); heldMutation = null;
  await run.getByText('stopping', { exact: true }).waitFor({ timeout: 1000 });
  assert.equal(await run.getByRole('button', { name: 'Stop', exact: true }).isDisabled(), true);
  assert.equal(await start.isEnabled(), true);
  assert.equal(lists, beforeStop, 'stop does not fetch the list');
  console.log(JSON.stringify({ action: 'stop', listRequests: lists - beforeStop, updateMs: Date.now() - stopped, stalePollHeld: true }));
  holdLists = false; heldList(); heldList = null;
  await page.waitForTimeout(100);
  assert.equal(await run.getByText('stopping', { exact: true }).count(), 1, 'older poll cannot regress stopping');
  assert.deepEqual(await order(), ['aa', 'ee'], 'known record preserves unrelated records and ordering without duplicates');

  runs = [record('aa', 'stopped'), record('ff', 'sending')];
  await run.getByText('stopped', { exact: true }).waitFor();
  await panel.locator('[data-broadcast-id="ff"]').waitFor();
  assert.equal(await panel.locator('[data-broadcast-id="ee"]').count(), 0, 'later polling reconciles full list');
  failLists = true;
  await panel.getByText('List unavailable', { exact: true }).waitFor();
  holdLists = true;
  await waitFor('failing poll held', () => heldList);
  const failingBefore = lists, retried = Date.now();
  await start.click();
  await run.getByText('starting', { exact: true }).waitFor({ timeout: 1000 });
  assert.equal(await start.isEnabled(), true);
  assert.equal(lists, failingBefore);
  assert.equal(await panel.getByText('List unavailable', { exact: true }).count(), 1, 'poll errors remain separate from action result');
  console.log(JSON.stringify({ action: 'start with failing list', listRequests: lists - failingBefore, updateMs: Date.now() - retried }));
  holdLists = false; heldList(); heldList = null;

  failMutation = true;
  await start.click();
  await panel.getByText('Start uncertain', { exact: true }).waitFor();
  const uncertain = requests.at(-1).body.request_id;
  await start.click();
  await waitFor('retry request', () => requests.filter(r => r.body.request_id === uncertain).length === 2);
  await waitFor('retry settled', () => start.isEnabled());
  assert.equal(requests.at(-1).body.request_id, uncertain, 'uncertain retry keeps request ID');
  await panel.getByRole('button', { name: 'Edit', exact: true }).click();
  await panel.getByLabel('Name', { exact: true }).fill('Changed settings');
  await panel.getByRole('button', { name: 'Save Preset', exact: true }).click();
  await start.click();
  await waitFor('changed settings request', () => requests.at(-1).body.label === 'Changed settings');
  assert.notEqual(requests.at(-1).body.request_id, uncertain);
  await page.getByRole('button', { name: 'Windows', exact: true }).click();
  await page.waitForTimeout(100);
  const closedLists = lists;
  await page.waitForTimeout(1700);
  assert.equal(lists, closedLists, 'closed panel does not poll');
  await page.evaluate(() => elsewhere.store.set({ permissions: ['desktop.view'] }));
  assert.equal(await tab.count(), 0, 'permission gates broadcast panel');
  assert.deepEqual(errors, []);
  console.log('Broadcast response application, stale polls, reconciliation, retry identity, errors and panel lifecycle passed');
} finally {
  await browser.close();
  await new Promise(resolve => server.close(resolve));
}
