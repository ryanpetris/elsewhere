import { url, storageKey } from '../urls.js';
// The side panel: the window list (with actions and a command box), the transfer folder, the statistics, or the broadcasts.
import { useEffect, useRef, useState } from 'react';
import { Activity, AppWindow, Camera, ChevronDown, ChevronRight, ChevronUp, ExternalLink, FolderOpen, Maximize2, Minimize2, PictureInPicture2, Play, Radio, X } from 'lucide-react';
import { useStore } from '../store.js';
import { queueSnapshot, snapshot, windowIcon } from '../api.js';
import { BroadcastsPanel } from './BroadcastsPanel.jsx';
import { FilesPanel } from './FilesPanel.jsx';
import { thumbnailScheduler } from '../thumbnails.js';
import { Badge, Eyebrow, IconButton, codecName, cx, windowColor } from './ui.jsx';
import { STATUS_BAR_HEIGHT } from './StatusBar.jsx';

const TABS = [['windows', 'Windows', AppWindow], ['files', 'Files', FolderOpen], ['stats', 'Statistics', Activity], ['broadcasts', 'Broadcasts', Radio]];

// The panels stay mounted (hidden) so the window list keeps its thumbnails across toggles.
export function Sidebar({ viewer, tab, onTab, hidden }) {
  const permissions = useStore(viewer.store, s => s.permissions);
  const acts = permissions.includes('files.browse');
  const broadcasts = permissions.includes('broadcasts.manage');
  if ((!acts && tab === 'files') || (!broadcasts && tab === 'broadcasts')) tab = 'windows';
  return (
    <aside hidden={hidden} className="absolute inset-y-0 right-0 z-10 flex w-full max-w-sm shrink-0 flex-col border-l border-line bg-surface shadow-[-12px_0_32px_-16px_rgb(0_0_0/0.6)] md:static md:w-[22rem] md:max-w-none md:shadow-none">
      <nav aria-label="Panels" className="flex shrink-0 gap-0.5 border-b border-line p-2">
        {TABS.filter(([t]) => (t !== 'files' || acts) && (t !== 'broadcasts' || broadcasts)).map(([t, label, Icon]) => (
          <button
            key={t}
            type="button"
            aria-label={label}
            title={label}
            aria-current={tab === t ? 'page' : undefined}
            onClick={e => { onTab(t); e.currentTarget.blur(); }}
            className={cx(
              'flex min-w-0 flex-auto items-center justify-center gap-1 rounded-md px-1 py-1.5 text-[11px] font-medium transition-colors focus-visible:outline-2 focus-visible:outline-accent',
              tab === t ? 'bg-surface-3 text-ink shadow-card ring-1 ring-line-2' : 'text-ink-3 hover:bg-surface-2 hover:text-ink-2',
            )}
          >
            <Icon className="size-3.5 shrink-0" strokeWidth={1.75} />
            <span className="truncate">{label}</span>
          </button>
        ))}
      </nav>
      <div data-window-list hidden={tab !== 'windows'} className="min-h-0 flex-1 overflow-y-auto"><WindowList viewer={viewer} active={!hidden && tab === 'windows'} /></div>
      <div hidden={tab !== 'files'} className="min-h-0 flex-1 overflow-y-auto"><FilesPanel viewer={viewer} open={!hidden && tab === 'files' && acts} /></div>
      <div hidden={tab !== 'broadcasts'} className="min-h-0 flex-1 overflow-y-auto"><BroadcastsPanel viewer={viewer} open={!hidden && tab === 'broadcasts'} /></div>
      <div hidden={tab !== 'stats'} className="min-h-0 flex-1 overflow-y-auto"><StatsPanel viewer={viewer} /></div>
    </aside>
  );
}

