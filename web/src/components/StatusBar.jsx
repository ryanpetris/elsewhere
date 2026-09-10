// The status bar: live viewer statistics, the transport path, media controls, and this viewer's codec,
// quality, effort and transport choices. Its height is fixed, so nothing here ever resizes the stage.
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Activity, AudioLines, Camera, CameraOff, Mic, MicOff, PanelTopOpen, Settings2, SlidersHorizontal, Terminal, Volume2, VolumeX, X } from 'lucide-react';
import { useStore } from '../store.js';
import { EFFORTS, PRESETS, TRANSPORTS } from '../protocol.js';
import { IconButton, codecName, cx } from './ui.jsx';
import { ClipboardControl } from './Clipboard.jsx';
import { Popover } from './Launcher.jsx';

const PRESET_LABEL = { 'very-low': 'Very Low', low: 'Low', medium: 'Medium', high: 'High', max: 'Max' };
const EFFORT_LABEL = { fast: 'Fast', balanced: 'Balanced', high: 'High' };
const TRANSPORT_LABEL = { webrtc: 'WebRTC', websocket: 'WebSocket' };
const mbit = (kbps, digits = 3) => `${Number((kbps / 1000).toFixed(digits))} Mbit`;

// Whether a media query matches, kept current.
function useMedia(query) {
  const [matches, setMatches] = useState(() => matchMedia(query).matches);
  useEffect(() => {
    const media = matchMedia(query);
    const change = () => setMatches(media.matches);
    media.addEventListener('change', change);
    setMatches(media.matches);
    return () => media.removeEventListener('change', change);
  }, [query]);
  return matches;
}

/// This viewer's stream choices. Inline in a wide status bar, stacked inside the popover of a narrow
/// one; only one set of controls exists at a time.
function StreamControls({ viewer, stacked = false }) {
  const st = useStore(viewer.store, s => s.streamState);
  const choice = useStore(viewer.store, s => s.choice);
  const codecs = useStore(viewer.store, s => s.codecs);
  const decodable = useStore(viewer.store, s => s.decodable);
  const transport = useStore(viewer.store, s => s.transport);
  const rtcAvailable = useStore(viewer.store, s => s.rtcAvailable);
  const ceilings = { 'very-low': 2000, low: 5000, medium: st?.medium_kbps, high: 12000, max: 25000 };
  if (st?.preset) ceilings[st.preset] = st.ceiling_kbps;
  const both = codecs.filter(c => decodable.includes(c.codec));
  const withTransport = rtcAvailable || transport === 'webrtc';
  const select = cx('select', stacked ? 'select-md w-full' : 'shrink-0');
  const codec = (
    <select value={choice.codec} onChange={e => viewer.setChoice({ codec: e.target.value })} className={select} title="Video Codec">
      <option value="auto">Auto{choice.codec === 'auto' && st?.codec ? ` (${codecName(st.codec)})` : ''}</option>
      {both.map(c => <option key={c.codec} value={c.codec}>{codecName(c.codec)}{choice.codec === c.codec && st?.codec && st.codec !== c.codec ? ` (Using ${codecName(st.codec)})` : ''}{c.hardware ? '' : ' (Software)'}</option>)}
    </select>
  );
  const quality = (
    <select value={choice.quality} onChange={e => viewer.setChoice({ quality: e.target.value })} className={select} title="Quality">
      {PRESETS.map(p => <option key={p} value={p}>{PRESET_LABEL[p]} ({ceilings[p] === undefined ? 'Server Limit' : mbit(ceilings[p])})</option>)}
    </select>
  );
  const effortSelect = (
    <select value={choice.effort} onChange={event => viewer.setChoice({ effort: event.target.value })} className={select} aria-label="Encoding Effort" title="Encoding Effort">
      {EFFORTS.map(e => <option key={e} value={e}>{EFFORT_LABEL[e]}</option>)}
    </select>
  );
  const transportSelect = withTransport && (
    <select value={transport} onChange={e => viewer.setTransport(e.target.value)} className={select} title="Transport">
      {TRANSPORTS.map(t => <option key={t} value={t}>{TRANSPORT_LABEL[t]}</option>)}
    </select>
  );
  if (stacked) return (
    <div className="flex flex-col gap-3 p-3 text-xs">
      <Field label="Codec">{codec}</Field>
      <Field label="Quality">{quality}</Field>
      {effortSelect}
      {withTransport && <Field label="Transport">{transportSelect}</Field>}
    </div>
  );
  return (
    <>
      {codec}
      {quality}
      {effortSelect}
      {transportSelect}
    </>
  );
}

function Field({ label, children }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="eyebrow">{label}</span>
      {children}
    </label>
  );
}

