import { useEffect, useRef } from 'react';
import { X } from 'lucide-react';
import { Popover } from './SearchMenu.jsx';
import { IconButton } from './ui.jsx';

export function Help({ viewer, onClose }) {
  const close = useRef(null);
  useEffect(() => {
    viewer.releaseInput();
    if (document.pointerLockElement) document.exitPointerLock();
    close.current?.focus();
  }, [viewer]);
  return <Popover id="viewer-help" role="dialog" aria-label="Help" onClose={onClose}
    onKeyDown={event => { if (event.key === 'Tab') { event.preventDefault(); close.current?.focus(); } }}
    className="right-2 max-h-[calc(100dvh-4rem)] w-80 max-w-[calc(100vw-1rem)] overflow-y-auto">
    <div className="flex items-center justify-between border-b border-line px-3 py-2">
      <h2>Keyboard shortcuts</h2>
      <IconButton ref={close} icon={X} label="Close Help" onClick={onClose} />
    </div>
    <dl className="grid grid-cols-[1fr_auto] gap-x-3 gap-y-2 p-3 text-xs">
      <dt>Open Search</dt><dd><kbd className="kbd">Ctrl+Alt+Shift+S</kbd></dd>
      <dt>Show / hide controls</dt><dd><kbd className="kbd">Ctrl+Alt+Shift+H</kbd></dd>
      <dt>Release mouse capture</dt><dd><kbd className="kbd">Esc</kbd></dd>
      <dt>Release captured keyboard</dt><dd><kbd className="kbd">Hold Esc</kbd></dd>
      <dt>Close menu</dt><dd><kbd className="kbd">Esc</kbd></dd>
      <dt>Search: select result</dt><dd><kbd className="kbd">↑ / ↓</kbd></dd>
      <dt>Search: open result</dt><dd><kbd className="kbd">Enter</kbd></dd>
    </dl>
  </Popover>;
}
