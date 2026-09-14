// Search applications, windows and viewer actions, and confirm desktop shutdown.
import { forwardRef, useEffect, useRef, useState } from 'react';
import { AppWindow, Power, Search, TriangleAlert } from 'lucide-react';
import { appIcon, applications, WINDOW, PIP } from '../api.js';
import { useStore } from '../store.js';
import { cx } from './ui.jsx';

/// A popover under the top bar; a click outside or Escape closes it. `floating` places it by style instead.
export const Popover = forwardRef(function Popover({ onClose, onKeyDown, className = '', floating = false, children, ...props }, ref) {
  useEffect(() => {
    const key = e => { if (e.key === 'Escape' && !e.isComposing) { e.preventDefault(); e.stopPropagation(); onClose(e); } };
    document.addEventListener('keydown', key, true);
    return () => document.removeEventListener('keydown', key, true);
  }, [onClose]);
  return (
    <>
      <div className={floating ? 'fixed inset-0 z-20' : 'absolute inset-x-0 bottom-0 z-20'} style={floating ? undefined : { top: 'var(--toolbar-height, 3rem)' }} onClick={onClose} />
      <div ref={ref} tabIndex={-1} onKeyDown={event => { event.stopPropagation(); onKeyDown?.(event); }} onKeyUp={event => event.stopPropagation()} {...props}
        style={{ ...(!floating && { top: 'calc(var(--toolbar-height, 3rem) + .25rem)', maxHeight: 'calc(100dvh - var(--toolbar-height, 3rem) - 1rem)' }), ...props.style }}
        className={cx(floating ? 'fixed' : 'absolute', 'z-30 flex animate-pop flex-col overflow-hidden rounded-xl border border-line-2 bg-surface shadow-pop', className)}>
        {children}
      </div>
    </>
  );
});

