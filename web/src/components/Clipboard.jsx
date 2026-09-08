import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Clipboard, ClipboardCheck, ClipboardX, Download, LoaderCircle, X } from 'lucide-react';
import { useStore } from '../store.js';
import { downloadClipboardFile } from '../api.js';
import { CLIPBOARD_IMAGE_BYTES, CLIPBOARD_IMAGE_PIXELS } from '../clipboard.js';
import { Popover } from './Launcher.jsx';

const buttonClass = 'rounded px-2 py-1 text-sm text-indigo-300 hover:bg-zinc-800 disabled:opacity-40';
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
  if (!image) return <p role="status">Loading preview…</p>;
  if (image.error) return <p>Preview unavailable</p>;
  return <><img src={image.url} alt="Desktop clipboard image" className="max-h-64 max-w-full self-center object-contain" /><p className="mt-2 text-xs text-zinc-500">{image.width} × {image.height}</p></>;
}

export function ClipboardControl({ viewer }) {
  const state = useStore(viewer.store, s => s.clipboardState);
  const role = useStore(viewer.store, s => s.role);
  const status = useStore(viewer.store, s => s.status);
  const allowed = status === 'connected' && ['controller', 'participant'].includes(role);
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
  const editable = state.preview === 'empty' || state.mime?.startsWith('text/plain') || ['TEXT', 'STRING', 'UTF8_STRING'].includes(state.mime);
  const edit = () => { setDraft({ text, observation: state.observation }); setError(''); };
  const write = async value => {
    setPending(true); setError('');
    try { await viewer.clipboard.write(value); setDraft(null); }
    catch (error) { setError(error.name === 'AbortError' || error.name === 'TimeoutError' ? 'Clipboard change was interrupted or timed out.' : error.message); }
    finally { setPending(false); }
  };
  const loading = state.status === 'loading' || state.status === 'ready' && state.preview === 'loading';
  const label = loading ? 'Desktop clipboard: loading'
    : state.status === 'unavailable' ? 'Desktop clipboard: unavailable'
    : state.present ? 'Desktop clipboard: has contents' : 'Desktop clipboard: empty';
  const Icon = loading ? LoaderCircle : state.status === 'unavailable' ? ClipboardX : state.present ? ClipboardCheck : Clipboard;
  return <>
    <button ref={button} id="clipboard-toggle" type="button" title={label} aria-label={label} aria-expanded={open} aria-controls="desktop-clipboard"
      onClick={() => setOpen(!open)} className={`flex w-6 shrink-0 items-center justify-center rounded py-1 hover:bg-zinc-800 ${state.present ? 'text-indigo-300' : 'text-zinc-400'}`}>
      <Icon className="size-3.5" />
    </button>
    {open && createPortal(<Popover floating ref={panel} id="desktop-clipboard" role="dialog" aria-label="Desktop clipboard" onClose={close}
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
      style={position} className="overflow-hidden font-sans text-sm text-zinc-300 select-text">
      <div className="flex shrink-0 items-center justify-between border-b border-zinc-800 px-3 py-2">
        <h2 className="font-medium">Desktop clipboard</h2>
        <button type="button" onClick={close} aria-label="Close clipboard" className={buttonClass}><X className="size-4" /></button>
      </div>
      <div className="flex min-h-0 flex-col gap-3 overflow-auto p-3">
        {draft ? <>
          {conflict && <div className="rounded bg-amber-950/50 p-2 text-amber-200"><p>Clipboard changed</p><p className="mt-1 text-xs">Your draft is preserved.</p>
            <button type="button" className={buttonClass} disabled={pending || state.text === null || !editable} onClick={edit}>Load current contents</button>
          </div>}
          <textarea aria-label="Clipboard text" autoFocus value={draft.text} onChange={event => setDraft({ ...draft, text: event.target.value })} disabled={pending}
            spellCheck={false} className="min-h-40 w-full resize-y rounded border border-zinc-700 bg-zinc-950 p-2 font-mono text-sm whitespace-pre-wrap outline-none focus:border-indigo-400" />
          <div className="flex justify-end gap-2">
            <button type="button" className={buttonClass} disabled={pending} onClick={() => { setDraft(null); setError(''); }}>Cancel</button>
            <button type="button" className={buttonClass} disabled={!allowed || pending} onClick={() => write(draft.text)}>{conflict ? 'Replace with draft' : 'Save'}</button>
          </div>
        </> : <>
          {loading ? <p role="status">Loading clipboard…</p>
            : state.status === 'unavailable' ? <p>Clipboard unavailable</p>
            : !state.present ? <p>Clipboard is empty</p>
            : state.preview !== 'available' ? <p>Preview unavailable</p>
            : state.mime === 'image/png' && state.blob ? <ImagePreview blob={state.blob} />
            : state.files.length ? <ul className="space-y-2">{state.files.map((name, index) => <li key={index} className="flex items-center justify-between gap-2">
              <span className="min-w-0 break-all">{name}</span>{allowed && <button type="button" className={buttonClass} aria-label={`Download ${name}`} onClick={() => downloadClipboardFile(index, name).catch(error => setError(error.message))}><Download className="size-4" /></button>}
            </li>)}</ul>
            : state.text !== null ? <pre tabIndex={0} className="max-h-64 overflow-auto font-mono text-sm whitespace-pre-wrap break-words">{state.text}</pre>
            : <p role="status">Loading preview…</p>}
          {state.present && <p className="text-xs text-zinc-500">{state.mime || 'Unknown format'}{state.size != null ? ` · ${sizeLabel(state.size)}` : ''}</p>}
          {allowed && <div className="flex justify-end gap-2">
            {editable && <button type="button" className={buttonClass} disabled={pending || state.text === null} onClick={edit}>Edit</button>}
            <button type="button" className={buttonClass} disabled={pending || state.status !== 'ready'} onClick={() => write('')}>Clear</button>
          </div>}
        </>}
        {pending && <p role="status">Waiting for the desktop clipboard…</p>}
        {(error || state.error) && <p role="alert" className="text-rose-300">{error || state.error}</p>}
      </div>
    </Popover>, document.body)}
  </>;
}