function WindowList({ viewer, active }) {
  const [visible, setVisible] = useState(!document.hidden);
  const [dpr, setDpr] = useState(devicePixelRatio);
  useEffect(() => {
    const change = () => setVisible(!document.hidden);
    document.addEventListener('visibilitychange', change);
    return () => document.removeEventListener('visibilitychange', change);
  }, []);
  useEffect(() => {
    const media = matchMedia(`(resolution: ${dpr}dppx)`);
    const change = () => setDpr(devicePixelRatio);
    media.addEventListener('change', change);
    return () => media.removeEventListener('change', change);
  }, [dpr]);
  const windows = useStore(viewer.store, s => s.windows);
  const permissions = useStore(viewer.store, s => s.permissions);
  const acts = permissions.includes('desktop.control');
  const spawn = permissions.includes('commands.execute');
  const order = windows.slice().sort((a, b) => a.minimized - b.minimized || b.z - a.z); // top-most first, minimized last
  const minimized = windows.filter(w => w.minimized).length;
  return (
    <div className="flex flex-col">
      {spawn && <Spawn viewer={viewer} />}
      {order.length === 0 ? (
        <div className="flex flex-col items-center gap-2 px-6 py-12 text-center">
          <span className="flex size-10 items-center justify-center rounded-xl border border-line bg-surface-2 text-ink-4"><AppWindow className="size-5" strokeWidth={1.5} /></span>
          <span className="text-sm text-ink-2">No Windows</span>
        </div>
      ) : (
        <div className="flex items-center justify-between px-3 pt-3 pb-1.5">
          <Eyebrow>{order.length} {order.length === 1 ? 'window' : 'windows'}</Eyebrow>
          {minimized > 0 && <span className="text-[10px] text-ink-4">{minimized} minimized</span>}
        </div>
      )}
      {order.map(w => <WindowRow key={w.id} viewer={viewer} w={w} acts={acts} eligible={active && visible} dpr={dpr} />)}
    </div>
  );
}

// Starts a program on the desktop. While it has the keyboard, keys stay in the page (viewer.js skips text fields).
function Spawn({ viewer }) {
  const [cmd, setCmd] = useState('');
  const run = () => { if (cmd.trim()) { viewer.spawn(cmd.trim()); setCmd(''); } };
  return (
    <div className="flex gap-1.5 border-b border-line p-2">
      <label className="relative min-w-0 flex-1">
        <ChevronRight className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-ink-4" />
        <input
          value={cmd}
          onChange={e => setCmd(e.target.value)}
          onFocus={viewer.releaseInput}
          onKeyDown={e => { if (e.key === 'Enter') run(); if (e.key === 'Escape') e.currentTarget.blur(); }}
          placeholder="Run a Command…"
          spellCheck={false}
          autoComplete="off"
          className="input font-mono text-xs pl-7"
        />
      </label>
      <button type="button" onClick={e => { run(); e.currentTarget.blur(); }} title="Run" aria-label="Run" className="btn btn-primary size-8 px-0">
        <Play className="size-3.5" />
      </button>
    </div>
  );
}

function WinIcon({ w }) {
  const key = `${w.id}|${w.icon ?? ''}|${w.app_id}`; // pixel icons differ per window
  const [src, setSrc] = useState(null);
  useEffect(() => {
    let live = true;
    windowIcon(w.id, key).then(u => { if (live) setSrc(u); });
    return () => { live = false; };
  }, [w.id, key]);
  return src ? <img src={src} alt="" className="size-4 shrink-0 object-contain" /> : null;
}

