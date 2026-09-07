import { websocketUrl } from '../urls.js';
import { useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { X } from 'lucide-react';
import { TOKEN } from '../api.js';
import { AUTH } from '../protocol.js';

export default function TerminalPanel({ viewer, onClose }) {
  const host = useRef(null);
  const [status, setStatus] = useState('Connecting…');
  const [session, setSession] = useState(0);
  useEffect(() => {
    const term = new Terminal({ cursorBlink: true, fontSize: 14, scrollback: 3000, screenReaderMode: true,
      theme: { background: '#09090b', foreground: '#e4e4e7' } });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host.current);
    const socket = new WebSocket(websocketUrl('/ws/terminal'));
    socket.binaryType = 'arraybuffer';
    const send = data => { if (socket.readyState === WebSocket.OPEN) socket.send(data); };
    const control = data => send(JSON.stringify(data));
    const size = () => {
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
      term.focus();
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
    viewer.releaseInput();
    if (document.pointerLockElement) document.exitPointerLock();
    setStatus('Connecting…');
    return () => {
      observer.disconnect(); text.dispose(); binary.dispose();
      socket.onopen = socket.onmessage = socket.onclose = socket.onerror = null;
      socket.close(); term.dispose();
    };
  }, [viewer, session]);
  return (
    <section aria-label="Terminal" className="flex h-80 max-h-[70vh] min-h-40 shrink-0 flex-col border-t border-zinc-700 bg-zinc-950 px-3 pb-2"
      onKeyDown={event => event.stopPropagation()} onKeyUp={event => event.stopPropagation()} onFocusCapture={viewer.releaseInput}>
      <header className="flex h-9 shrink-0 items-center gap-3 text-xs">
        <span className="font-medium text-zinc-100">Terminal</span>
        <span role="status" className="text-zinc-500">{status}</span>
        <span className="ml-auto text-zinc-500">Closing ends this shell</span>
        {status !== 'Connected' && status !== 'Connecting…' && <button type="button" className="rounded px-2 py-1 hover:bg-zinc-800" onClick={() => setSession(value => value + 1)}>New shell</button>}
        <button type="button" aria-label="Close terminal" className="rounded p-1 hover:bg-zinc-800" onClick={onClose}><X className="size-4" /></button>
      </header>
      <div ref={host} className="min-h-0 flex-1 select-text" />
    </section>
  );
}
