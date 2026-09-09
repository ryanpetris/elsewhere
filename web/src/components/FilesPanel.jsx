import { useEffect, useRef, useState } from 'react';
import { ArrowUp, ChevronLeft, ChevronRight, Download, File, Folder, FolderInput, FolderPlus, Home, Link2, Loader2, Pencil, RefreshCw, Trash2, Upload, X } from 'lucide-react';
import { useStore } from '../store.js';
import { files, deleteFile, downloadFile, manageFile } from '../api.js';
import { cx } from './ui.jsx';

const join = (path, name) => `${path === '/' ? '' : path}/${name}`;
const size = n => n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(0)} KB` : `${(n / 1048576).toFixed(1)} MB`;
const crumb = 'max-w-[12rem] truncate rounded px-1.5 py-0.5 text-[11px] text-ink-2 transition-colors hover:bg-surface-3 hover:text-ink disabled:opacity-40';
const tool = 'btn btn-ghost btn-xs';

export function FilesPanel({ viewer, open }) {
  const path = useStore(viewer.store, s => s.filesPath);
  const permissions = useStore(viewer.store, s => s.permissions);
  const change = useStore(viewer.store, s => s.filesChange);
  const filesOpen = useStore(viewer.store, s => s.filesOpen);
  const upload = useStore(viewer.store, s => s.upload);
  const [started, setStarted] = useState(false);
  const [draft, setDraft] = useState(path);
  const [options, setOptions] = useState({ hidden: false, sort: 'name', desc: false, offset: 0 });
  const [revision, setRevision] = useState(0);
  const [listing, setListing] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);
  const current = useRef({ path, listing });
  const canonical = useRef(null);
  current.current = { path, listing };
  const acts = permissions.includes('files.browse');
  useEffect(() => { if (open) setStarted(true); }, [open]);
  useEffect(() => setDraft(path), [path]);
  useEffect(() => { if (filesOpen) setOptions(o => ({ ...o, offset: 0 })); }, [filesOpen]);
  useEffect(() => {
    if (!started || !acts) return;
    // A successful response resolves shortcuts and symlink directories without a second request.
    if (canonical.current?.path === path && canonical.current.revision === revision && canonical.current.options === options) { canonical.current = null; return; }
    const abort = new AbortController();
    setLoading(true); setError(null); setListing(null);
    files({ path, ...options }, abort.signal).then(result => {
      if (abort.signal.aborted) return;
      setListing(result); setLoading(false);
      if (path !== result.path) {
        canonical.current = { path: result.path, revision, options };
        viewer.store.set({ filesPath: result.path });
      }
    }).catch(e => {
      if (!abort.signal.aborted) { setError(e); setLoading(false); }
    });
    return () => abort.abort();
  }, [started, acts, path, options, revision, viewer]);
  useEffect(() => {
    if (change && (change.directories.includes(current.current.path) || change.requested === current.current.path)) setRevision(n => n + 1);
  }, [change]);
  const navigate = next => {
    canonical.current = null;
    setOptions(o => ({ ...o, offset: 0 }));
    viewer.store.set({ filesPath: next });
  };
  const refresh = () => { canonical.current = null; setRevision(n => n + 1); };
  const mutate = async operation => {
    const destination = listing.path;
    try {
      await operation(destination);
      if (current.current.path === destination) refresh();
    } catch (e) { viewer.notice(e.message); }
  };
  if (!acts) return null;
  const parts = (listing?.path || path).split('/').filter(Boolean);
  const errorText = error?.code === 'permission_denied' ? 'Permission denied.' : error?.code === 'missing' ? 'Directory not found.' : 'Could not read this directory.';
  const manages = permissions.includes('files.manage'), downloads = permissions.includes('files.download');
  return (
    <section aria-label="File browser" className="flex flex-col text-xs" onFocus={viewer.releaseInput}>
      <div className="flex flex-col gap-2 border-b border-line p-2">
        <div className="flex flex-wrap items-center gap-1">
          <button className={tool} onClick={() => navigate('@home')}><Home className="size-3" /> Home</button>
          <button className={tool} onClick={() => navigate('@transfer')}><FolderInput className="size-3" /> Transfer folder</button>
          <button className={tool} onClick={refresh}><RefreshCw className="size-3" /> Refresh</button>
          {listing && (
            <span className="ml-auto flex items-center gap-1">
              {permissions.includes('files.upload') && <label className={cx(tool, 'cursor-pointer')}><Upload className="size-3" /> Upload<input aria-label="Upload files" type="file" multiple className="hidden" onChange={e => { viewer.uploadFiles(e.target.files); e.target.value = ''; }} /></label>}
              {manages && <button className={tool} onClick={() => { const name = prompt('New directory name'); if (name) mutate(path => manageFile({ op: 'mkdir', path, name })); }}><FolderPlus className="size-3" /> New folder</button>}
            </span>
          )}
        </div>
        <form className="flex gap-1" onSubmit={e => { e.preventDefault(); navigate(draft); }}>
          <input aria-label="Directory path" className="input input-sm flex-1 font-mono" value={draft} onChange={e => setDraft(e.target.value)} spellCheck={false} />
          <button className="btn btn-outline btn-sm">Go</button>
        </form>
        {listing && <nav aria-label="Directory breadcrumbs" className="flex flex-wrap items-center gap-0.5 break-all">
          <button className={crumb} onClick={() => navigate('/')}>/</button>
          {parts.map((part, i) => <span key={i} className="flex items-center gap-0.5">
            <ChevronRight className="size-3 shrink-0 text-ink-4" />
            <button className={cx(crumb, i === parts.length - 1 && 'font-medium text-ink')} onClick={() => navigate('/' + parts.slice(0, i + 1).join('/'))}>{part}</button>
          </span>)}
          <button className={cx(crumb, 'ml-auto inline-flex items-center gap-1')} disabled={listing.path === '/'} onClick={() => navigate('/' + parts.slice(0, -1).join('/'))}><ArrowUp className="size-3" /> Parent</button>
        </nav>}
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-ink-3">
          <label className="inline-flex items-center gap-1.5">Sort <select aria-label="Sort files" className="select" value={options.sort} onChange={e => setOptions(o => ({ ...o, sort: e.target.value, offset: 0 }))}>
            <option value="name">Name</option><option value="size">Size</option><option value="modified">Modified</option>
          </select></label>
          <label className="inline-flex items-center gap-1.5"><input type="checkbox" className="check" checked={options.desc} onChange={e => setOptions(o => ({ ...o, desc: e.target.checked, offset: 0 }))} /> Descending</label>
          <label className="inline-flex items-center gap-1.5"><input type="checkbox" className="check" checked={options.hidden} onChange={e => setOptions(o => ({ ...o, hidden: e.target.checked, offset: 0 }))} /> Hidden files</label>
        </div>
      </div>
      {upload && <div className="callout callout-info m-2 flex items-center gap-2 break-all" role="status">
        <Loader2 className="size-3 shrink-0 animate-spin" />
        <span className="min-w-0 flex-1">Uploading {upload.name} ({upload.index}/{upload.count}) to {upload.path}</span>
        <button className="btn btn-ghost btn-xs shrink-0" onClick={viewer.cancelUpload}><X className="size-3" /> Cancel</button>
      </div>}
      {loading && <p role="status" className="flex items-center gap-2 px-3 py-4 text-ink-3"><Loader2 className="size-3 animate-spin" /> Loading directory…</p>}
      {error && <p role="alert" className="callout callout-bad m-2">{errorText} {error.message}</p>}
      {listing?.entries.length === 0 && <p className="px-3 py-6 text-center text-ink-4">{listing.total ? 'No entries on this page.' : 'This directory is empty.'}</p>}
      {listing?.entries.map(entry => {
        const folder = entry.kind === 'directory' || entry.target_kind === 'directory';
        const downloadable = entry.kind === 'file' || entry.target_kind === 'file';
        const Icon = entry.kind === 'symlink' ? Link2 : folder ? Folder : File;
        return <div key={entry.name} className="group flex items-center gap-2.5 border-b border-line/70 px-3 py-2 transition-colors hover:bg-surface-2" data-file-name={entry.name}>
          <Icon className={cx('size-4 shrink-0', folder ? 'text-accent-2' : 'text-ink-4')} strokeWidth={1.75} />
          <div className="min-w-0 flex-1">
            <div className="text-[13px] break-all text-ink">
              {folder ? <button className="text-left hover:text-accent-2 hover:underline" onClick={() => navigate(join(listing.path, entry.name))}>{entry.name}/</button> : entry.name}
              {entry.kind === 'symlink' && <span className="ml-1.5 text-[10px] text-ink-4">↗ symlink{!entry.target_kind ? ' (unavailable target)' : ''}</span>}
            </div>
            <div className="font-mono text-[10px] text-ink-4 tabular-nums">{!folder && `${size(entry.size)} · `}{new Date(entry.modified_ms).toLocaleString()}</div>
          </div>
          <div className="flex shrink-0 items-center gap-px">
            {downloads && downloadable && <button className="btn btn-ghost size-6 px-0" title="Download" aria-label="Download" onClick={() => downloadFile(entry.name, listing.path).catch(e => viewer.notice(e.message))}><Download className="size-3.5" /></button>}
            {manages && <button className="btn btn-ghost size-6 px-0" title="Rename" aria-label="Rename" onClick={() => { const new_name = prompt('Rename entry', entry.name); if (new_name && new_name !== entry.name) mutate(path => manageFile({ op: 'rename', path, name: entry.name, new_name })); }}><Pencil className="size-3.5" /></button>}
            {manages && entry.kind !== 'directory' && <button className="btn btn-ghost size-6 px-0 hover:bg-bad/10 hover:text-bad" title="Delete" aria-label="Delete" onClick={() => { if (confirm(`Delete ${entry.name}?`)) mutate(path => deleteFile(entry.name, path)); }}><Trash2 className="size-3.5" /></button>}
          </div>
        </div>;
      })}
      {listing && <div className="flex items-center justify-between gap-2 px-2 py-2 text-ink-3">
        <button className={tool} disabled={!options.offset} onClick={() => setOptions(o => ({ ...o, offset: Math.max(0, o.offset - listing.limit) }))}><ChevronLeft className="size-3" /> Previous</button>
        <span className="font-mono text-[11px] tabular-nums">{listing.total ? `${listing.offset + 1}–${listing.offset + listing.entries.length} of ${listing.total}` : '0 entries'}</span>
        <button className={tool} disabled={listing.offset + listing.limit >= listing.total} onClick={() => setOptions(o => ({ ...o, offset: o.offset + listing.limit }))}>Next <ChevronRight className="size-3" /></button>
      </div>}
      {!!listing?.omitted && <p className="px-3 pb-3 text-ink-4">{listing.omitted} names omitted because they are not UTF-8.</p>}
    </section>
  );
}
