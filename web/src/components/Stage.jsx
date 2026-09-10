// The display: the video canvas, sized by its container (the desktop's output takes that size), with
// the overlays and status banners on top.
import { useEffect, useRef, useState } from 'react';
import { CheckCircle2, FolderOpen, Loader2, MonitorX, TriangleAlert } from 'lucide-react';
import { useStore } from '../store.js';
import { hue, windowColor, codecName } from './ui.jsx';
import { Notifications } from './Notifications.jsx';

export function Stage({ viewer, windowMode, borders, elements, children }) {
  const releasedMouse = useStore(viewer.store, s => s.captureOnClick && !s.locked);
  const el = useRef(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  useEffect(() => {
    const measure = () => {
      const { width, height } = el.current.getBoundingClientRect();
      setSize({ w: width, h: height });
      viewer.setStage(width, height);
    };
    const ro = new ResizeObserver(measure);
    ro.observe(el.current);
    // a move to a display with another scale can leave the CSS size alone: watch the ratio too
    let dpr;
    const watchDpr = () => {
      dpr?.removeEventListener('change', onDpr);
      dpr = matchMedia(`(resolution: ${devicePixelRatio}dppx)`);
      dpr.addEventListener('change', onDpr);
    };
    const onDpr = () => { measure(); watchDpr(); };
    watchDpr();
    return () => { ro.disconnect(); dpr.removeEventListener('change', onDpr); };
  }, [viewer]);
  return (
    <div ref={el} className="viewer-stage relative flex min-w-0 flex-1 items-center justify-center overflow-hidden bg-black">
      <canvas ref={viewer.attach} tabIndex={-1} className={`stage block outline-none ${windowMode ? '' : 'h-full w-full'} ${!windowMode && releasedMouse ? 'cursor-default!' : ''}`} />
      {(borders || elements) && <Overlay viewer={viewer} size={size} borders={borders} elements={elements} />}
      <Banner viewer={viewer} />
      <Notice viewer={viewer} />
      <Notifications viewer={viewer} />
      {children}
    </div>
  );
}

// One rectangle per visible window (the same hue as its row) and one per element of the focused
// window, in CSS px over the canvas, which sits centred in the stage at the size fitCanvas gives it
// (the desktop's; a window tab has no overlays).
function Overlay({ viewer, size, borders, elements }) {
  const windows = useStore(viewer.store, s => s.windows);
  const stream = useStore(viewer.store, s => s.stream);
  const els = useStore(viewer.store, s => s.elements);
  if (!stream || !size.w) return null;
  const sw = stream.width / stream.scale, sh = stream.height / stream.scale;
  const k = Math.min(size.w / sw, size.h / sh);
  const ox = (size.w - sw * k) / 2, oy = (size.h - sh * k) / 2;
  const box = (x, y, w, h) => ({ left: ox + x * k, top: oy + y * k, width: w * k, height: h * k });
  const f = windows.find(w => w.focused && !w.minimized);
  const page = elements && f && els?.id === f.id ? els : null;
  const why = page && (page.status !== 200 ? page.page.error || `HTTP ${page.status}` : page.page.level !== 'full' && `no elements: ${page.page.level}${page.page.toolkit ? ` (${page.page.toolkit})` : ''}`);
  return (
    <div className="pointer-events-none absolute inset-0 overflow-hidden">
      {borders && windows.filter(w => !w.minimized).map(w => (
        // the compositor's title bar, when it draws one, is part of the window
        <div key={w.id} className={`absolute box-border rounded-sm ${w.focused ? 'border-[3px]' : 'border-2'}`} style={{ ...box(w.x, w.y - w.decoration, w.w, w.h + w.decoration), borderColor: windowColor(w) }}>
          <span className="absolute -top-0.5 -left-0.5 rounded-br px-1.5 font-mono text-[11px] leading-4 font-medium text-canvas" style={{ background: windowColor(w) }}>
            {w.app_id || w.title}
          </span>
        </div>
      ))}
      {page && (page.page.elements ?? []).map((e, i) => (
        <div key={i} className="absolute box-border border" style={{ ...box(f.x + e.x, f.y + e.y, e.w, e.h), borderColor: `hsl(${hue(e.role)} 80% 55%)` }} />
      ))}
      {why && (
        <div className="absolute rounded-b-md bg-surface/90 px-2 font-mono text-[11px] leading-5 whitespace-nowrap text-ink backdrop-blur" style={{ left: ox + f.x * k, top: oy + (f.y + f.h) * k }}>
          {why}
        </div>
      )}
    </div>
  );
}

// A few seconds of what the server said about the last action (a click an X11 window can't take).
function Notice({ viewer }) {
  const notice = useStore(viewer.store, s => s.notice);
  if (!notice) return null;
  const good = notice.kind === 'success';
  return (
    <div className={`pointer-events-none absolute bottom-3 left-1/2 flex max-w-[90%] -translate-x-1/2 animate-rise items-center gap-2.5 rounded-lg border bg-surface/95 px-3 py-2 text-xs shadow-pop backdrop-blur ${good ? 'border-ok/30 text-ink' : 'border-warn/30 text-ink'}`}>
      {good ? <CheckCircle2 className="size-4 shrink-0 text-ok" /> : <TriangleAlert className="size-4 shrink-0 text-warn" />} {notice.text}
      {notice.path && <button className="btn btn-outline btn-xs pointer-events-auto shrink-0" onClick={() => viewer.openFiles(notice.path)}><FolderOpen className="size-3" /> Open Folder</button>}
    </div>
  );
}

// What the connection is doing, when it isn't simply showing the desktop.
function Banner({ viewer }) {
  const status = useStore(viewer.store, s => s.status);
  const reason = useStore(viewer.store, s => s.reason);
  const stream = useStore(viewer.store, s => s.stream);
  const encoding = useStore(viewer.store, s => s.streamState);
  if (['connected', 'connecting'].includes(status) && ['failed', 'retrying', 'switching'].includes(encoding?.status)) {
    return (
      <div role="status" className="absolute top-3 rounded-xl border border-line-2 bg-surface/95 px-4 py-3 text-sm text-ink shadow-pop">
        {encoding.status === 'failed' ? <>
          Video encoding failed.
          <button type="button" className="ml-3 underline" onClick={() => viewer.setChoice({ codec: viewer.store.get().choice.codec })}>Retry Video</button>
        </> : `${encoding.status === 'retrying' ? 'Retrying' : 'Switching to'} ${codecName(encoding.codec)}…`}
      </div>
    );
  }
  if (status === 'connected' || status === 'no-token'  || status === 'unauthorized') return null;
  if (status === 'retrying' || (status === 'connecting' && stream)) {
    return (
      <div className="absolute top-3 left-1/2 flex -translate-x-1/2 animate-pop items-center gap-2 rounded-full border border-line-2 bg-surface/90 px-3 py-1 text-xs text-ink-2 shadow-pop backdrop-blur">
        <Loader2 className="size-3.5 animate-spin text-warn" /> {reason ? `${reason}. Retrying…` : 'Reconnecting…'}
      </div>
    );
  }
  const card = 'absolute flex animate-pop flex-col items-center gap-3 rounded-2xl border border-line-2 bg-surface/95 px-10 py-8 text-center shadow-pop backdrop-blur';
  if (status === 'quit') {
    return (
      <div className={card}>
        <span className="flex size-12 items-center justify-center rounded-xl bg-surface-3 text-ink-3"><MonitorX className="size-6" strokeWidth={1.5} /></span>
        <div className="text-sm font-medium text-ink">Elsewhere Shut Down</div>
        <div className="text-xs text-ink-3">Start it again and reload this page.</div>
      </div>
    );
  }
  if (status === 'connecting') {
    return (
      <div className={card}>
        <Loader2 className="size-6 animate-spin text-accent-2" />
        <div className="text-sm text-ink-2">Connecting…</div>
      </div>
    );
  }
  return (
    <div className={card}>
      <span className="flex size-12 items-center justify-center rounded-xl bg-surface-3 text-ink-3"><MonitorX className="size-6" strokeWidth={1.5} /></span>
      <div className="text-sm font-medium text-ink">{status === 'closed' ? 'Viewer Closed' : reason || 'Window Closed'}</div>
      {(status === 'closed' || status === 'error') && <div className="text-xs text-ink-3">Reload this page to reconnect.</div>}
    </div>
  );
}