function WindowRow({ viewer, w, acts, eligible, dpr }) {
  const badges = [w.fullscreen && 'fullscreen', w.maximized && 'maximized', w.minimized && 'minimized'].filter(Boolean);
  const act = (op, e) => { e.stopPropagation(); viewer.control({ id: w.id, op }); };
  return (
    <div
      onClick={() => acts && viewer.activate(w.id)}
      className={cx(
        'group relative flex items-center gap-3 px-3 py-2 transition-colors hover:bg-surface-2',
        acts && 'cursor-pointer',
        w.focused && 'bg-accent/8 before:absolute before:inset-y-2 before:left-0 before:w-0.5 before:rounded-r before:bg-accent',
        w.minimized && 'opacity-55',
      )}
    >
      <Thumb viewer={viewer} id={w.id} revision={w.content_revision} width={w.w} height={w.h} eligible={eligible} dpr={dpr} />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className="size-2 shrink-0 rounded-full" style={{ background: windowColor(w) }} />
          <WinIcon w={w} />
          <span className={cx('truncate text-[13px]', w.focused ? 'font-medium text-ink' : 'text-ink-2')} title={w.title}>{w.title || w.app_id || `#${w.id}`}</span>
        </div>
        <div className="mt-0.5 flex items-center gap-1.5 text-[11px] text-ink-3">
          <span className="truncate" title={w.app_id}>{w.app_id || (w.x11 ? 'X11' : 'Wayland')}</span>
          <span className="shrink-0 font-mono text-ink-4" title={w.decoration ? 'plus the title bar' : ''}>{w.w}×{w.h}</span>
          {badges.map(b => <span key={b} className="shrink-0 rounded bg-surface-4 px-1 text-[10px] text-ink-3">{b}</span>)}
        </div>
      </div>
      {/* the actions float over the row's end on hover, so titles keep the width */}
      <div className="absolute top-1/2 right-2 flex -translate-y-1/2 items-center gap-px rounded-md border border-line-2 bg-surface-3 p-0.5 opacity-0 shadow-pop transition-opacity group-hover:opacity-100 focus-within:opacity-100">
        <IconButton className="hover:bg-surface-4!" size="xs" icon={ExternalLink} label="Open in New Window" onClick={e => {
          e.stopPropagation();
          // The window's size plus its top and status bars, so it shows 1:1.
          window.open(url(`/?window=${w.id}`), storageKey(`window-${w.id}`), `popup,width=${w.w},height=${w.h + 48 + STATUS_BAR_HEIGHT}`);
        }} />
        {viewer.pip.supported && <IconButton className="hover:bg-surface-4!" size="xs" blurOnClick={false} icon={PictureInPicture2} label="Picture-in-Picture" onClick={e => { e.stopPropagation(); viewer.pip.open(w.id); }} />}
        <IconButton className="hover:bg-surface-4!" size="xs" icon={Camera} label="Snapshot (PNG)" onClick={e => {
          e.stopPropagation();
          const tab = window.open('', '_blank'); // opened now, inside the click, so popup blockers allow it
          snapshot(w.id).then(b => { tab.location = URL.createObjectURL(b); }).catch(() => tab.close());
        }} />
        {acts && <IconButton className="hover:bg-surface-4!" size="xs" icon={w.maximized ? Minimize2 : Maximize2} label={w.maximized ? 'Restore' : 'Maximize'} onClick={e => act(w.maximized ? 'unmaximize' : 'maximize', e)} />}
        {acts && <IconButton className="hover:bg-surface-4!" size="xs" icon={w.minimized ? ChevronUp : ChevronDown} label={w.minimized ? 'Restore' : 'Minimize'} onClick={e => act(w.minimized ? 'activate' : 'minimize', e)} />}
        {acts && <IconButton size="xs" icon={X} label="Close" onClick={e => act('close', e)} tone="danger" />}
      </div>
    </div>
  );
}