export function SearchMenu({ viewer, actions, onClose }) {
  const windows = useStore(viewer.store, s => s.windows);
  const permissions = useStore(viewer.store, s => s.permissions);
  const status = useStore(viewer.store, s => s.status);
  const [apps, setApps] = useState(null);
  const [error, setError] = useState('');
  const [loadFailed, setLoadFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [q, setQ] = useState('');
  const [selection, setSelection] = useState(null);
  const list = useRef(null), input = useRef(null);
  const invoking = useRef(false);
  const live = useRef(true);
  useEffect(() => { live.current = true; return () => { live.current = false; }; }, []);
  const composing = useRef(false);
  const canLaunch = !WINDOW && !PIP && status === 'connected' && permissions.includes('apps.launch');
  useEffect(() => {
    setApps(null);
    setLoadFailed(false);
    if (!canLaunch) return;
    const abort = new AbortController();
    applications(abort.signal).then(value => { if (!abort.signal.aborted) setApps(value); }, () => {
      if (!abort.signal.aborted) { setApps([]); setLoadFailed(true); }
    });
    return () => abort.abort();
  }, [canLaunch, attempt]);
  const needle = q.trim().toLowerCase();
  const matches = entry => `${entry.label} ${entry.detail || ''}`.toLowerCase().includes(needle);
  const groups = [
    ['Applications', canLaunch ? (apps ?? []).slice().sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()) || a.id.localeCompare(b.id)).map(a => ({ key: `app:${a.id}`, kind: 'app', id: a.id, label: a.name, detail: [a.comment, a.id].filter(Boolean).join(' · '), permission: 'apps.launch' })) : []],
    ['Windows', !WINDOW && !PIP && status === 'connected' && permissions.includes('desktop.view')
      ? windows.slice().sort((a, b) => a.id - b.id).map(w => ({ key: `window:${w.id}`, kind: 'window', id: w.id, label: w.title || w.app_id || `Window ${w.id}`, detail: `${w.app_id || 'Window'} · #${w.id}${w.minimized ? ' · Minimized' : ''}`, permission: 'desktop.control' })) : []],
    ['Viewer actions', actions.filter(a => a.available()).map(a => ({ ...a, key: `action:${a.id}`, kind: 'action' }))],
  ].map(([label, entries]) => [label, entries.filter(matches)]);
  const ordered = groups.flatMap(([, entries]) => entries);
  // Keep the selected identity when the live list changes; Enter must never target its replacement.
  const selected = selection === null ? ordered[0] : ordered.find(e => e.key === selection);
  useEffect(() => { if (selection === null && selected) setSelection(selected.key); }, [selection, selected?.key]);
  const invoke = async entry => {
    if (invoking.current || entry?.kind === 'window' && !viewer.store.get().permissions.includes('desktop.control')) return;
    if (!entry) { setError('The selected result is no longer available. Select another result.'); return; }
    const current = viewer.store.get();
    if (entry.kind === 'action' ? !actions.find(a => a.id === entry.id)?.available()
      : current.status !== 'connected' || !current.permissions.includes(entry.permission)
        || entry.kind === 'window' && !current.windows.some(w => w.id === entry.id)) {
      setError('This action is no longer available.'); return;
    }
    setError('');
    invoking.current = true;
    try {
      if (entry.kind === 'app') {
        const response = await viewer.launch(entry.id);
        if (!response.ok) throw new Error(`Application launch failed (HTTP ${response.status}).`);
      } else if (entry.kind === 'window') viewer.activate(entry.id);
      else await entry.run(() => live.current && !!actions.find(a => a.id === entry.id)?.available());
      if (live.current) onClose(null, entry.kind === 'action' ? entry.focus : 'canvas.stage');
    } catch (error) { if (live.current) setError(error.message || 'Action failed.'); }
    finally { invoking.current = false; }
  };
  const move = delta => {
    if (!ordered.length) return;
    const index = selected ? ordered.indexOf(selected) : -1;
    const next = ordered[(index + delta + ordered.length) % ordered.length];
    setSelection(next.key);
    list.current?.querySelector(`[data-entry="${CSS.escape(next.key)}"]`)?.scrollIntoView({ block: 'nearest' });
  };
  return (
    <Popover onClose={onClose} role="dialog" aria-modal="true" aria-label="Search"
      onKeyDown={e => {
        e.stopPropagation();
        if (e.key === 'Tab') {
          const targets = [...e.currentTarget.querySelectorAll('input, button:not([tabindex="-1"])')];
          e.preventDefault();
          targets[(targets.indexOf(document.activeElement) + (e.shiftKey ? -1 : 1) + targets.length) % targets.length]?.focus();
        }
      }} className="left-2 max-h-[75vh] w-[27rem] max-w-[calc(100vw-1rem)] sm:left-3">
      <label className="flex items-center gap-2.5 border-b border-line px-3 py-2.5">
        <Search className="size-4 shrink-0 text-ink-3" />
        <input ref={input} autoFocus value={q} aria-label="Search" role="combobox" aria-expanded="true" aria-controls="search-results"
          aria-activedescendant={selected ? `search-${selected.key}` : undefined}
          onChange={e => { setQ(e.target.value); setSelection(null); setError(''); }}
          onFocus={viewer.releaseInput}
          onCompositionStart={() => { composing.current = true; }}
          onCompositionEnd={() => { composing.current = false; }}
          onKeyDown={e => {
            if (composing.current || e.nativeEvent.isComposing || e.keyCode === 229) return;
            if (e.key === 'Enter') { e.preventDefault(); if (!e.repeat) { setSelection(selected?.key ?? selection); invoke(selected); } }
            if (e.key === 'ArrowDown') { e.preventDefault(); move(1); }
            if (e.key === 'ArrowUp') { e.preventDefault(); move(-1); }
          }}
          placeholder="Search…" spellCheck={false} autoComplete="off"
          className="min-w-0 flex-1 bg-transparent text-sm text-ink placeholder:text-ink-4 focus:outline-none" />
        <kbd className="kbd hidden sm:inline-flex">Esc</kbd>
      </label>
      {loadFailed && <div role="alert" className="flex items-center gap-2 px-3 py-2 text-sm text-warn">Applications could not load.<button type="button" className="btn btn-outline btn-sm" onClick={() => { input.current?.focus(); setAttempt(value => value + 1); }}>Retry</button></div>}
      {error && <p role="alert" className="px-3 py-2 text-sm text-warn">{error}</p>}
      {canLaunch && apps === null && <p role="status" className="px-3 py-2 text-sm text-ink-4">Loading applications…</p>}
      <div ref={list} id="search-results" role="listbox" aria-label="Results" className="min-h-0 flex-1 overflow-y-auto p-2">
        {!ordered.length && <p className="px-2 py-8 text-center text-sm text-ink-4">Nothing matches.</p>}
        {groups.filter(([, entries]) => entries.length).map(([label, entries]) => (
          <section key={label} role="group" aria-label={label} className="mb-1.5">
            <h3 className="eyebrow px-2 pt-2 pb-1">{label}</h3>
            {entries.map(entry => (
              <button key={entry.key} id={`search-${entry.key}`} role="option" aria-selected={selected?.key === entry.key}
                type="button" disabled={entry.kind === 'window' && !permissions.includes('desktop.control')} tabIndex={-1} data-entry={entry.key} onClick={() => invoke(entry)}
                onMouseMove={() => setSelection(entry.key)}
                className={cx('flex w-full items-center gap-3 rounded-md px-2 py-1.5 text-left transition-colors', selected?.key === entry.key ? 'bg-surface-3' : 'hover:bg-surface-2')}>
                {entry.kind === 'app' ? <AppIcon id={entry.id} /> : <AppWindow className="size-5 shrink-0 text-ink-3" />}
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm text-ink">{entry.label}</span>
                  {entry.detail && <span className="block truncate text-[11px] text-ink-3">{entry.detail}</span>}
                </span>
              </button>
            ))}
          </section>
        ))}
      </div>
      <div className="flex items-center gap-3 border-t border-line px-3 py-1.5 text-[11px] text-ink-4">
        <span>{ordered.length} results</span>
        <span className="ml-auto hidden items-center gap-1.5 sm:flex"><kbd className="kbd">↑</kbd><kbd className="kbd">↓</kbd> Select <kbd className="kbd ml-1">↵</kbd> Invoke</span>
      </div>
    </Popover>
  );
}

