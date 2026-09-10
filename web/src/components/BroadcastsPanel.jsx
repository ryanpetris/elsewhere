import { useEffect, useRef, useState } from 'react';
import { Pencil, Play, Plus, Radio, Square, Trash2 } from 'lucide-react';
import { useStore } from '../store.js';
import { PRESET_PREFIX, loadPresets, savePreset, removePreset, listBroadcasts, broadcastCapabilities, startBroadcast, stopBroadcast } from '../broadcasts.js';
import { Badge, Eyebrow, cx } from './ui.jsx';

const defaults = () => ({ preset_id: crypto.randomUUID(), label: 'Broadcast', url: '', stream_key: '', width: 1280, height: 720, fps: 30, bitrate_kbps: 4000, audio: 'silence', cursor: true });
const terminal = state => ['stopped', 'failed'].includes(state);
const STATE = { running: ['ok', true], starting: ['warn', true], stopping: ['warn', true], stopped: ['neutral', false], failed: ['bad', false] };

export function BroadcastsPanel({ viewer, open }) {
  const permissions = useStore(viewer.store, s => s.permissions);
  const acts = permissions.includes('broadcasts.manage');
  const [presets, setPresets] = useState([]), [streams, setStreams] = useState([]);
  const [caps, setCaps] = useState(null), [edit, setEdit] = useState(null);
  const [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const [pollError, setPollError] = useState('');
  const pending = useRef(new Map());
  const generation = useRef(0);
  const refreshPresets = () => { try { setPresets(loadPresets()); } catch { setError('Browser storage is unavailable. Settings cannot be saved.'); } };
  useEffect(() => {
    refreshPresets();
    const changed = event => { if (event.key === null || event.key.startsWith(PRESET_PREFIX)) refreshPresets(); };
    window.addEventListener('storage', changed);
    return () => window.removeEventListener('storage', changed);
  }, []);
  useEffect(() => {
    if (!open || !acts) return;
    let active = true, timer;
    const update = async () => {
      const current = generation.current;
      try { const [runs, capabilities] = await Promise.all([listBroadcasts(), broadcastCapabilities()]); if (active && current === generation.current) { setStreams(runs); setCaps(capabilities); setPollError(''); } }
      catch (e) { if (active && current === generation.current) setPollError(e.message); }
      finally { if (active) timer = setTimeout(update, 1500); }
    };
    update();
    return () => { active = false; clearTimeout(timer); };
  }, [open, acts]);
  const action = async fn => {
    if (busy) return;
    setBusy(true); setError(''); generation.current++;
    try { await fn(); const runs = await listBroadcasts(); generation.current++; setStreams(runs); }
    catch (e) { setError(e.message); }
    finally { setBusy(false); }
  };
  const start = preset => action(async () => {
    const { preset_id, ...settings } = preset;
    let retry = pending.current.get(preset_id);
    const serialized = JSON.stringify(settings);
    if (!retry || retry.settings !== serialized || Date.now() - retry.created > 9 * 60 * 1000) {
      retry = { request_id: crypto.randomUUID(), settings: serialized, created: Date.now() };
      pending.current.set(preset_id, retry);
    }
    await startBroadcast({ ...settings, request_id: retry.request_id });
    pending.current.delete(preset_id);
  });
  const save = event => {
    event.preventDefault();
    try { savePreset(edit); refreshPresets(); setEdit(null); setError(''); }
    catch { setError('Could not save settings in browser storage.'); }
  };
  const field = 'flex flex-col gap-1 text-[11px] text-ink-3';
  return <div className="flex flex-col gap-4 p-3" data-broadcasts>
    {error && <p role="alert" className="callout callout-bad">{error}</p>}
    {pollError && <p role="alert" className="callout callout-bad">{pollError}</p>}
    {caps && !caps.available && <p className="callout callout-warn">{caps.error}</p>}
    {!acts && <p className="callout callout-info">Broadcast management permission is required.</p>}
    <div className="flex items-center justify-between">
      <Eyebrow>Saved Presets</Eyebrow>
      <button className="btn btn-outline btn-xs" onClick={() => setEdit(defaults())}><Plus className="size-3" /> Add Preset</button>
    </div>
    {presets.length === 0 && !edit && <p className="rounded-lg border border-dashed border-line-2 px-3 py-4 text-center text-xs text-ink-4">No Presets</p>}
    {presets.map(p => <div key={p.preset_id} className="card p-3">
      <div className="flex items-start gap-2">
        <span className="flex size-7 shrink-0 items-center justify-center rounded-md bg-surface-3 text-ink-3"><Radio className="size-3.5" /></span>
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium text-ink">{p.label}</div>
          <div className="font-mono text-[11px] text-ink-3">{p.width}×{p.height} · {p.fps} fps · {p.bitrate_kbps} kbps{p.audio === 'desktop' ? ' · desktop audio' : ''}</div>
        </div>
      </div>
      {p.audio === 'desktop' && caps && !caps.desktop_audio && <p className="callout callout-warn mt-2">Desktop audio unavailable.</p>}
      <div className="mt-2.5 flex gap-1.5">
        <button className="btn btn-primary btn-xs" disabled={!acts || !permissions.includes('desktop.view') || (p.audio === 'desktop' && !permissions.includes('audio.listen')) || busy || !caps?.available || (p.audio === 'desktop' && !caps.desktop_audio)} onClick={() => start(p)}><Play className="size-3" /> Start</button>
        <button className="btn btn-outline btn-xs" onClick={() => setEdit({ ...p })}><Pencil className="size-3" /> Edit</button>
        <button className="btn btn-ghost btn-xs ml-auto hover:bg-bad/10 hover:text-bad" onClick={() => { try { removePreset(p.preset_id); refreshPresets(); } catch { setError('Could not remove the preset.'); } }}><Trash2 className="size-3" /> Remove</button>
      </div>
    </div>)}
    {edit && <form onSubmit={save} className="card flex flex-col gap-3 border-accent/40 p-3" aria-label="Broadcast Preset">
      <Eyebrow>{presets.some(p => p.preset_id === edit.preset_id) ? 'Edit Preset' : 'New Preset'}</Eyebrow>
      {[['label', 'Name'], ['url', 'Ingest URL'], ['stream_key', 'Stream Key']].map(([key, label]) => <label key={key} className={field}>{label}<input className="input input-sm" value={edit[key]} required={key !== 'stream_key'} maxLength={key === 'label' ? 120 : 4096} autoComplete="off" onChange={e => setEdit({ ...edit, [key]: e.target.value })} /></label>)}
      <div className="grid grid-cols-2 gap-2">
        {[['width', 'Width', 64, caps?.max_width || 3840, 2], ['height', 'Height', 64, caps?.max_height || 2160, 2]].map(([key, label, min, max, step]) => <label key={key} className={field}>{label}<input className="input input-sm" type="number" required min={min} max={max} step={step} value={edit[key]} onChange={e => setEdit({ ...edit, [key]: +e.target.value })} /></label>)}
        <label className={field}>Video Bitrate (kbps)<input className="input input-sm" type="number" required min={100} max={50000} step={1} value={edit.bitrate_kbps} onChange={e => setEdit({ ...edit, bitrate_kbps: +e.target.value })} /></label>
        <label className={field}>Frame Rate<select className="select select-md w-full" value={edit.fps} onChange={e => setEdit({ ...edit, fps: +e.target.value })}>{[24, 25, 30, 50, 60].map(fps => <option key={fps}>{fps}</option>)}</select></label>
      </div>
      <label className={field}>Audio<select className="select select-md w-full" value={edit.audio} onChange={e => setEdit({ ...edit, audio: e.target.value })}><option value="silence">Silence</option><option value="desktop">Desktop Audio</option></select></label>
      <label className="flex items-center gap-2 text-xs text-ink-2"><input type="checkbox" className="check" checked={edit.cursor} onChange={e => setEdit({ ...edit, cursor: e.target.checked })} />Include Pointer</label>
      <div className="flex justify-end gap-1.5"><button className="btn btn-outline btn-xs" type="button" onClick={() => setEdit(null)}>Cancel</button><button className="btn btn-primary btn-xs" type="submit">Save Preset</button></div>
    </form>}
    <Eyebrow>Desktop Streams</Eyebrow>
    {streams.length === 0 && <p className="rounded-lg border border-dashed border-line-2 px-3 py-4 text-center text-xs text-ink-4">No Streams</p>}
    {streams.map(s => {
      const [tone, pulse] = STATE[s.state] ?? ['neutral', false];
      return <div key={s.id} className={cx('card p-3', s.state === 'running' && 'border-ok/30')} data-broadcast-id={s.id}>
        <div className="flex items-start gap-2">
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-medium text-ink">{s.label}</div>
            <div className="font-mono text-[11px] text-ink-3">{s.width}×{s.height} · {s.fps} fps · {(s.bytes / 1e6).toFixed(1)} MB sent</div>
          </div>
          <Badge tone={tone} dot pulse={pulse} className="capitalize">{s.state}</Badge>
        </div>
        {s.error && <p className="callout callout-warn mt-2">{s.error}</p>}
        {!terminal(s.state) && <button className="btn btn-outline btn-xs mt-2.5" disabled={!acts || busy || s.state === 'stopping'} onClick={() => action(() => stopBroadcast(s.id))}><Square className="size-3" /> Stop</button>}
      </div>;
    })}
  </div>;
}