// Retain the last successful image across visibility changes; only the row's scheduler owns its URL.
function Thumb({ viewer, id, revision, width, height, eligible, dpr }) {
  const scale = useStore(viewer.store, s => s.stream?.scale ?? 1);
  const [src, setSrc] = useState('');
  const [intersecting, setIntersecting] = useState(false);
  const box = useRef(null), scheduler = useRef(null);
  const axis = width / height > 64 / 40 ? 'width' : 'height';
  const pixels = Math.ceil((axis === 'width' ? 64 : 40) * dpr);
  const native = Math.max(1, Math.floor((axis === 'width' ? width : height) * scale));
  const dimension = Math.min(pixels, native);
  useEffect(() => {
    const observer = new IntersectionObserver(entries => {
      const entry = entries.at(-1);
      setIntersecting(entry.isIntersecting && entry.intersectionRect.width > 0 && entry.intersectionRect.height > 0);
    });
    observer.observe(box.current);
    let url;
    scheduler.current = thumbnailScheduler({
      queue: queueSnapshot,
      allowed() {
        const element = box.current, container = element?.closest('[data-window-list]');
        if (!container || document.hidden || !viewer.store.get().windows.some(w => w.id === id)) return false;
        const row = element.getBoundingClientRect(), list = container.getBoundingClientRect();
        return row.width > 0 && row.height > 0 && Math.max(row.top, list.top, 0) < Math.min(row.bottom, list.bottom, innerHeight)
          && Math.max(row.left, list.left, 0) < Math.min(row.right, list.right, innerWidth);
      },
      capture: (sizing, signal) => snapshot(id, sizing, AbortSignal.any([signal, AbortSignal.timeout(15000)])),
      publish(blob) {
        if (url) URL.revokeObjectURL(url);
        url = URL.createObjectURL(blob);
        setSrc(url);
      },
    });
    return () => {
      observer.disconnect();
      scheduler.current.dispose();
      if (url) URL.revokeObjectURL(url);
    };
  }, [viewer, id]);
  useEffect(() => {
    scheduler.current.update({ eligible: eligible && intersecting && !document.hidden, revision, sizing: { [axis]: dimension } });
  }, [viewer, id, eligible, intersecting, revision, axis, dimension]);
  return (
    <div ref={box} className="h-10 w-16 shrink-0 overflow-hidden rounded-md bg-black ring-1 ring-line-2">
      {src && <img src={src} alt="" className="h-full w-full object-contain" />}
    </div>
  );
}

const ms = v => (v == null ? '–' : v.toFixed(1));

