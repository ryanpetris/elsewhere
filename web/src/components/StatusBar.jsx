// The status bar: live viewer statistics, the transport path, media controls, and this viewer's codec,
// quality, effort and transport choices. Its height is fixed, so nothing here ever resizes the stage.
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Activity, AudioLines, Camera, CameraOff, ChevronDown, Mic, MicOff, PanelTopOpen, Settings2, SlidersHorizontal, Terminal, Volume2, VolumeX, X } from 'lucide-react';
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

export const STATUS_BAR_HEIGHT = 30;

function ChoiceField({ name, label, value, options, onChange, stacked = false }) {
  return (
    <fieldset className="flex flex-col gap-2 text-sm text-ink">
      <legend className={stacked ? 'eyebrow mb-1' : 'sr-only'}>{label}</legend>
      {options.map(option => <label key={option.value} className="flex min-h-9 items-center gap-2">
        <input type="radio" name={name} value={option.value} checked={value === option.value} onChange={() => onChange(option.value)}
          onClick={() => { if (value === option.value) onChange(option.value); }}
          onKeyDown={event => { if (event.key === ' ') { event.preventDefault(); onChange(option.value); } }} />
        {option.label}
      </label>)}
    </fieldset>
  );
}

function ChoiceChip({ viewer, name, label, value, options, onChange }) {
  const [open, setOpen] = useState(false);
  const button = useRef(null), panel = useRef(null);
  const face = options.find(option => option.value === value)?.label ?? value;
  const close = () => { setOpen(false); button.current?.focus(); };
  useEffect(() => {
    if (!open) return;
    viewer.releaseInput();
    if (document.pointerLockElement) document.exitPointerLock();
    panel.current?.querySelector('input:checked')?.focus();
  }, [open, viewer]);
  return <>
    <button ref={button} type="button" aria-label={`${label}: ${face}`} title={label} aria-expanded={open} aria-haspopup="dialog" aria-controls={`${name}-settings`}
      onClick={() => setOpen(!open)} className={control}>
      <span className="whitespace-nowrap">{face}</span>
      <ChevronDown className="size-3 shrink-0" />
    </button>
    {open && createPortal(
      <Popover floating ref={panel} id={`${name}-settings`} role="dialog" aria-label={label} onClose={close}
        style={{ right: 8, bottom: STATUS_BAR_HEIGHT + 8, width: 'min(20rem, calc(100vw - 1rem))', maxHeight: `calc(100dvh - ${STATUS_BAR_HEIGHT + 16}px)` }} className="font-sans">
        <div className="flex items-center justify-between border-b border-line px-3 py-2">
          <h2 className="text-sm font-medium text-ink">{label}</h2>
          <IconButton icon={X} label={`Close ${label}`} size="sm" onClick={close} />
        </div>
        <div className="min-h-0 overflow-y-auto p-3">
          <ChoiceField {...{ name, label, value, options }} onChange={next => { onChange(next); close(); }} />
        </div>
      </Popover>, document.querySelector('[data-viewer]') ?? document.body)}
  </>;
}