/// The narrow status bar's stream controls: a chip that opens them in a popover.
function StreamChip({ viewer }) {
  const st = useStore(viewer.store, s => s.streamState);
  const choice = useStore(viewer.store, s => s.choice);
  const [open, setOpen] = useState(false);
  const button = useRef(null), panel = useRef(null);
  const close = () => { setOpen(false); button.current?.focus(); };
  useEffect(() => {
    if (!open) return;
    viewer.releaseInput();
    if (document.pointerLockElement) document.exitPointerLock();
    panel.current?.focus();
  }, [open, viewer]);
  const summary = st?.codec ? `${codecName(st.codec)} · ${PRESET_LABEL[choice.quality]}` : 'Stream';
  return (
    <>
      <button ref={button} type="button" aria-label="Stream Settings" title="Stream Settings" aria-expanded={open} aria-haspopup="dialog" aria-controls="stream-settings"
        onClick={() => setOpen(!open)} className={cx('inline-flex h-6 shrink-0 items-center gap-1.5 rounded-md px-1.5 font-sans text-[11px] font-medium transition-colors', open ? 'bg-accent/15 text-accent-2' : 'text-ink-2 hover:bg-surface-3 hover:text-ink')}>
        <Settings2 className="size-3.5" />
        <span className="hidden whitespace-nowrap sm:inline">{summary}</span>
      </button>
      {open && createPortal(
        <Popover floating ref={panel} id="stream-settings" role="dialog" aria-label="Stream Settings" onClose={close}
          onKeyDown={event => event.stopPropagation()} style={{ right: 8, bottom: 40, width: 'min(20rem, calc(100vw - 1rem))' }} className="font-sans">
          <div className="flex items-center justify-between border-b border-line px-3 py-2">
            <h2 className="text-sm font-medium text-ink">Stream Settings</h2>
            <IconButton icon={X} label="Close Stream Settings" size="sm" onClick={close} />
          </div>
          <StreamControls viewer={viewer} stacked />
        </Popover>, document.querySelector('[data-viewer]') ?? document.body)}
    </>
  );
}

/// A fixed-width live readout; the width keeps neighbours still while the number changes.
function Metric({ icon: Icon, value, width, title, warn = false, className = '' }) {
  return (
    <span data-metric className={cx('inline-flex shrink-0 items-center gap-1.5 overflow-hidden whitespace-nowrap tabular-nums', width, warn ? 'text-warn' : '', className)} title={title}>
      {Icon && <Icon className="size-3 shrink-0 text-ink-4" />}
      {value}
    </span>
  );
}

const control = 'inline-flex h-6 shrink-0 items-center gap-1.5 rounded-md px-1.5 font-sans text-[11px] font-medium text-ink-2 transition-colors hover:bg-surface-3 hover:text-ink focus-visible:outline-2 focus-visible:outline-accent aria-expanded:bg-accent/15 aria-expanded:text-accent-2';

