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

  function refresh(force = false) {
    if (!readable()) return Promise.resolve();
    if (flight && !force) return flight;
    if (force) invalidate();
    const epoch = generation, controller = abort = new AbortController();
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(5000)]);
    const valid = () => epoch === generation && connected();
    const run = async () => {
      const response = await api('/api/clipboard/state', { signal });
      if (!response.ok) throw Error('Could not read the desktop clipboard');
      const meta = await response.json();
      if (!valid()) return;
      if (typeof meta.present !== 'boolean' || typeof meta.observation !== 'string'
          || !['empty', 'available', 'loading', 'unavailable', 'restricted'].includes(meta.preview)) throw Error('Clipboard state is unavailable');
      const changed = meta.observation !== current().observation || meta.preview !== current().preview;
      if (changed) publish({ ...initial(), ...meta, status: 'ready' });
      else publish({ ...meta, status: 'ready', error: '' });
      if (!meta.present) {
        publish({ text: '', files: [], blob: null });
        syncPending = false;
        return;
      }
      if (meta.preview !== 'available') {
        if (meta.preview !== 'loading') syncPending = false;
        return;
      }
      if (!opened && !syncPending) return;
      if (!changed && (current().text !== null || current().blob) && !syncPending) return;
      const expected = textMime(meta.mime) ? 'text/plain' : meta.mime;
      const limit = meta.mime === 'image/png' ? CLIPBOARD_IMAGE_BYTES : 1024 * 1024;
      if (!['text/plain', 'text/uri-list', 'image/png'].includes(expected) || meta.size > limit) {
        publish({ preview: 'unavailable', text: null, files: [], blob: null }); syncPending = false; return;
      }
      const data = await api('/api/clipboard', { signal, headers: { 'If-Match': `"${meta.observation}"` } });
      if (!data.ok || data.status === 204) throw Error('Clipboard changed or its preview is unavailable');
      if (data.headers.get('Content-Type')?.split(';')[0].trim().toLowerCase() !== expected) throw Error('Clipboard preview type changed');
      const blob = await data.blob();
      if (!valid()) return;
      if (blob.size > limit) throw Error('Clipboard preview is too large');
      if (expected === 'image/png') {
        publish({ blob, text: null, files: [] });
        if (syncPending) copy({ mime: 'image/png', blob });
      } else {
        const text = await blob.text();
        if (!valid()) return;
        const files = expected === 'text/uri-list' ? text.split(/\r?\n/).filter(line => line.startsWith('file://')).map(filename) : [];
        publish({ text, files, blob: null });
        if (syncPending && !files.length) copy(text);
      }
      syncPending = false;
    };
    flight = run().catch(error => {
      if (valid() && !controller.signal.aborted) {
        syncPending = false;
        publish({ status: current().observation === null ? 'unavailable' : 'ready', preview: 'unavailable', text: null, files: [], blob: null, error: error.message });
      }
    }).finally(() => { if (epoch === generation) { flight = null; abort = null; } });
    return flight;
  }

  function changed(sync = false) {
    syncPending = sync;
    invalidate();
    publish({ ...initial(), status: connected() ? 'loading' : 'unavailable' });
    return refresh();
  }

  async function write(text) {
    if (!authorized()) throw Error('Clipboard changes are not available');
    if (pending) throw Error('A clipboard change is already pending');
    if (new TextEncoder().encode(text).length > 1024 * 1024) throw Error('Text exceeds the 1 MiB clipboard limit');
    pending = true;
    const controller = writeAbort = new AbortController();
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(5000)]);
    try {
      const response = await api('/api/clipboard', { method: 'PUT', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: text, signal });
      if (!response.ok) throw Error('Could not change the desktop clipboard');
      const { operation } = await response.json();
      if (typeof operation !== 'string') throw Error('Clipboard confirmation is unavailable');
      if (!readable()) return;
      const deadline = performance.now() + 5000;
      while (!signal.aborted && performance.now() < deadline) {
        if (!authorized()) throw Error('Disconnected or no longer allowed to change the clipboard');
        await refresh(true);
        if (current().operation === operation) { copy(text); return; }
        await new Promise(resolve => setTimeout(resolve, 125));
      }
      throw Error('Clipboard change was not confirmed. It may have been replaced by another copy.');
    } finally {
      if (writeAbort === controller) writeAbort = null;
      pending = false;
    }
  }

  const unsubscribe = store.subscribe(() => {
    const next = `${store.get().status}:${store.get().permissions.join()}`;
    if (next === session) return;
    session = next;
    copy(null);
    writeAbort?.abort(); syncPending = false;
    invalidate();
    publish({ ...initial(), status: connected() ? 'loading' : 'unavailable' });
    if (connected()) refresh();
  });
  // A dropped copy event cannot leave the status icon stale indefinitely.
  const timer = setInterval(() => { if (connected()) refresh(); }, 2000);
  return {
    refresh, changed, write,
    read: async () => { if (!readable()) throw Error('Clipboard reading is not allowed'); const r = await api('/api/clipboard'); if (!r.ok) throw Error('Clipboard preview is unavailable'); return r.text(); },
    open() { opened = true; return refresh(true); },
    close() { opened = false; invalidate(); publish({ text: null, files: [], blob: null }); },
    dispose() { disposed = true; invalidate(); writeAbort?.abort(); clearInterval(timer); unsubscribe(); },
  };
}
