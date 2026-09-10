import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Clipboard, ClipboardCheck, ClipboardX, Download, FileText, LoaderCircle, X } from 'lucide-react';
import { useStore } from '../store.js';
import { downloadClipboardFile } from '../api.js';
import { CLIPBOARD_IMAGE_BYTES, CLIPBOARD_IMAGE_PIXELS } from '../clipboard.js';
import { Popover } from './Launcher.jsx';
import { IconButton, cx } from './ui.jsx';

const sizeLabel = size => size == null ? '' : size < 1024 ? `${size} bytes` : `${(size / 1024).toFixed(1)} KiB`;

function ImagePreview({ blob }) {
  const [image, setImage] = useState(null);
  useEffect(() => {
    let live = true, url;
    setImage(null);
    const decode = async () => {
      if (blob.size > CLIPBOARD_IMAGE_BYTES) throw Error();
      const header = new Uint8Array(await blob.slice(0, 24).arrayBuffer());
      if (header.length !== 24 || ![137, 80, 78, 71, 13, 10, 26, 10].every((byte, i) => header[i] === byte)
          || String.fromCharCode(...header.slice(12, 16)) !== 'IHDR') throw Error();
      const view = new DataView(header.buffer), width = view.getUint32(16), height = view.getUint32(20);
      if (!width || !height || width * height > CLIPBOARD_IMAGE_PIXELS) throw Error();
      if (!live) return;
      url = URL.createObjectURL(blob);
      const decoded = new Image(); decoded.src = url;
      await decoded.decode();
      if (decoded.naturalWidth !== width || decoded.naturalHeight !== height) throw Error();
      if (live) setImage({ url, width, height });
    };
    decode().catch(() => { if (url) URL.revokeObjectURL(url); if (live) setImage({ error: true }); });
    return () => { live = false; if (url) URL.revokeObjectURL(url); };
  }, [blob]);
  if (!image) return <p role="status" className="text-ink-3">Loading preview…</p>;
  if (image.error) return <p className="text-ink-3">Preview Unavailable</p>;
  return <>
    <span className="flex justify-center rounded-lg bg-canvas p-2 ring-1 ring-line"><img src={image.url} alt="Desktop Clipboard Image" className="max-h-64 max-w-full object-contain" /></span>
    <p className="mt-2 font-mono text-xs text-ink-3">{image.width} × {image.height}</p>
  </>;
}

