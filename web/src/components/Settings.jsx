import { useEffect, useRef, useState } from 'react';
import { Maximize, MousePointer2, ScanSearch, SquareDashed } from 'lucide-react';
import { api } from '../api.js';
import { useStore } from '../store.js';
import { Popover } from './Launcher.jsx';

function Toggle({ inputRef, icon: Icon, label, description, id, checked, onChange, disabled = false }) {
  return (
    <label className="flex min-h-11 cursor-pointer items-start gap-3 rounded-lg px-2 py-2 transition-colors hover:bg-surface-2">
      <span className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-md bg-surface-3 text-ink-3"><Icon className="size-3.5" strokeWidth={1.75} /></span>
      <span className="min-w-0 flex-1">
        <span className="block text-sm text-ink">{label}</span>
        <span id={id} className="mt-0.5 block text-xs leading-relaxed text-ink-3">{description}</span>
      </span>
      <input ref={inputRef} type="checkbox" disabled={disabled} aria-label={label} checked={checked} onChange={event => onChange(event.target.checked)} className="switch mt-1" aria-describedby={id} />
    </label>
  );
}

export function Settings({ viewer, borders, onBorders, elements, onElements, onClose }) {
  const first = useRef(null);
  const captureOnClick = useStore(viewer.store, s => s.captureOnClick);
  useEffect(() => {
    viewer.releaseInput();
    if (document.pointerLockElement) document.exitPointerLock();
    first.current?.focus();
  }, [viewer]);
  // Keep keyboard navigation local; Escape returns focus to the Settings button.
  const keyDown = event => {
    event.stopPropagation();
    if (event.key === 'Tab') {
      const inputs = [...event.currentTarget.querySelectorAll('input:not(:disabled), select:not(:disabled), button:not(:disabled)')];
      const index = inputs.indexOf(document.activeElement);
      event.preventDefault();
      if (!inputs.length) return;
      inputs[index < 0 ? (event.shiftKey ? inputs.length - 1 : 0) : (index + (event.shiftKey ? inputs.length - 1 : 1)) % inputs.length].focus();
    }
  };
  return (
    <Popover id="viewer-settings" role="dialog" aria-label="Settings" onClose={onClose}
      onKeyDown={keyDown}
      className="right-2 max-h-[calc(100dvh-4rem)] w-[22rem] max-w-[calc(100vw-1rem)] overflow-y-auto sm:right-3">
      <div className="flex items-center justify-between border-b border-line px-4 py-2.5">
        <span className="text-sm font-medium text-ink">Settings</span>
        <kbd className="kbd">Esc</kbd>
      </div>
      <div className="flex flex-col gap-1 p-2">
        <h2 className="eyebrow px-2 pt-2 pb-1">Overlays</h2>
        <Toggle inputRef={first} icon={SquareDashed} id="borders-description" label="Window borders" checked={borders} onChange={onBorders}
          description="Coloured viewer outlines around remote windows. Application title bars and decorations stay unchanged." />
        <Toggle icon={ScanSearch} id="elements-description" label="UI elements" checked={elements} onChange={onElements}
          description="Accessibility outlines for the focused window. Requires server accessibility support and an application tree; this switch cannot enable server support." />
        <h2 className="eyebrow px-2 pt-3 pb-1">Mouse</h2>
        <Toggle icon={MousePointer2} id="capture-description" label="Capture mouse on click" checked={captureOnClick} onChange={on => viewer.setCaptureOnClick(on)}
          description="Keep the mouse inside the desktop." />
        <DisplaySettings viewer={viewer} />
      </div>
    </Popover>
  );
}


const RESOLUTIONS = ['1280x720', '1920x1080', '2560x1440', '3840x2160'];
function DisplaySettings({ viewer }) {
  const display = useStore(viewer.store, s => s.display);
  const permissions = useStore(viewer.store, s => s.permissions);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const [choice, setChoice] = useState('auto');
  const [width, setWidth] = useState(1920);
  const [height, setHeight] = useState(1080);
  const resolution = display?.resolution;
  useEffect(() => {
    if (!resolution) return;
    const value = resolution.mode === 'auto' ? 'auto' : `${resolution.width}x${resolution.height}`;
    setChoice(value === 'auto' || RESOLUTIONS.includes(value) ? value : 'custom');
    if (resolution.mode === 'fixed') { setWidth(resolution.width); setHeight(resolution.height); }
  }, [resolution?.mode, resolution?.width, resolution?.height]);
  const disabled = !display || !permissions.includes('desktop.control') || pending;
  const apply = async patch => {
    setPending(true); setError('');
    try {
      const response = await api('/api/display', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch) });
      if (!response.ok) throw new Error((await response.json()).error || 'Display settings could not be applied.');
    } catch (error) { setError(error.message); }
    finally { setPending(false); }
  };
  const submit = event => {
    event.preventDefault();
    const [w, h] = choice === 'custom' ? [Number(width), Number(height)] : choice.split('x').map(Number);
    apply({ resolution: choice === 'auto' ? { mode: 'auto' } : { mode: 'fixed', width: w, height: h } });
  };
  return <>
    <h2 className="eyebrow px-2 pt-3 pb-1">Shared desktop</h2>
    <p className="px-2 text-xs text-ink-3">These settings affect everyone viewing this desktop.</p>
    <Toggle icon={Maximize} id="kiosk-description" label="Kiosk mode" checked={display?.kiosk ?? false} disabled={disabled}
      onChange={kiosk => apply({ kiosk })} description="Fullscreen application windows. Turning this off restores their layout; windows opened in kiosk become maximized." />
    <form onSubmit={submit} className="flex flex-col gap-2 px-2 pb-2">
      <label className="flex flex-col gap-1 text-sm">Resolution
        <select aria-label="Desktop resolution" className="select select-md" value={choice} disabled={disabled} onChange={event => setChoice(event.target.value)}>
          <option value="auto">Auto: fit controlling viewer</option>
          {RESOLUTIONS.map(value => <option key={value} value={value}>{value.replace('x', ' × ')}</option>)}
          <option value="custom">Custom</option>
        </select>
      </label>
      {choice === 'custom' && <div className="flex gap-2">
        <label className="min-w-0 flex-1 text-xs">Width<input aria-label="Desktop width" className="input w-full" type="number" min="2" max="8192" step="2" required value={width} disabled={disabled} onChange={event => setWidth(event.target.value)} /></label>
        <label className="min-w-0 flex-1 text-xs">Height<input aria-label="Desktop height" className="input w-full" type="number" min="2" max="8192" step="2" required value={height} disabled={disabled} onChange={event => setHeight(event.target.value)} /></label>
      </div>}
      <button type="submit" className="btn btn-outline btn-sm self-start" disabled={disabled}>Apply resolution</button>
      <p className="text-xs text-ink-3">Fixed resolutions use pixels and scale to fit each viewer. Changes last until the server restarts.</p>
      {error && <p role="alert" className="text-xs text-bad">{error}</p>}
    </form>
  </>;
}
