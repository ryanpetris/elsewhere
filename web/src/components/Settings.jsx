import { useEffect, useRef } from 'react';
import { MousePointer2, ScanSearch, SquareDashed } from 'lucide-react';
import { useStore } from '../store.js';
import { Popover } from './Launcher.jsx';

function Toggle({ inputRef, icon: Icon, label, description, id, checked, onChange }) {
  return (
    <label className="flex min-h-11 cursor-pointer items-start gap-3 rounded-lg px-2 py-2 transition-colors hover:bg-surface-2">
      <span className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-md bg-surface-3 text-ink-3"><Icon className="size-3.5" strokeWidth={1.75} /></span>
      <span className="min-w-0 flex-1">
        <span className="block text-sm text-ink">{label}</span>
        <span id={id} className="mt-0.5 block text-xs leading-relaxed text-ink-3">{description}</span>
      </span>
      <input ref={inputRef} type="checkbox" aria-label={label} checked={checked} onChange={event => onChange(event.target.checked)} className="switch mt-1" aria-describedby={id} />
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
      const inputs = [...event.currentTarget.querySelectorAll('input')];
      const index = inputs.indexOf(document.activeElement);
      event.preventDefault();
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
      </div>
    </Popover>
  );
}
