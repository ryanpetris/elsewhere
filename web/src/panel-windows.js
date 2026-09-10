import { url } from './urls.js';

const titles = { audio: 'Audio Visualizer', mixer: 'Audio Mixer' };

// Pop-outs share this viewer's connection; their scripts and rendering belong to their own window.
export function createPanelWindows(viewer) {
  const windows = new Map();
  let disposed = false;

  function close(kind) {
    const entry = windows.get(kind);
    if (!entry) return;
    windows.delete(kind);
    clearTimeout(entry.timer);
    entry.cleanup?.();
    entry.win.close();
  }

  function focus(kind) {
    const entry = windows.get(kind);
    if (!entry) return false;
    if (entry.win.closed) { close(kind); return false; }
    entry.win.focus();
    return true;
  }

  function open(kind) {
    if (disposed || !titles[kind]) return false;
    if (focus(kind)) return true;
    try {
      // Open during the click so popup blockers can recognize the user gesture.
      const win = window.open(url(`/?panel=${kind}`), '_blank', 'popup,width=720,height=480');
      if (!win) throw new Error('Popup blocked');
      const entry = { win };
      windows.set(kind, entry);
      entry.timer = setTimeout(() => {
        if (windows.get(kind) !== entry) return;
        close(kind);
        viewer.notice(`${titles[kind]} could not load. Reopen the panel to try again.`);
      }, 15000);
      return true;
    } catch {
      viewer.notice(`${titles[kind]} could not open. Allow pop-ups for this site and try again.`);
      return false;
    }
  }

  function attach(win, kind) {
    const entry = windows.get(kind);
    if (disposed || !entry || entry.win !== win || entry.attached) return null;
    entry.attached = true;
    const hide = () => close(kind);
    win.addEventListener('pagehide', hide, { once: true });
    return {
      viewer,
      title: titles[kind],
      close: hide,
      ready(cleanup) {
        clearTimeout(entry.timer);
        entry.cleanup = () => { win.removeEventListener('pagehide', hide); cleanup(); };
      },
    };
  }

  const closeAll = () => { for (const kind of windows.keys()) close(kind); };
  window.addEventListener('pagehide', closeAll);
  return { open, focus, close, attach, dispose() {
    disposed = true;
    closeAll();
    window.removeEventListener('pagehide', closeAll);
  } };
}
