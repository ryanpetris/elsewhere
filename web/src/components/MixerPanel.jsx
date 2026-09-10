import { useEffect, useRef, useState } from 'react';
import { ExternalLink, MousePointer2, SlidersHorizontal, Volume2, VolumeX, X } from 'lucide-react';
import { useStore } from '../store.js';
import { Badge, Eyebrow, IconButton, cx } from './ui.jsx';

const directions = { output: 'Output', input: 'Input', playback: 'Playback', recording: 'Recording' };
const STATE_TONE = { running: 'ok', idle: 'neutral', suspended: 'warn', error: 'bad' };

function MixerRow({ viewer, node, nodes, controls, routing }) {
  const peak = useStore(viewer.store, s => s.mixerLevels[node.id] ?? 0);
  const [draft, setDraft] = useState(null);
  const timer = useRef(0);
  useEffect(() => {
    setDraft(null); clearTimeout(timer.current);
    return () => clearTimeout(timer.current);
  }, [node.id, controls]);
  useEffect(() => {
    if (draft !== null && Math.abs((node.volume ?? 0) - draft) < 0.1) { setDraft(null); clearTimeout(timer.current); }
  }, [node.volume, draft]);

  function changeVolume(value) {
    if (!viewer.mixer.command({ op: 'volume', id: node.id, value }, () => setDraft(current => current === value ? null : current))) { setDraft(null); return; }
    setDraft(value); clearTimeout(timer.current);
    // Bound the optimistic display; command errors come from the server.
    timer.current = setTimeout(() => setDraft(null), 3500);
  }

  const targetKind = node.kind === 'playback' ? 'output' : node.kind === 'recording' ? 'input' : null;
  const targets = nodes.filter(n => n.kind === targetKind);
  const endpoints = nodes.filter(n => n.kind === node.kind);
  const route = node.targets.map(id => nodes.find(n => n.id === id)?.name).filter(Boolean).join(', ');
  const level = !node.meter_active ? 'Inactive' : peak > 0.00001 ? `${(20 * Math.log10(peak)).toFixed(1)} dBFS` : 'Silent';
  return (
    <article role="group" aria-label={`${node.name} ${directions[node.kind]}`} data-audio-id={node.id} className="card flex flex-col gap-2.5 p-3">
      <div className="flex items-start gap-2">
        <h3 className="min-w-0 flex-1 text-sm leading-tight font-medium break-words text-ink">{node.name}</h3>
        {node.is_default && <Badge tone="accent">Default</Badge>}
        <Badge tone={STATE_TONE[node.state] ?? 'neutral'}>{directions[node.kind]} · {node.state}</Badge>
      </div>
      <div className="flex items-center gap-2">
        {node.volume !== null ? <label className="flex min-w-0 flex-1 items-center gap-2">
          <span className="w-12 shrink-0 text-[11px] text-ink-3">Volume</span>
          <input type="range" min="0" max="100" step="1" aria-label={`${node.name} Volume`} className="range"
            value={draft ?? Math.round(node.volume)} disabled={!controls || !node.volume_writable}
            onChange={event => changeVolume(Number(event.target.value))} />
          <output className="w-10 shrink-0 text-right font-mono text-[11px] text-ink-2 tabular-nums">{Math.round(draft ?? node.volume)}%</output>
        </label> : <span className="flex-1 text-[11px] text-ink-4">Volume Unavailable</span>}
        {node.mute !== null ? <button type="button" className={cx('btn btn-xs', node.mute ? 'btn-primary' : 'btn-outline')} aria-label={`${node.name} Mute`} aria-pressed={node.mute}
          disabled={!controls || !node.mute_writable} onClick={() => viewer.mixer.command({ op: 'mute', id: node.id, value: !node.mute })}>
          {node.mute ? <><VolumeX className="size-3" /> Unmute</> : <><Volume2 className="size-3" /> Mute</>}
        </button> : <span className="text-[11px] text-ink-4">Mute Unavailable</span>}
        {!targetKind && endpoints.length > 1 && <button type="button" className="btn btn-outline btn-xs" disabled={!controls || !routing || !node.routing_writable || node.is_default}
          onClick={() => viewer.mixer.command({ op: 'default', id: node.id })}>{node.is_default ? 'Default' : 'Make Default'}</button>}
      </div>
      {targetKind && <div className="flex flex-wrap items-center gap-2 text-[11px] text-ink-3">
        <span className="w-12 shrink-0">{directions[targetKind]}</span>
        {targets.length > 1 ? <label className="flex min-w-0 flex-1 items-center gap-1.5">
          <select aria-label={`${node.name} Target`} className="select min-w-0 flex-1"
            disabled={!controls || !routing || !node.routing_writable} value={node.targets.length === 1 ? node.targets[0] : '__current'}
            onChange={event => viewer.mixer.command({ op: 'target', id: node.id, target: event.target.value || null })}>
            {node.targets.length !== 1 && <option value="__current" disabled>{node.targets.length ? 'Multiple Targets' : 'Not Linked'}</option>}
            <option value="">Session Default</option>
            {targets.map(target => <option key={target.id} value={target.id}>{target.name}{target.is_default ? ' (Default)' : ''}</option>)}
          </select></label> : <span className="truncate text-ink-2">{route || 'Not Linked'}</span>}
        {targets.length > 1 && (!routing || !node.routing_writable) && <span className="text-ink-4">Routing Unavailable</span>}
      </div>}
      <div className="flex items-center gap-2 text-[11px] text-ink-3">
        <span className="w-12 shrink-0">Level</span>
        <meter min="0" max="1" value={node.meter_active ? Math.min(1, peak) : 0} aria-label={`${node.name} Peak Level`} aria-valuetext={level} title={node.meter_before_volume ? 'Before Volume and Mute' : 'After Volume and Mute'} className="meter min-w-0 flex-1" />
        <span className="w-[11ch] shrink-0 whitespace-nowrap text-right font-mono text-ink-2 tabular-nums">{level}</span>
      </div>
      {node.meter_error && <p className="callout callout-warn">Meter unavailable: {node.meter_error}</p>}
    </article>
  );
}

