import { useEffect, useRef } from 'react';
import { ExternalLink, GitBranch, ScrollText, X } from 'lucide-react';
import { Popover } from './Launcher.jsx';
import { IconButton, Logo } from './ui.jsx';

export function About({ viewer, onClose }) {
  const close = useRef(null);
  useEffect(() => {
    viewer.releaseInput();
    if (document.pointerLockElement) document.exitPointerLock();
    close.current?.focus();
  }, [viewer]);
  const keyDown = event => {
    event.stopPropagation();
    if (event.key === 'Tab') {
      const controls = [...event.currentTarget.querySelectorAll('a, button')];
      const index = controls.indexOf(document.activeElement);
      event.preventDefault();
      controls[index < 0 ? (event.shiftKey ? controls.length - 1 : 0) : (index + (event.shiftKey ? controls.length - 1 : 1)) % controls.length].focus();
    }
  };
  const link = 'flex items-center gap-3 rounded-md px-2 py-2 text-sm text-ink-2 transition-colors hover:bg-surface-2 hover:text-ink focus-visible:outline-2 focus-visible:outline-accent';
  return (
    <Popover id="viewer-about" role="dialog" aria-label="About Elsewhere" onClose={onClose} onKeyDown={keyDown} onPaste={event => event.stopPropagation()}
      className="right-2 max-h-[calc(100dvh-4rem)] w-[22rem] max-w-[calc(100vw-1rem)] overflow-y-auto text-sm select-text sm:right-3">
      <div className="flex items-start gap-3 border-b border-line p-4">
        <Logo className="size-10" />
        <div className="min-w-0 flex-1">
          <h2 className="text-base leading-tight font-semibold text-ink">Elsewhere</h2>
          <p className="mt-0.5 text-xs text-ink-3">A Wayland desktop whose screen is a browser tab.</p>
        </div>
        <IconButton ref={close} icon={X} label="Close About" size="sm" onClick={onClose} />
      </div>
      <div className="flex flex-col gap-0.5 p-2">
        <a className={link} href="https://github.com/ryanpetris/elsewhere" target="_blank" rel="noreferrer">
          <GitBranch className="size-4 text-ink-3" /> GitHub repository <ExternalLink className="ml-auto size-3.5 text-ink-4" />
        </a>
        <a className={link} href="https://github.com/ryanpetris/elsewhere/blob/master/ACKNOWLEDGEMENTS.md" target="_blank" rel="noreferrer">
          <ScrollText className="size-4 text-ink-3" /> Acknowledgements <ExternalLink className="ml-auto size-3.5 text-ink-4" />
        </a>
      </div>
      <p className="border-t border-line px-4 py-2.5 text-xs text-ink-4">Copyright © 2026 Ryan Petris.</p>
    </Popover>
  );
}