// Only one set of stream choices exists: chips on a wide bar, fieldsets in the narrow dialog.
function StreamControls({ viewer, stacked = false, onClose }) {
  const st = useStore(viewer.store, s => s.streamState);
  const choice = useStore(viewer.store, s => s.choice);
  const codecs = useStore(viewer.store, s => s.codecs);
  const decodable = useStore(viewer.store, s => s.decodable);
  const ceilings = { 'very-low': 2000, low: 5000, medium: st?.medium_kbps, high: 12000, max: 25000 };
  if (st?.preset) ceilings[st.preset] = st.ceiling_kbps;
  const both = codecs.filter(c => decodable.includes(c.codec));
  const fields = [
    { name: 'codec', label: 'Video Codec', options: [
      { value: 'auto', label: `Auto${choice.codec === 'auto' && st?.codec ? ` (${codecName(st.codec)})` : ''}` },
      ...both.map(c => ({ value: c.codec, label: `${codecName(c.codec)}${choice.codec === c.codec && st?.codec && st.codec !== c.codec ? ` (Using ${codecName(st.codec)})` : ''}${c.hardware ? '' : ' (Software)'}` })),
    ] },
    { name: 'quality', label: 'Quality', options: PRESETS.map(p => ({ value: p, label: `${PRESET_LABEL[p]} (${ceilings[p] === undefined ? 'Server Limit' : mbit(ceilings[p])})` })) },
    { name: 'effort', label: 'Encoding Effort', options: EFFORTS.map(e => ({ value: e, label: EFFORT_LABEL[e] })) },
  ];
  const controls = fields.map(field => {
    const props = { ...field, value: choice[field.name], onChange: value => { if (value !== choice[field.name]) viewer.setChoice({ [field.name]: value }); onClose?.(); } };
    return stacked ? <ChoiceField key={field.name} {...props} stacked /> : <ChoiceChip key={field.name} viewer={viewer} {...props} />;
  });
  return stacked ? <div className="flex min-h-0 flex-col gap-3 overflow-y-auto p-3">{controls}</div> : <>{controls}</>;
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
    panel.current?.querySelector('input:checked')?.focus();
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
          onKeyDown={event => event.stopPropagation()} style={{ right: 8, bottom: STATUS_BAR_HEIGHT + 8, width: 'min(20rem, calc(100vw - 1rem))', maxHeight: `calc(100dvh - ${STATUS_BAR_HEIGHT + 16}px)` }} className="font-sans">
          <div className="flex items-center justify-between border-b border-line px-3 py-2">
            <h2 className="text-sm font-medium text-ink">Stream Settings</h2>
            <IconButton icon={X} label="Close Stream Settings" size="sm" onClick={close} />
          </div>
          <StreamControls viewer={viewer} stacked onClose={close} />
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

export function StatusBar({ viewer, canType, audioPanel, onAudioPanel, mixerPanel, onMixer, terminal, onTerminal, controlsHidden, onShowControls }) {
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
  const rtcAvailable = useStore(viewer.store, st => st.rtcAvailable);
  const videoVia = useStore(viewer.store, st => st.videoVia);
  const status = useStore(viewer.store, st => st.status);
  const streamState = useStore(viewer.store, st => st.streamState);
  const recovery = useStore(viewer.store, st => st.rtcRecovery);
  const wide = useMedia('(min-width: 57rem)'); // the stream controls fit beside the readouts
  const [transportOpen, setTransportOpen] = useState(false);
  const transportButton = useRef(null), transportPanel = useRef(null);
  const withTransport = rtcAvailable || transport === 'webrtc';
  const closeTransport = () => { setTransportOpen(false); transportButton.current?.focus(); };
  // Recheck after each render: adjacent controls can move the button without resizing it.
  useLayoutEffect(() => {
    if (!transportOpen || !withTransport) return;
    const button = transportButton.current, panel = transportPanel.current, bar = button.closest('footer');
    const place = () => {
      const left = Math.max(8, Math.min(button.getBoundingClientRect().left, innerWidth - panel.offsetWidth - 8));
      const bottom = innerHeight - bar.getBoundingClientRect().top + 8;
      Object.assign(panel.style, { left: `${left}px`, bottom: `${bottom}px`, maxHeight: `${Math.max(0, innerHeight - bottom - 8)}px` });
    };
    place();
    const observer = new ResizeObserver(place);
    for (const element of [bar, ...bar.children, panel]) observer.observe(element);
    window.addEventListener('resize', place);
    return () => { observer.disconnect(); window.removeEventListener('resize', place); };
  });
  useEffect(() => {
    if (!withTransport) { setTransportOpen(false); return; }
    if (!transportOpen) return;
    viewer.releaseInput();
    if (document.pointerLockElement) document.exitPointerLock();
    (transportPanel.current?.querySelector('input:checked:not(:disabled)') ?? transportPanel.current?.querySelector('input:not(:disabled)'))?.focus();
  }, [transportOpen, withTransport, viewer]);
  const recoveryHint = recovery.state === 'unavailable' ? 'WebRTC unavailable'
    : recovery.state === 'connecting' ? 'Connecting WebRTC'
    : recovery.state === 'waiting' ? 'Waiting to retry WebRTC'
    : recovery.state === 'retrying' ? 'Retrying WebRTC' : 'WebRTC inactive';
  const transportHint = status !== 'connected' ? 'Disconnected'
    : videoVia === 'webrtc' ? 'WebRTC'
    : transport !== 'webrtc' ? 'WebSocket'
    : `WebSocket · ${recoveryHint}`;
  const transportDot = <span data-transport-dot className={cx('size-1.5 shrink-0 rounded-full', status !== 'connected' ? 'bg-ink-4' : videoVia === 'webrtc' ? 'bg-info' : transport === 'webrtc' ? 'bg-warn' : 'bg-ok')} />;
  const bad = s.lost + s.dropped + s.decodeErrors;
  const listens = permissions.includes('audio.listen');
  // The four readouts follow the optional Show Controls button. The bar never wraps: each width hides what
  // does not fit, and the controls scroll horizontally when space is limited.
  return (
    <footer style={{ height: STATUS_BAR_HEIGHT }} className="flex shrink-0 items-center gap-x-2 border-y border-line border-b-transparent bg-surface px-2 font-mono text-[11px] text-ink-3 sm:gap-x-3 sm:px-3">
      {controlsHidden && (
        <button type="button" aria-label="Show Controls" title="Show Controls (Ctrl+Alt+Shift+H)" onFocus={viewer.releaseInput} onClick={onShowControls}
          className={cx(control, 'w-6 px-0 bg-warn/15 text-warn hover:text-warn')}>
          <PanelTopOpen className="size-3.5" />
        </button>
      )}
      <Metric icon={Activity} value={`${s.fps} fps`} width="w-[9ch]" title={`${s.fps} frames per second painted`} className={status === 'connected' && transport === 'webrtc' && videoVia !== 'webrtc' ? 'max-sm:hidden' : ''} />
      <Metric value={`${s.mbps.toFixed(1)} Mbit`} width="w-[11ch]" title={`Measured video throughput: ${s.mbps.toFixed(1)} Mbit`} className="max-[26rem]:hidden" />
      <Metric value={`${s.latencyMs.toFixed(0)} ms`} width="w-[8ch]" title={`Input to the next painted frame: ${s.latencyMs.toFixed(0)} ms`} className="max-lg:hidden" />
      <Metric value={`${s.lost} · ${s.dropped} · ${s.decodeErrors}`} width="w-[19ch]" title={`lost ${s.lost} · dropped ${s.dropped} · decode errors ${s.decodeErrors}`} warn={bad > 0} className="max-xl:hidden" />
      <span className={cx('flex flex-1 items-center gap-1', recovery.state === 'waiting' ? 'min-w-[11.5rem]' : 'min-w-[6.5rem]')}>
        {withTransport ? (
          <button ref={transportButton} type="button" aria-label={`Transport: ${transportHint}`} title={transportHint}
            aria-haspopup="dialog" aria-expanded={transportOpen} aria-controls="transport-settings" onClick={() => setTransportOpen(!transportOpen)}
            className={cx(control, 'min-w-0 shrink!')}>
            {transportDot}
            <span className="min-w-0 truncate" data-transport-status>{transportHint}</span>
            <ChevronDown className="size-3 shrink-0" />
          </button>
        ) : <span className="flex min-w-0 items-center gap-1.5" title={transportHint}>{transportDot}<span className="min-w-0 truncate" data-transport-status>{transportHint}</span></span>}
        {recovery.state === 'waiting' && <button type="button" onClick={() => viewer.retryRtc()} className="btn btn-link btn-xs shrink-0 font-sans">Retry Now</button>}
      </span>
      {transportOpen && withTransport && createPortal(
        <Popover floating ref={transportPanel} id="transport-settings" role="dialog" aria-label="Transport" onClose={closeTransport}
          style={{ width: 'min(20rem, calc(100vw - 1rem))' }} className="overflow-y-auto font-sans">
          <div className="flex items-center justify-between border-b border-line px-3 py-2">
            <h2 className="text-sm font-medium text-ink">Preferred Transport</h2>
            <IconButton icon={X} label="Close Transport" size="sm" onClick={closeTransport} />
          </div>
          <fieldset className="flex flex-col gap-2 p-3 text-sm text-ink">
            <legend className="sr-only">Preferred Transport</legend>
            {TRANSPORTS.map(t => <label key={t} className="flex min-h-9 items-center gap-2">
              <input type="radio" name="transport" value={t} checked={transport === t} disabled={t === 'webrtc' && !rtcAvailable}
                onChange={() => { viewer.setTransport(t); closeTransport(); }} />
              {TRANSPORT_LABEL[t]}
            </label>)}
          </fieldset>
          <div className="border-t border-line px-3 py-2 text-xs text-ink-3">
            <p>{status === 'connected' ? `Current video transport: ${videoVia === 'webrtc' ? 'WebRTC' : 'WebSocket'}` : 'Disconnected'}</p>
            {status === 'connected' && transport === 'webrtc' && videoVia !== 'webrtc' &&
              <p className="mt-1">{recoveryHint}{recovery.reason ? `. ${recovery.reason}` : ''}</p>}
          </div>
        </Popover>, document.querySelector('[data-viewer]') ?? document.body)}
      <span className="ml-auto flex min-w-8 items-center gap-1 overflow-x-auto [scrollbar-width:none] sm:gap-1.5">
        <ClipboardControl viewer={viewer} canType={canType} />
        {onTerminal && status === 'connected' && permissions.includes('commands.execute') && (
          <button id="terminal-toggle" type="button" aria-label="Terminal" title="Terminal" aria-expanded={terminal && !controlsHidden} onClick={onTerminal} className={control}>
            <Terminal className="size-3.5" />
          </button>
        )}
        {listens && onMixer && (
          <button id="session-mixer-toggle" type="button" aria-label={panelWindows.mixer ? 'Focus Audio Mixer Window' : 'Audio Mixer'} title={panelWindows.mixer ? 'Focus Audio Mixer Window' : 'Audio Mixer'} aria-expanded={panelWindows.mixer ? undefined : mixerPanel && !controlsHidden} onClick={onMixer} className={cx(control, panelWindows.mixer && 'bg-accent/15! text-accent-2!')}>
            <SlidersHorizontal className="size-3.5" />
          </button>
        )}
        {listens && onAudioPanel && (
          <button type="button" aria-label={panelWindows.audio ? 'Focus Audio Visualizer Window' : 'Audio Visualizer'} title={panelWindows.audio ? 'Focus Audio Visualizer Window' : 'Audio Visualizer'} aria-expanded={panelWindows.audio ? undefined : audioPanel && !controlsHidden} onClick={onAudioPanel} className={cx(control, panelWindows.audio && 'bg-accent/15! text-accent-2!')}>
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
