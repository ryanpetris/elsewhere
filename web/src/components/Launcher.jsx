// The application menu (the installed .desktop launchers, searchable, by category) and the power menu.
import { forwardRef, useEffect, useRef, useState } from 'react';
import { AppWindow, Power, Search, TriangleAlert } from 'lucide-react';
import { appIcon, applications } from '../api.js';
import { cx } from './ui.jsx';

// freedesktop main categories, as menus label them; the first match names the group
const CATEGORIES = [
  ['AudioVideo', 'Multimedia'], ['Audio', 'Multimedia'], ['Video', 'Multimedia'], ['Development', 'Development'],
  ['Education', 'Education'], ['Game', 'Games'], ['Graphics', 'Graphics'], ['Network', 'Internet'], ['Office', 'Office'],
  ['Science', 'Science'], ['Settings', 'Settings'], ['System', 'System'], ['Utility', 'Accessories'],
];
const groupOf = app => CATEGORIES.find(([c]) => app.categories.includes(c))?.[1] ?? 'Other';

/// A popover under the top bar; a click outside or Escape closes it. `floating` places it by style instead.
export const Popover = forwardRef(function Popover({ onClose, className = '', floating = false, children, ...props }, ref) {
  useEffect(() => {
    const key = e => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onClose(e); } };
    document.addEventListener('keydown', key, true);
    return () => document.removeEventListener('keydown', key, true);
  }, [onClose]);
  return (
    <>
      <div className={floating ? 'fixed inset-0 z-20' : 'absolute inset-x-0 top-12 bottom-0 z-20'} onClick={onClose} />
      <div ref={ref} tabIndex={-1} onKeyDown={event => event.stopPropagation()} onKeyUp={event => event.stopPropagation()} {...props}
        className={cx(floating ? 'fixed' : 'absolute top-[3.25rem]', 'z-30 flex animate-pop flex-col overflow-hidden rounded-xl border border-line-2 bg-surface shadow-pop', className)}>
        {children}
      </div>
    </>
  );
});

export function Launcher({ viewer, onClose }) {
  const [apps, setApps] = useState(null);
  const [q, setQ] = useState('');
  const [cursor, setCursor] = useState(0); // the entry Enter launches, moved by the arrow keys
  const list = useRef(null);
  useEffect(() => { applications().then(setApps, () => setApps([])); }, []);
  const needle = q.trim().toLowerCase();
  const shown = (apps ?? []).filter(a => !needle || a.name.toLowerCase().includes(needle) || a.comment?.toLowerCase().includes(needle));
  const groups = needle ? [['Results', shown]] : Object.entries(shown.reduce((g, a) => ((g[groupOf(a)] ??= []).push(a), g), {})).sort(([a], [b]) => a.localeCompare(b));
  const ordered = groups.flatMap(([, l]) => l);
  const selected = ordered[Math.min(cursor, ordered.length - 1)];
  const launch = app => { viewer.launch(app.id); onClose(); };
  const move = delta => {
    if (!ordered.length) return;
    const next = (Math.min(cursor, ordered.length - 1) + delta + ordered.length) % ordered.length;
    setCursor(next);
    list.current?.querySelector(`[data-app="${CSS.escape(ordered[next].id)}"]`)?.scrollIntoView({ block: 'nearest' });
  };
  return (
    <Popover onClose={onClose} className="left-2 max-h-[75vh] w-[27rem] max-w-[calc(100vw-1rem)] sm:left-3">
      <label className="flex items-center gap-2.5 border-b border-line px-3 py-2.5">
        <Search className="size-4 shrink-0 text-ink-3" />
        <input
          autoFocus
          value={q}
          onChange={e => { setQ(e.target.value); setCursor(0); }}
          onFocus={viewer.releaseInput}
          onKeyDown={e => {
            if (e.key === 'Enter') e.preventDefault();
            if (e.key === 'ArrowDown') { e.preventDefault(); move(1); }
            if (e.key === 'ArrowUp') { e.preventDefault(); move(-1); }
          }}
          onKeyUp={e => { if (e.key === 'Enter' && needle && selected) launch(selected); }}
          placeholder="Search applications…"
          spellCheck={false}
          autoComplete="off"
          className="min-w-0 flex-1 bg-transparent text-sm text-ink placeholder:text-ink-4 focus:outline-none"
        />
        <kbd className="kbd hidden sm:inline-flex">Esc</kbd>
      </label>
      <div ref={list} className="min-h-0 flex-1 overflow-y-auto p-2">
        {apps === null && <div className="px-2 py-8 text-center text-sm text-ink-4">Loading…</div>}
        {apps !== null && shown.length === 0 && <div className="px-2 py-8 text-center text-sm text-ink-4">{apps.length ? 'Nothing matches.' : 'No applications found.'}</div>}
        {groups.map(([label, items]) => (
          <section key={label} className="mb-1.5">
            <h3 className="eyebrow px-2 pt-2 pb-1">{label}</h3>
            {items.map(app => (
              <button key={app.id} type="button" data-app={app.id} onClick={() => launch(app)}
                onMouseMove={() => { const i = ordered.indexOf(app); if (i !== cursor) setCursor(i); }}
                onKeyDown={e => { if (e.key === 'Enter') e.preventDefault(); }}
                onKeyUp={e => { if (e.key === 'Enter') launch(app); }} title={app.comment}
                className={cx('flex w-full items-center gap-3 rounded-md px-2 py-1.5 text-left transition-colors', selected === app ? 'bg-surface-3' : 'hover:bg-surface-2')}>
                <AppIcon id={app.id} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm text-ink">{app.name}</span>
                  {app.comment && <span className="block truncate text-[11px] text-ink-3">{app.comment}</span>}
                </span>
                {selected === app && needle && <kbd className="kbd">↵</kbd>}
              </button>
            ))}
          </section>
        ))}
      </div>
      <div className="flex items-center gap-3 border-t border-line px-3 py-1.5 text-[11px] text-ink-4">
        <span>{apps ? `${shown.length} ${shown.length === 1 ? 'application' : 'applications'}` : ''}</span>
        <span className="ml-auto hidden items-center gap-1.5 sm:flex"><kbd className="kbd">↑</kbd><kbd className="kbd">↓</kbd> select <kbd className="kbd ml-1">↵</kbd> launch</span>
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
            <p className="text-sm leading-relaxed text-ink-2">Quit Elsewhere? Every window closes with it, and the desktop is gone until it is started again.</p>
          </div>
          <div className="mt-4 flex justify-end gap-2">
            <button ref={ref} type="button" onClick={onClose} className="btn btn-outline btn-sm">Cancel</button>
            <button type="button" onClick={event => { viewer.quit(); onClose(event); }} className="btn btn-danger btn-sm">Quit</button>
          </div>
        </div>
      ) : (
        <button ref={ref} type="button" aria-label="Quit Elsewhere" onClick={() => setSure(true)} className="flex w-full items-center gap-3 rounded-md px-2 py-2 text-left text-sm text-ink transition-colors hover:bg-bad/10 hover:text-bad">
          <Power className="size-4 text-bad" /> Quit Elsewhere
          <span className="ml-auto text-[11px] text-ink-4">stops the server</span>
        </button>
      )}
    </Popover>
  );
}