export function StatusBar({ viewer, audioPanel, onAudioPanel, mixerPanel, onMixer, terminal, onTerminal, controlsHidden, onShowControls }) {
  const panelWindows = useStore(viewer.store, st => st.panelWindows);
  const s = useStore(viewer.store, st => st.stats);
  const renderer = useStore(viewer.store, st => st.renderer);
  const mic = useStore(viewer.store, st => st.mic);
  const micAvailable = useStore(viewer.store, st => st.micAvailable);
  const cam = useStore(viewer.store, st => st.cam);
  const camAvailable = useStore(viewer.store, st => st.camAvailable);
  const role = useStore(viewer.store, st => st.role);
  const permissions = useStore(viewer.store, st => st.permissions);
  const transport = useStore(viewer.store, st => st.transport);
  const videoVia = useStore(viewer.store, st => st.videoVia);
  const status = useStore(viewer.store, st => st.status);
  const streamState = useStore(viewer.store, st => st.streamState);
  const recovery = useStore(viewer.store, st => st.rtcRecovery);
  const wide = useMedia('(min-width: 57rem)'); // the stream controls fit beside the readouts
  const transportHint = status !== 'connected' ? 'WebSocket disconnected'
    : videoVia === 'webrtc' ? 'WebRTC'
    : transport !== 'webrtc' ? 'WebSocket'
    : recovery.state === 'unavailable' ? 'WebSocket · WebRTC unavailable'
    : recovery.state === 'connecting' ? 'WebSocket · connecting WebRTC'
    : 'WebSocket · retrying WebRTC';
  const bad = s.lost + s.dropped + s.decodeErrors;
  const listens = permissions.includes('audio.listen');
  // The four readouts follow the optional Show Controls button. The bar never wraps: each width hides what
  // does not fit, and the controls scroll horizontally when space is limited.
  return (
    <footer className="flex h-8 shrink-0 items-center gap-x-2 border-t border-line bg-surface px-2 font-mono text-[11px] text-ink-3 sm:gap-x-3 sm:px-3">
      {controlsHidden && (
        <button type="button" aria-label="Show Controls" title="Show Controls (Ctrl+Alt+Shift+H)" onFocus={viewer.releaseInput} onClick={onShowControls}
          className={cx(control, 'w-6 px-0 bg-warn/15 text-warn hover:text-warn')}>
          <PanelTopOpen className="size-3.5" />
        </button>
      )}
      <Metric icon={Activity} value={`${s.fps} fps`} width="w-[9ch]" title={`${s.fps} frames per second painted`} />
      <Metric value={`${s.mbps.toFixed(1)} Mbit`} width="w-[11ch]" title={`Measured video throughput: ${s.mbps.toFixed(1)} Mbit`} className="max-[26rem]:hidden" />
      <Metric value={`${s.latencyMs.toFixed(0)} ms`} width="w-[8ch]" title={`Input to the next painted frame: ${s.latencyMs.toFixed(0)} ms`} className="max-lg:hidden" />
      <Metric value={`${s.lost} · ${s.dropped} · ${s.decodeErrors}`} width="w-[19ch]" title={`lost ${s.lost} · dropped ${s.dropped} · decode errors ${s.decodeErrors}`} warn={bad > 0} className="max-xl:hidden" />
      <span className="hidden min-w-0 flex-1 items-center gap-2 sm:flex" title={recovery.reason || transportHint}>
        <span className={cx('size-1.5 shrink-0 rounded-full', status !== 'connected' ? 'bg-ink-4' : videoVia === 'webrtc' ? 'bg-info' : 'bg-ok')} />
        <span className="min-w-0 truncate" data-transport-status>{transportHint}</span>
        {recovery.state === 'waiting' && <button type="button" onClick={() => viewer.retryRtc()} className="btn btn-link btn-xs shrink-0 font-sans">Retry Now</button>}
      </span>
      <span className="ml-auto flex min-w-0 items-center gap-1 overflow-x-auto [scrollbar-width:none] sm:gap-1.5">
        <ClipboardControl viewer={viewer} />
        {onTerminal && status === 'connected' && permissions.includes('commands.execute') && (
          <button id="terminal-toggle" type="button" aria-label="Terminal" title="Terminal" aria-expanded={terminal && !controlsHidden} onClick={onTerminal} className={control}>
            <Terminal className="size-3.5" />
          </button>
        )}
        {listens && onMixer && (
          <button id="session-mixer-toggle" type="button" aria-label={panelWindows.mixer ? 'Focus Audio Mixer Window' : 'Audio Mixer'} title={panelWindows.mixer ? 'Focus Audio Mixer Window' : 'Audio Mixer'} aria-expanded={panelWindows.mixer ? undefined : mixerPanel && !controlsHidden} onClick={onMixer} className={cx(control, panelWindows.mixer && 'bg-accent/15 text-accent-2')}>
            <SlidersHorizontal className="size-3.5" />
          </button>
        )}
        {listens && onAudioPanel && (
          <button type="button" aria-label={panelWindows.audio ? 'Focus Audio Visualizer Window' : 'Audio Visualizer'} title={panelWindows.audio ? 'Focus Audio Visualizer Window' : 'Audio Visualizer'} aria-expanded={panelWindows.audio ? undefined : audioPanel && !controlsHidden} onClick={onAudioPanel} className={cx(control, panelWindows.audio && 'bg-accent/15 text-accent-2')}>
            <AudioLines className="size-3.5" />
          </button>
        )}
        <span className="inline-flex size-6 shrink-0 items-center justify-center max-lg:hidden" title={s.audio ? `audio ${s.audio.state}` : 'no audio yet'}>
          {s.audio?.state === 'running' ? <Volume2 className="size-3.5 text-ok" /> : <VolumeX className="size-3.5 text-ink-4" />}
        </span>
        {role === 'controller' && micAvailable && navigator.mediaDevices && 'AudioEncoder' in window && (
          <button type="button" aria-label="Microphone" aria-pressed={mic} onClick={e => { (mic ? viewer.mic.stop : viewer.mic.start)(); e.currentTarget.blur(); }} title={mic ? 'Mute Microphone' : 'Enable Microphone'} className={cx(control, 'w-6 px-0', mic && 'bg-ok/15 text-ok hover:text-ok')}>
            {mic ? <Mic className="size-3.5" /> : <MicOff className="size-3.5" />}
          </button>
        )}
        {role === 'controller' && camAvailable && navigator.mediaDevices && 'VideoEncoder' in window && 'MediaStreamTrackProcessor' in window && (
          <button type="button" aria-label="Webcam" aria-pressed={cam} onClick={e => { (cam ? viewer.cam.stop : viewer.cam.start)(); e.currentTarget.blur(); }} title={cam ? 'Disable Webcam' : 'Enable Webcam'} className={cx(control, 'w-6 px-0', cam && 'bg-ok/15 text-ok hover:text-ok')}>
            {cam ? <Camera className="size-3.5" /> : <CameraOff className="size-3.5" />}
          </button>
        )}
        {(status === 'connected' || status === 'connecting' && streamState) && (
          <>
            <span aria-hidden="true" className="mx-0.5 h-4 w-px shrink-0 bg-line-2" />
            {wide ? <StreamControls viewer={viewer} /> : <StreamChip viewer={viewer} />}
          </>
        )}
        <span className="hidden shrink-0 text-ink-4 2xl:inline" title="Renderer">{renderer}</span>
      </span>
    </footer>
  );
}