export function MixerPanel({ viewer, hidden = false, onClose, onPopOut, poppedOut = false }) {
  const subscription = useRef({});
  const snapshot = useStore(viewer.store, s => s.mixer);
  const error = useStore(viewer.store, s => s.mixerError);
  const role = useStore(viewer.store, s => s.role);
  const status = useStore(viewer.store, s => s.status);
  const [visible, setVisible] = useState(() => !document.hidden);
  const close = useRef(null);
  useEffect(() => {
    const visibility = () => setVisible(!document.hidden);
    document.addEventListener('visibilitychange', visibility);
    close.current?.focus();
    return () => document.removeEventListener('visibilitychange', visibility);
  }, []);
  useEffect(() => {
    viewer.mixer.subscribe(!hidden && visible && status === 'connected', subscription.current);
    return () => viewer.mixer.subscribe(false, subscription.current);
  }, [viewer, hidden, visible, status]);
  const controls = role === 'controller' && status === 'connected' && snapshot.available;
  const groups = new Map();
  for (const node of snapshot.nodes) {
    const name = node.kind === 'output' || node.kind === 'input' ? 'Session Devices' : node.application || 'Other Applications';
    if (!groups.has(name)) groups.set(name, []);
    groups.get(name).push(node);
  }
  return (
    <section aria-label="Audio Mixer" hidden={hidden} className={cx('flex shrink-0 flex-col border-t border-line bg-surface text-sm', poppedOut ? 'h-full' : 'max-h-[45vh]')}>
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-line px-3">
        <SlidersHorizontal className="size-3.5 text-ink-3" />
        <h2 className="text-xs font-medium text-ink">Audio Mixer</h2>
        {role !== 'controller' && <Badge tone="warn" className="ml-2">Read Only</Badge>}
        <span className="ml-auto flex items-center gap-1">
          {role === 'participant' && <button type="button" className="btn btn-primary btn-xs" onClick={viewer.takeControl}><MousePointer2 className="size-3" /> Take Control</button>}
          {onPopOut && <IconButton icon={ExternalLink} label="Pop Out Mixer" size="sm" onClick={onPopOut} />}
          <IconButton ref={close} icon={X} label="Close Mixer" size="sm" onClick={onClose} />
        </span>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        {snapshot.available && snapshot.error && <p role="alert" className="callout callout-warn mb-3">{snapshot.error}</p>}
        {error && <p role="alert" className="callout callout-warn mb-3">{error}</p>}
        {status !== 'connected' ? <p className="text-xs text-ink-3">Connecting…</p>
          : !snapshot.available ? <p className="text-xs text-ink-3">{snapshot.error || 'Connecting…'}</p>
          : [...groups].map(([name, nodes]) => <div key={name} className="mb-4 last:mb-0">
            <Eyebrow className="mb-2">{name}</Eyebrow>
            <div className="grid gap-2 md:grid-cols-2 2xl:grid-cols-3">
              {nodes.map(node => <MixerRow key={node.id} viewer={viewer} node={node} nodes={snapshot.nodes} controls={controls} routing={snapshot.routing} />)}
            </div>
          </div>)}
      </div>
    </section>
  );
}
