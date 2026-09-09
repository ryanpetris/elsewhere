import { websocketUrl } from '../urls.js';
import { useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { RotateCw, Terminal as TerminalIcon, X } from 'lucide-react';
import { TOKEN } from '../api.js';
import { AUTH } from '../protocol.js';
import { IconButton, cx } from './ui.jsx';

export default function TerminalPanel({ viewer, onClose, hidden = false }) {
  const host = useRef(null);
  const hiddenRef = useRef(hidden);
  hiddenRef.current = hidden;
  const [status, setStatus] = useState('Connecting…');
  const [session, setSession] = useState(0);
  useEffect(() => {
    const term = new Terminal({ cursorBlink: true, fontSize: 14, scrollback: 3000, screenReaderMode: true,
      theme: { background: '#08090c', foreground: '#e8eaf0', cursor: '#a5b4fc', selectionBackground: 'rgba(99, 102, 241, 0.35)' } });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host.current);
    const socket = new WebSocket(websocketUrl('/ws/terminal'));
    socket.binaryType = 'arraybuffer';
    const send = data => { if (socket.readyState === WebSocket.OPEN) socket.send(data); };
    const control = data => send(JSON.stringify(data));
    const size = () => {
      if (hiddenRef.current) return;
      fit.fit();
      control({ cols: Math.min(1000, term.cols), rows: Math.min(1000, term.rows) });
    };
    const observer = new ResizeObserver(size);
    observer.observe(host.current);
    socket.onopen = () => {
      const token = new TextEncoder().encode(TOKEN);
      const auth = new Uint8Array(1 + token.length);
      auth[0] = AUTH; auth.set(token, 1);
      socket.send(auth);
      size();
      if (!hiddenRef.current) term.focus();
    };
    socket.onmessage = event => {
      if (typeof event.data === 'string') { setStatus(event.data); return; }
      setStatus('Connected');
      const data = new Uint8Array(event.data);
      term.write(data, () => control({ ack: data.byteLength }));
    };
    socket.onclose = () => { setStatus(value => ['Connected', 'Connecting…'].includes(value) ? 'Session ended' : value); term.options.disableStdin = true; };
    socket.onerror = () => setStatus('Connection failed');
    const input = data => {
      if (socket.bufferedAmount + data.byteLength > 256 * 1024) {
        socket.close();
        setStatus('Connection cannot keep up with terminal input');
        return;
      }
      for (let offset = 0; offset < data.length; offset += 16 * 1024) send(data.subarray(offset, offset + 16 * 1024));
    };
    const text = term.onData(data => input(new TextEncoder().encode(data)));
    const binary = term.onBinary(data => input(Uint8Array.from(data, character => character.charCodeAt(0) & 255)));
    if (!hiddenRef.current) {
      viewer.releaseInput();
      if (document.pointerLockElement) document.exitPointerLock();
    }
    setStatus('Connecting…');
    return () => {
      observer.disconnect(); text.dispose(); binary.dispose();
      socket.onopen = socket.onmessage = socket.onclose = socket.onerror = null;
      socket.close(); term.dispose();
    };
  }, [viewer, session]);
  const live = status === 'Connected' || status === 'Connecting…';
  return (
    <section aria-label="Terminal" className="flex h-[38vh] max-h-[70vh] min-h-40 shrink-0 flex-col border-t border-line bg-canvas"
      onKeyDown={event => event.stopPropagation()} onKeyUp={event => event.stopPropagation()} onFocusCapture={viewer.releaseInput}>
      <header className="flex h-9 shrink-0 items-center gap-3 border-b border-line bg-surface px-3 text-xs">
        <TerminalIcon className="size-3.5 text-ink-3" />
        <span className="font-medium text-ink">Terminal</span>
        <span role="status" className={cx('inline-flex items-center gap-1.5 rounded-full border px-2 py-px text-[10px] font-medium',
          status === 'Connected' ? 'border-ok/30 bg-ok/10 text-ok' : live ? 'border-line-2 bg-surface-3 text-ink-2' : 'border-warn/30 bg-warn/10 text-warn')}>
          <span className={cx('size-1.5 rounded-full', status === 'Connected' ? 'bg-ok' : live ? 'bg-ink-3 animate-glow' : 'bg-warn')} />{status}
        </span>
        <span className="ml-auto hidden text-ink-4 sm:inline">Closing ends this shell</span>
        {!live && <button type="button" className="btn btn-outline btn-xs" onClick={() => setSession(value => value + 1)}><RotateCw className="size-3" /> New shell</button>}
        <IconButton icon={X} label="Close terminal" size="sm" onClick={onClose} />
      </header>
      <div className="min-h-0 flex-1 px-3 pt-2 pb-1">
        <div ref={host} className="h-full select-text" />
      </div>
    </section>
  );
}