function AppIcon({ id }) {
  const [src, setSrc] = useState(null);
  useEffect(() => {
    let live = true;
    appIcon(id).then(u => { if (live) setSrc(u); });
    return () => { live = false; };
  }, [id]);
  return src
    ? <img src={src} alt="" className="size-8 shrink-0 object-contain" />
    : <span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-surface-3 text-ink-4"><AppWindow className="size-4" strokeWidth={1.5} /></span>;
}

/// Shut Elsewhere down, after a second click. The keyboard stays on the menu's own buttons
/// (and any key held in the compositor is released), so nothing typed here reaches the desktop.
export function PowerMenu({ viewer, onClose }) {
  const [sure, setSure] = useState(false);
  const ref = useRef(null);
  useEffect(() => { viewer.releaseInput(); ref.current?.focus(); }, [viewer, sure]);
  return (
    <Popover onClose={onClose} className="right-2 w-80 p-2 sm:right-3">
      {sure ? (
        <div className="p-2">
          <div className="flex items-start gap-3">
            <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-bad/15 text-bad"><TriangleAlert className="size-4" /></span>
            <p className="text-sm leading-relaxed text-ink-2">Quit Elsewhere and close all windows?</p>
          </div>
          <div className="mt-4 flex justify-end gap-2">
            <button ref={ref} type="button" onClick={onClose} className="btn btn-outline btn-sm">Cancel</button>
            <button type="button" onClick={event => { viewer.quit(); onClose(event); }} className="btn btn-danger btn-sm">Quit</button>
          </div>
        </div>
      ) : (
        <button ref={ref} type="button" aria-label="Quit Elsewhere" onClick={() => setSure(true)} className="flex w-full items-center gap-3 rounded-md px-2 py-2 text-left text-sm text-ink transition-colors hover:bg-bad/10 hover:text-bad">
          <Power className="size-4 text-bad" /> Quit Elsewhere
        </button>
      )}
    </Popover>
  );
}