function StatsPanel({ viewer }) {
  const s = useStore(viewer.store, st => st.stats);
  const stream = useStore(viewer.store, st => st.stream);
  const renderer = useStore(viewer.store, st => st.renderer);
  const locked = useStore(viewer.store, st => st.locked);
  const videoVia = useStore(viewer.store, st => st.videoVia);
  const transport = useStore(viewer.store, st => st.transport);
  const status = useStore(viewer.store, st => st.status);
  const recovery = useStore(viewer.store, st => st.rtcRecovery);
  const t = s.timings;
  const bad = s.lost + s.dropped + s.decodeErrors;
  return (
    <div className="flex flex-col gap-3 p-3 text-xs">
      <div className="grid grid-cols-3 gap-2">
        <Tile label="Frame Rate" value={s.fps} unit="fps" />
        <Tile label="Throughput" value={s.mbps.toFixed(1)} unit="Mbit" />
        <Tile label="Latency" value={s.latencyMs.toFixed(0)} unit="ms" />
      </div>
      <Section title="Stream">
        <Row label="Codec" value={stream ? `${codecName(stream.codec)} · ${stream.codec}` : '–'} />
        <Row label="Size" value={stream ? `${stream.width}×${stream.height} @${stream.scale.toFixed(2)}` : '–'} />
        <Row label="Renderer" value={renderer} />
        <Row label="Frame Rate" value={`${s.fps} fps`} />
        <Row label="Bandwidth" value={`${s.mbps.toFixed(1)} Mbit`} />
        <Row label="Input → Paint" value={`${s.latencyMs.toFixed(0)} ms`} />
      </Section>
      <Section title="Timings, Last Second" hint="p50 / p95">
        <Row label="Received → Decoded" value={t ? `${ms(t.decode[0])} / ${ms(t.decode[1])} ms` : '–'} />
        <Row label="Decoded → Painted" value={t ? `${ms(t.paint[0])} / ${ms(t.paint[1])} ms` : '–'} />
        <Row label="Paint Interval" value={t ? `${ms(t.interval[0])} / ${ms(t.interval[1])} ms` : '–'} />
        <Row label="Decode Queue" value={s.queue} />
      </Section>
      <Section title="Frames" badge={bad > 0 ? <Badge tone="warn">{bad} issues</Badge> : <Badge tone="ok">clean</Badge>}>
        <Row label="Painted / Received" value={`${s.frames} / ${s.received}`} />
        <Row label="Keyframes" value={`${s.keyframes} (${s.sinceKey} since last)`} />
        <Row label="Lost / Dropped / Errors" value={`${s.lost} / ${s.dropped} / ${s.decodeErrors}`} warn={bad > 0} />
      </Section>
      <Section title="Audio" badge={s.audio ? <Badge tone={s.audio.state === 'running' ? 'ok' : 'neutral'}>{s.audio.state}</Badge> : <Badge>off</Badge>}>
        {s.audio ? (
          <>
            <Row label="State" value={s.audio.state} />
            <Row label="Packets / Decoded" value={`${s.audio.packets} / ${s.audio.decoded}`} />
            <Row label="Lead" value={`${s.audio.lead.toFixed(0)} ms`} />
            <Row label="Underruns" value={s.underruns} warn={s.underruns > 0} />
            <div className="mt-1.5 flex items-center gap-2">
              <span className="text-ink-3">Level</span>
              <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-surface-4"><div className="h-full rounded-full bg-ok transition-[width]" style={{ width: `${(s.audio.level / 255) * 100}%` }} /></div>
            </div>
          </>
        ) : <Row label="State" value="off" />}
      </Section>
      <Section title="Connection">
        <Row label="Selected Transport" value={transport === 'webrtc' ? 'WebRTC' : 'WebSocket'} />
        <Row label="WebSocket" value={status === 'connected' ? 'connected' : status} />
        <Row label="WebRTC Recovery" value={transport === 'webrtc' ? recovery.state : 'off'} />
        {transport === 'webrtc' && <>
          {recovery.reason && <Row label="Reason" value={recovery.reason} />}
          <Row label="Retries" value={recovery.retries} />
          {recovery.state === 'waiting' && <>
            <Row label="Next Attempt" value={`in ${Math.max(0, Math.ceil((recovery.nextAt - Date.now()) / 1000))} s`} />
            <button type="button" onClick={() => viewer.retryRtc()} className="btn btn-outline btn-xs mt-1 self-start">Retry Now</button>
          </>}
        </>}
        <Row label="Video Via" value={videoVia === 'webrtc' ? 'WebRTC data channel' : 'WebSocket'} />
        {s.rtc && (
          <>
            <Row label="Round Trip" value={s.rtc.rttMs === null ? '–' : `${s.rtc.rttMs.toFixed(0)} ms`} />
            <Row label="Channel Received" value={`${s.rtc.messages} messages, ${(s.rtc.bytes / 1e6).toFixed(1)} MB`} />
            <Row label="Incomplete Frames" value={s.rtc.incomplete} warn={s.rtc.incomplete > 0} />
          </>
        )}
        <Row label="Connects / Closes" value={`${s.connects} / ${s.closes.length}`} />
        {s.closes.length > 0 && <Row label="Last Close" value={s.closes[s.closes.length - 1]} />}
        <Row label="Pointer Lock" value={`${locked ? 'locked' : 'free'} (${s.lockRequests} requests${s.lockError ? ', ' + s.lockError : ''})`} />
      </Section>
    </div>
  );
}

function Tile({ label, value, unit }) {
  return (
    <div className="card flex flex-col gap-0.5 px-2.5 py-2">
      <span className="text-[10px] font-medium tracking-wide text-ink-3 uppercase">{label}</span>
      <span className="flex items-baseline gap-1 font-mono">
        <span className="text-lg leading-tight font-semibold text-ink tabular-nums">{value}</span>
        <span className="text-[10px] text-ink-4">{unit}</span>
      </span>
    </div>
  );
}

function Section({ title, hint, badge, children }) {
  return (
    <section className="card">
      <div className="flex items-center gap-2 border-b border-line px-3 py-2">
        <Eyebrow>{title}</Eyebrow>
        {hint && <span className="text-[10px] text-ink-4">{hint}</span>}
        {badge && <span className="ml-auto">{badge}</span>}
      </div>
      <div className="flex flex-col px-3 py-1.5">{children}</div>
    </section>
  );
}

function Row({ label, value, warn = false }) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-1">
      <span className="text-ink-3">{label}</span>
      <span className={cx('truncate font-mono tabular-nums', warn ? 'text-warn' : 'text-ink')}>{value}</span>
    </div>
  );
}
