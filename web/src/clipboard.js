import { api } from './api.js';

export const CLIPBOARD_IMAGE_BYTES = 16 * 1024 * 1024;
export const CLIPBOARD_IMAGE_PIXELS = 16 * 1024 * 1024;
const textMime = mime => ['text/plain;charset=utf-8', 'text/plain', 'UTF8_STRING', 'TEXT', 'STRING'].includes(mime);
const initial = () => ({ status: 'loading', present: null, mime: null, size: null, preview: 'loading', observation: null, operation: null, text: null, files: [], blob: null, error: '' });
const filename = uri => { try { return decodeURIComponent(uri.trim().split('/').pop()); } catch { return uri.trim().split('/').pop(); } };

// Metadata reads never copy into the browser clipboard. Only a live copy event or an observed write does.
export function createClipboard(store, copy) {
  let opened = false, disposed = false, generation = 0, flight, abort, writeAbort, syncPending = false;
  let session = '', pending = false;
  const current = () => store.get().clipboardState;
  const connected = () => !disposed && store.get().status === 'connected';
  const authorized = () => connected() && store.get().permissions.includes('clipboard.write');
  const readable = () => connected() && store.get().permissions.includes('clipboard.read');
  const publish = patch => store.set({ clipboardState: { ...current(), ...patch } });
  store.set({ clipboardState: initial() });

  function invalidate() {
    generation++;
    abort?.abort(); abort = null; flight = null;
  }

  const retained = new Map();
  let retainedBytes = 0, localWrite = null;
  function retain(request, blob) {
    if (!readable() || blob.size > CLIPBOARD_IMAGE_BYTES) return;
    while (retained.size && (retained.size >= 16 || retainedBytes + blob.size > CLIPBOARD_IMAGE_BYTES)) {
      const first = retained.keys().next().value;
      retainedBytes -= retained.get(first).size; retained.delete(first);
    }
    retained.set(request, blob); retainedBytes += blob.size;
  }
  const older = observation => {
    const [scope, number] = observation.split(':'), [previousScope, previousNumber] = (current().observation || '').split(':');
    return scope === previousScope && BigInt(number) < BigInt(previousNumber);
  };

  async function materialize(meta, signal, valid) {
    if (!meta.present) { publish({ text: '', files: [], blob: null }); syncPending = false; return; }
    if (meta.preview !== 'available') { if (meta.preview !== 'loading') syncPending = false; return; }
    if (!opened && !syncPending) return;
    const expected = textMime(meta.mime) ? 'text/plain' : meta.mime;
    const limit = meta.mime === 'image/png' ? CLIPBOARD_IMAGE_BYTES : 1024 * 1024;
    if (!['text/plain', 'text/uri-list', 'image/png'].includes(expected) || meta.size > limit) {
      publish({ preview: 'unavailable', text: null, files: [], blob: null }); syncPending = false; return;
    }
    let blob = current().blob, text = current().text;
    if (expected === 'text/plain' && localWrite?.operation && localWrite.operation === meta.operation) text = localWrite.text;
    // Until the response identifies this write, its body cannot be correlated with a metadata read.
    if (expected === 'text/plain' && text === null && localWrite && !localWrite.operation) return;
    if (!blob && text === null) {
      const data = await api('/api/clipboard', { signal, headers: { 'If-Match': `"${meta.observation}"` } });
      if (!data.ok || data.status === 204) throw Error('Clipboard changed or its preview is unavailable');
      if (data.headers.get('Content-Type')?.split(';')[0].trim().toLowerCase() !== expected) throw Error('Clipboard preview type changed');
      blob = await data.blob();
      if (!valid()) return;
      if (blob.size > limit) throw Error('Clipboard preview is too large');
      if (expected !== 'image/png') { text = await blob.text(); if (!valid()) return; blob = null; }
    }
    if (expected === 'image/png') {
      publish({ blob, text: null, files: [] });
      if (syncPending) copy({ mime: 'image/png', blob });
    } else {
      const files = expected === 'text/uri-list' ? text.split(/\r?\n/).filter(line => line.startsWith('file://')).map(filename) : [];
      publish({ text, files, blob: null });
      if (syncPending && expected === 'text/plain') copy(text);
    }
    syncPending = false;
  }

  function accept(meta, live) {
    if (typeof meta.present !== 'boolean' || !/^[^:]+:\d+$/.test(meta.observation)
        || !['empty', 'available', 'loading', 'unavailable', 'restricted'].includes(meta.preview)) throw Error('Clipboard state is unavailable');
    if (localWrite && meta.operation) {
      localWrite.seen.add(meta.operation);
    }
    if (older(meta.observation)) return false;
    const changed = meta.observation !== current().observation || meta.preview !== current().preview;
    if (changed) { copy(null); publish({ ...initial(), ...meta, status: 'ready' }); }
    else publish({ ...meta, status: 'ready', error: '' });
    if (live) syncPending = true;
    if (live && typeof meta.text === 'string' && textMime(meta.mime)
        && meta.size <= 1024 * 1024) {
      publish({ text: meta.text }); copy(meta.text); syncPending = false;
    }
    const source = meta.source;
    if (source && source.session === String(store.get().sessionId) && meta.mime === 'image/png') {
      const blob = retained.get(source.request);
      if (blob && blob.size === meta.size && meta.preview === 'available') {
        publish({ blob, text: null, files: [] }); syncPending = false;
      }
    }
    return true;
  }

  function run(load) {
    invalidate();
    const epoch = generation, controller = abort = new AbortController();
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(5000)]);
    const valid = () => epoch === generation && readable();
    flight = load(signal, valid).catch(error => {
      if (valid() && !controller.signal.aborted) {
        syncPending = false;
        publish({ status: current().observation === null ? 'unavailable' : 'ready', preview: 'unavailable', text: null, files: [], blob: null, error: error.message });
      }
    }).finally(() => { if (epoch === generation) { flight = null; abort = null; } });
    return flight;
  }
  function refresh(force = false) {
    if (!readable()) return Promise.resolve();
    if (flight && !force) return flight;
    return run(async (signal, valid) => {
      const response = await api('/api/clipboard/state', { signal });
      if (!response.ok) throw Error('Could not read the desktop clipboard');
      const meta = await response.json();
      if (valid() && accept(meta, false)) await materialize(meta, signal, valid);
    });
  }
  function observed(meta) {
    if (!readable()) return;
    return run(async (signal, valid) => { if (accept(meta, true)) await materialize(meta, signal, valid); });
  }

  async function write(text) {
    if (!authorized()) throw Error('Clipboard changes are not available');
    if (pending) throw Error('A clipboard change is already pending');
    if (new TextEncoder().encode(text).length > 1024 * 1024) throw Error('Text exceeds the 1 MiB clipboard limit');
    pending = true;
    const write = localWrite = { text, operation: null, seen: new Set() };
    const controller = writeAbort = new AbortController();
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(5000)]);
    try {
      const response = await api('/api/clipboard', { method: 'PUT', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: text, signal });
      if (!response.ok) throw Error('Could not change the desktop clipboard');
      const { operation } = await response.json();
      if (typeof operation !== 'string') throw Error('Clipboard confirmation is unavailable');
      if (!authorized() || signal.aborted) throw Error('Disconnected or no longer allowed to change the clipboard');
      write.operation = operation;
      if (!readable()) return;
      const confirmed = () => {
        if (current().operation === operation) {
          publish({ text, blob: null, files: [], preview: text ? 'available' : 'empty' });
          copy(text);
          return true;
        }
        return write.seen.has(operation);
      };
      const deadline = performance.now() + 5000;
      while (!signal.aborted && performance.now() < deadline) {
        if (!authorized()) throw Error('Disconnected or no longer allowed to change the clipboard');
        if (confirmed()) return;
        await refresh(true);
        if (!authorized() || signal.aborted) throw Error('Disconnected or no longer allowed to change the clipboard');
        if (confirmed()) return;
        await new Promise(resolve => setTimeout(resolve, 125));
      }
      throw Error('Clipboard change was not confirmed. It may have been replaced by another copy.');
    } finally {
      if (writeAbort === controller) writeAbort = null;
      pending = false;
      if (localWrite === write) localWrite = null;
    }
  }

  const unsubscribe = store.subscribe(() => {
    const next = `${store.get().status}:${store.get().permissions.join()}`;
    if (next === session) return;
    session = next;
    copy(null);
    writeAbort?.abort(); syncPending = false;
    retained.clear(); retainedBytes = 0;
    invalidate();
    publish({ ...initial(), status: connected() ? 'loading' : 'unavailable' });
    if (connected()) refresh();
  });
  // A dropped copy event cannot leave the status icon stale indefinitely.
  const timer = setInterval(() => { if (connected()) refresh(); }, 2000);
  return {
    refresh, observed, retain, write,
    read: async () => { if (!readable()) throw Error('Clipboard reading is not allowed'); const r = await api('/api/clipboard'); if (!r.ok) throw Error('Clipboard preview is unavailable'); return r.text(); },
    open() { opened = true; return refresh(true); },
    close() { opened = false; invalidate(); publish({ text: null, files: [], blob: null }); },
    dispose() { disposed = true; retained.clear(); retainedBytes = 0; invalidate(); writeAbort?.abort(); clearInterval(timer); unsubscribe(); },
  };
}