export function ClipboardControl({ viewer }) {
  const state = useStore(viewer.store, s => s.clipboardState);
  const permissions = useStore(viewer.store, s => s.permissions);
  const status = useStore(viewer.store, s => s.status);
  const allowed = status === 'connected' && permissions.includes('clipboard.write');
  const readable = permissions.includes('clipboard.read');
  const [open, setOpen] = useState(false), [position, setPosition] = useState({});
  const [draft, setDraft] = useState(null), [pending, setPending] = useState(false), [error, setError] = useState('');
  const button = useRef(null), panel = useRef(null);
  const close = () => { setOpen(false); button.current?.focus(); };
  useEffect(() => {
    if (!open) return;
    const place = () => {
      const rect = button.current.getBoundingClientRect(), width = Math.min(400, innerWidth - 16);
      const bottom = Math.min(Math.max(8, innerHeight - rect.top + 8), Math.max(8, innerHeight - 88));
      setPosition({ width, left: Math.max(8, Math.min(rect.right - width, innerWidth - width - 8)), bottom, maxHeight: Math.max(0, innerHeight - bottom - 8) });
    };
    viewer.releaseInput();
    if (document.pointerLockElement) document.exitPointerLock();
    viewer.clipboard.open();
    panel.current?.focus(); place();
    window.addEventListener('resize', place);
    return () => { viewer.clipboard.close(); window.removeEventListener('resize', place); };
  }, [open, viewer]);
  const conflict = draft && state.observation !== null && draft.observation !== state.observation;
  const text = state.text ?? '';
  const editable = !readable || state.preview === 'empty' || state.mime?.startsWith('text/plain') || ['TEXT', 'STRING', 'UTF8_STRING'].includes(state.mime);
  const edit = () => { setDraft({ text, observation: state.observation }); setError(''); };
  const write = async value => {
    setPending(true); setError('');
    try { await viewer.clipboard.write(value); setDraft(null); }
    catch (error) { setError(error.name === 'AbortError' || error.name === 'TimeoutError' ? 'Clipboard change was interrupted or timed out.' : error.message); }
    finally { setPending(false); }
  };
  const loading = readable && (state.status === 'loading' || state.status === 'ready' && state.preview === 'loading');
  const label = !readable ? 'Write Desktop Clipboard' : loading ? 'Desktop Clipboard: Loading'
    : state.status === 'unavailable' ? 'Desktop Clipboard: Unavailable'
    : state.present ? 'Desktop Clipboard: Has Contents' : 'Desktop Clipboard: Empty';
  const Icon = loading ? LoaderCircle : state.status === 'unavailable' ? ClipboardX : state.present ? ClipboardCheck : Clipboard;
  if (!readable && !allowed) return null;
  return <>
    <button ref={button} id="clipboard-toggle" type="button" title={label} aria-label={label} aria-expanded={open} aria-controls="desktop-clipboard"
      onClick={() => setOpen(!open)} className={cx('inline-flex size-6 shrink-0 items-center justify-center rounded-md transition-colors hover:bg-surface-3 focus-visible:outline-2 focus-visible:outline-accent', open ? 'bg-accent/15 text-accent-2' : state.present ? 'text-accent-2' : 'text-ink-3 hover:text-ink')}>
      <Icon className={cx('size-3.5', loading && 'animate-spin')} />
    </button>
    {open && createPortal(<Popover floating ref={panel} id="desktop-clipboard" role="dialog" aria-label="Desktop Clipboard" onClose={close}
      onKeyDown={event => {
        event.stopPropagation();
        if (event.key !== 'Tab') return;
        const fields = [...panel.current.querySelectorAll('button:not(:disabled), textarea:not(:disabled), [tabindex="0"]')];
        if (!fields.length) return;
        event.preventDefault();
        const index = fields.indexOf(document.activeElement);
        fields[index < 0 ? event.shiftKey ? fields.length - 1 : 0 : (index + (event.shiftKey ? fields.length - 1 : 1)) % fields.length].focus();
      }}
      onPaste={event => event.stopPropagation()} onCopy={event => event.stopPropagation()} onCut={event => event.stopPropagation()}
      style={position} className="font-sans text-sm text-ink-2 select-text">
      <div className="flex shrink-0 items-center gap-2 border-b border-line px-3 py-2">
        <Clipboard className="size-3.5 text-ink-3" />
        <h2 className="font-medium text-ink">Desktop Clipboard</h2>
        {state.present && <span className="ml-1 truncate font-mono text-[10px] text-ink-4">{state.mime || 'Unknown Format'}{state.size != null ? ` · ${sizeLabel(state.size)}` : ''}</span>}
        <IconButton icon={X} label="Close Clipboard" size="sm" className="ml-auto" onClick={close} />
      </div>
      <div className="flex min-h-0 flex-col gap-3 overflow-auto p-3">
        {draft ? <>
          {conflict && <div className="callout callout-warn"><p className="font-medium">Clipboard Changed</p><p className="mt-0.5 text-warn/80">Your draft is preserved.</p>
            <button type="button" className="btn btn-outline btn-xs mt-2" disabled={pending || state.text === null || !editable} onClick={edit}>Load Current Contents</button>
          </div>}
          <textarea aria-label="Clipboard Text" autoFocus value={draft.text} onChange={event => setDraft({ ...draft, text: event.target.value })} disabled={pending}
            spellCheck={false} className="input min-h-40 resize-y py-2 font-mono whitespace-pre-wrap" />
          <div className="flex justify-end gap-1.5">
            <button type="button" className="btn btn-outline btn-xs" disabled={pending} onClick={() => { setDraft(null); setError(''); }}>Cancel</button>
            <button type="button" className="btn btn-primary btn-xs" disabled={!allowed || pending} onClick={() => write(draft.text)}>{conflict ? 'Replace with Draft' : 'Save'}</button>
          </div>
        </> : <>
          {!readable ? <p className="text-ink-3">Write-Only Access</p> : loading ? <p role="status" className="text-ink-3">Loading clipboard…</p>
            : state.status === 'unavailable' ? <p className="text-ink-3">Clipboard Unavailable</p>
            : !state.present ? <p className="py-4 text-center text-ink-4">Clipboard Empty</p>
            : state.preview !== 'available' ? <p className="text-ink-3">Preview Unavailable</p>
            : state.mime === 'image/png' && state.blob ? <ImagePreview blob={state.blob} />
            : state.files.length ? <ul className="flex flex-col gap-1">{state.files.map((name, index) => <li key={index} className="flex items-center gap-2 rounded-md bg-surface-2 px-2 py-1.5">
              <FileText className="size-3.5 shrink-0 text-ink-4" /><span className="min-w-0 flex-1 break-all">{name}</span>{readable && permissions.includes('files.download') && <IconButton icon={Download} label={`Download ${name}`} size="xs" blurOnClick={false} onClick={() => downloadClipboardFile(index, name).catch(error => setError(error.message))} />}
            </li>)}</ul>
            : state.text !== null ? <pre tabIndex={0} className="max-h-64 overflow-auto rounded-lg border border-line bg-canvas p-2.5 font-mono text-xs break-words whitespace-pre-wrap text-ink focus-visible:outline-2 focus-visible:outline-accent">{state.text}</pre>
            : <p role="status" className="text-ink-3">Loading preview…</p>}
          {allowed && <div className="flex justify-end gap-1.5">
            {editable && <button type="button" className="btn btn-outline btn-xs" disabled={pending || (readable && state.text === null)} onClick={edit}>{readable ? 'Edit' : 'New Text'}</button>}
            <button type="button" className="btn btn-outline btn-xs" disabled={pending || (readable && state.status !== 'ready')} onClick={() => write('')}>Clear</button>
          </div>}
        </>}
        {pending && <p role="status" className="flex items-center gap-2 text-ink-3"><LoaderCircle className="size-3 animate-spin" /> Saving…</p>}
        {(error || state.error) && <p role="alert" className="callout callout-bad">{error || state.error}</p>}
      </div>
    </Popover>, document.querySelector('[data-viewer]') ?? document.body)}
  </>;
}
