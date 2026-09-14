import { url as publicUrl } from './urls.js';
import { TOKEN, WINDOW, PIP } from './api.js';

// Each iframe keeps the existing viewer's handlers, renderer and media in its own document.
export function createPip(viewer) {
  const supported = !PIP && window === window.top && isSecureContext && !!window.documentPictureInPicture?.requestWindow;
  let owned, pending = false, disposed = false, inactive = false;

  function clearContent(entry, restore = true) {
    clearTimeout(entry.timer);
    entry.unsubscribe?.();
    entry.unsubscribe = null;
    entry.parentUnsubscribe?.();
    entry.parentUnsubscribe = null;
    const child = entry.child;
    entry.child = null;
    if (child) {
      child.releaseInput();
      child.dispose();
    }
    entry.frame?.remove();
    entry.frame = null;
    if (entry.desktop) { viewer.setPipDesktop(false); if (restore) viewer.setPlaybackEnabled(true); }
  }

  function close(restore = true) {
    const entry = owned;
    if (!entry) return;
    owned = null;
    clearContent(entry, restore);
    entry.win.close();
  }

  async function open(id = WINDOW) {
    if (!supported || disposed || inactive || pending) return;
    const target = id == null ? null : String(id);
    if (owned && !owned.win.closed && owned.target === target) { owned.win.focus(); return; }
    if (target === null && !viewer.participant()) return;
    pending = true;
    try {
      // requestWindow must run in the original click, before any await.
      const win = owned?.win && !owned.win.closed ? owned.win : await documentPictureInPicture.requestWindow({ width: 640, height: 480 });
      if (disposed || inactive) { win.close(); return; }
      if (owned) { const previous = owned; owned = null; clearContent(previous); }
      const entry = owned = { win, target, desktop: target === null };
      win.onpagehide = () => { if (owned === entry) close(); };
      // The child's compact-mode detection reads this before its module evaluates.
      win.elsewhereReturn = () => { window.focus(); close(); };
      win.elsewhereParticipant = () => viewer.store.get().participantId != null ? viewer.participant() : null;
      win.elsewhereOpenFiles = path => { window.focus(); close(); viewer.openFiles(path); };
      win.document.title = 'Elsewhere';
      win.document.body.style.cssText = 'margin:0;height:100vh;background:#09090b';
      const frame = entry.frame = win.document.createElement('iframe');
      frame.title = target === null ? 'Remote desktop' : `Remote window ${target}`;
      frame.style.cssText = 'width:100%;height:100%;border:0;display:block';
      frame.allow = 'autoplay; clipboard-read; clipboard-write; microphone; camera';
      const url = new URL(publicUrl('/'), location.origin);
      url.searchParams.set('pip', '1');
      if (target !== null) url.searchParams.set('window', target);
      url.hash = new URLSearchParams({ token: TOKEN }).toString();
      frame.src = url.href;
      frame.onload = () => {
        if (owned !== entry) return;
        const child = entry.child = frame.contentWindow.elsewhere;
        if (!child) return; // the connection deadline also covers an initial about:blank load
        const update = () => {
          if (owned !== entry) return;
          const state = child.store.get();
          const parent = viewer.store.get();
          if (entry.desktop && parent.participantId == null && ['unauthorized', 'no-token', 'error', 'gone', 'closed', 'quit'].includes(parent.status)) { close(); return; }
          const title = state.windowTitle || (entry.desktop ? 'Remote desktop' : `Window ${target}`);
          if (win.document.title !== title) win.document.title = title;
          if (['unauthorized', 'no-token', 'error', 'gone', 'closed', 'quit'].includes(state.status)) { close(); return; }
          if (state.streamState) clearTimeout(entry.timer);
          if (entry.desktop) {
            const active = state.status === 'connected' && state.participantId != null && child.participant()?.secret === viewer.participant()?.secret;
            child.setPlaybackEnabled(active);
            viewer.setPlaybackEnabled(!active);
            viewer.setPipDesktop(active);
          }
          if (state.status !== 'connected') return;
          clearTimeout(entry.timer);
        };
        entry.unsubscribe = child.store.subscribe(update);
        if (entry.desktop) entry.parentUnsubscribe = viewer.store.subscribe(update);
        frame.contentWindow.addEventListener('pagehide', () => { if (owned === entry) close(); }, { once: true });
        update();
      };
      entry.timer = setTimeout(() => { if (owned === entry) { viewer.notice('Picture-in-picture viewer did not connect.'); close(); } }, 15000);
      win.document.body.replaceChildren(frame);
      win.focus();
    } catch {
      viewer.notice('Picture-in-picture could not open. Try again from the viewer button.');
      close();
    } finally { pending = false; }
  }

  const hide = () => { inactive = true; close(false); };
  const show = () => { if (!inactive) return; inactive = false; viewer.setPlaybackEnabled(true); };
  const dispose = () => {
    disposed = true; close(false);
    window.removeEventListener('pagehide', hide);
    window.removeEventListener('pageshow', show);
  };
  if (supported) {
    window.addEventListener('pagehide', hide);
    window.addEventListener('pageshow', show);
  }
  return { supported, open, close, dispose };
}
