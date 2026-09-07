import { useEffect, useRef, useState } from 'react';
import { useStore } from '../store.js';
import { PRESET_PREFIX, loadPresets, savePreset, removePreset, listBroadcasts, broadcastCapabilities, startBroadcast, stopBroadcast } from '../broadcasts.js';

const defaults = () => ({ preset_id: crypto.randomUUID(), label: 'Broadcast', url: '', stream_key: '', width: 1280, height: 720, fps: 30, bitrate_kbps: 4000, audio: 'silence', cursor: true });
const inputClass = 'w-full rounded border border-zinc-700 bg-zinc-950 p-2 text-sm text-zinc-100';
const buttonClass = 'rounded border border-zinc-600 px-2 py-1 text-sm disabled:opacity-40';
const terminal = state => ['stopped', 'failed'].includes(state);

export function BroadcastsPanel({ viewer, open }) {
  const role = useStore(viewer.store, s => s.role);
  const acts = ['controller', 'participant'].includes(role);
  const [presets, setPresets] = useState([]), [streams, setStreams] = useState([]);
  const [caps, setCaps] = useState(null), [edit, setEdit] = useState(null);
  const [error, setError] = useState(''), [busy, setBusy] = useState(false);
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
    if (!open) return;
    let active = true, timer;
    const update = async () => {
      const current = generation.current;
      try { const [runs, capabilities] = await Promise.all([listBroadcasts(), broadcastCapabilities()]); if (active && current === generation.current) { setStreams(runs); setCaps(capabilities); } }
      catch (e) { if (active) setError(e.message); }
      finally { if (active) timer = setTimeout(update, 1500); }
    };
    update();
    return () => { active = false; clearTimeout(timer); };
  }, [open]);
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
  return <div className="flex flex-col gap-4 p-3" data-broadcasts>
    <p className="text-xs text-zinc-400">Presets are saved in this browser and shared with desktops on the same origin. Running streams belong to this desktop.</p>
    {error && <p role="alert" className="text-sm text-red-300">{error}</p>}
    {caps && !caps.available && <p className="text-sm text-amber-300">{caps.error}</p>}
    {!acts && <p className="text-sm text-zinc-400">A control token is required to start or stop broadcasts.</p>}
    <div className="flex items-center justify-between"><h3 className="text-sm font-medium">Saved presets</h3><button className={buttonClass} onClick={() => setEdit(defaults())}>Add preset</button></div>
    {presets.map(p => <div key={p.preset_id} className="rounded border border-zinc-700 p-2">
      <div className="truncate text-sm font-medium">{p.label}</div>
      <div className="mb-2 text-xs text-zinc-400">{p.width}×{p.height} · {p.fps} fps · {p.bitrate_kbps} kbps</div>
      <div className="flex gap-2">
        <button className={buttonClass} disabled={!acts || busy || !caps?.available} onClick={() => start(p)}>Start</button>
        <button className={buttonClass} onClick={() => setEdit({ ...p })}>Edit</button>
        <button className={buttonClass} onClick={() => { try { removePreset(p.preset_id); refreshPresets(); } catch { setError('Could not remove the preset.'); } }}>Remove</button>
      </div>
    </div>)}
    {edit && <form onSubmit={save} className="flex flex-col gap-2 rounded border border-zinc-600 p-3" aria-label="Broadcast preset">
      {[['label', 'Name'], ['url', 'Ingest URL'], ['stream_key', 'Stream key']].map(([key, label]) => <label key={key} className="text-xs text-zinc-300">{label}<input className={inputClass} value={edit[key]} required={key !== 'stream_key'} maxLength={key === 'label' ? 120 : 4096} autoComplete="off" onChange={e => setEdit({ ...edit, [key]: e.target.value })} /></label>)}
      {[['width', 'Width', 64, caps?.max_width || 3840, 2], ['height', 'Height', 64, caps?.max_height || 2160, 2], ['bitrate_kbps', 'Video bitrate, kbps', 100, 50000, 1]].map(([key, label, min, max, step]) => <label key={key} className="text-xs text-zinc-300">{label}<input className={inputClass} type="number" required min={min} max={max} step={step} value={edit[key]} onChange={e => setEdit({ ...edit, [key]: +e.target.value })} /></label>)}
      <label className="text-xs text-zinc-300">Frame rate<select className={inputClass} value={edit.fps} onChange={e => setEdit({ ...edit, fps: +e.target.value })}>{[24,25,30,50,60].map(fps => <option key={fps}>{fps}</option>)}</select></label>
      <label className="text-xs text-zinc-300">Audio<select className={inputClass} value={edit.audio} onChange={e => setEdit({ ...edit, audio: e.target.value })}><option value="silence">Silence</option><option value="desktop">Desktop sound</option></select></label>
      <label className="flex gap-2 text-sm"><input type="checkbox" checked={edit.cursor} onChange={e => setEdit({ ...edit, cursor: e.target.checked })} />Include mouse pointer</label>
      <div className="flex gap-2"><button className={buttonClass} type="submit">Save preset</button><button className={buttonClass} type="button" onClick={() => setEdit(null)}>Cancel</button></div>
    </form>}
    <h3 className="text-sm font-medium">Streams on this desktop</h3>
    {streams.length === 0 && <p className="text-sm text-zinc-500">No streams.</p>}
    {streams.map(s => <div key={s.id} className="rounded border border-zinc-700 p-2" data-broadcast-id={s.id}>
      <div className="text-sm font-medium">{s.label}</div><div className="text-sm capitalize">{s.state}</div>
      <div className="text-xs text-zinc-400">{s.width}×{s.height} · {s.fps} fps · {(s.bytes / 1e6).toFixed(1)} MB sent</div>
      {s.error && <p className="my-1 text-xs text-amber-300">{s.error}</p>}
      {!terminal(s.state) && <button className={buttonClass + ' mt-2'} disabled={!acts || busy || s.state === 'stopping'} onClick={() => action(() => stopBroadcast(s.id))}>Stop</button>}
    </div>)}
  </div>;
}
