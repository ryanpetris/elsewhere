import { useEffect, useLayoutEffect, useRef } from 'react';
import { Users, MousePointer2, X } from 'lucide-react';
import { useStore } from '../store.js';
import { Popover } from './Launcher.jsx';

export function Participants({ viewer, menu, onMenu }) {
  const roster = useStore(viewer.store, s => s.roster);
  const sessionId = useStore(viewer.store, s => s.sessionId);
  const takeControl = useStore(viewer.store, s => s.permissions.includes('desktop.take_control'));
  const status = useStore(viewer.store, s => s.status);
  const open = menu === 'participants';
  const trigger = useRef(null), panel = useRef(null);
  const own = roster?.sessions.find(s => s.id === String(sessionId));
  const controlling = roster?.controller === String(sessionId);
  const pending = roster?.sessions.filter(s => s.request).length ?? 0;
  useEffect(() => { if (status !== 'connected' && open) onMenu(null); }, [status]);
  useLayoutEffect(() => {
    if (open && panel.current && !panel.current.contains(document.activeElement)) panel.current.focus();
  }, [open, roster]);
  useEffect(() => {
    if (!open) return;
    viewer.releaseInput();
    if (document.pointerLockElement) document.exitPointerLock();
    panel.current?.focus();
  }, [open, viewer]);
  if (status !== 'connected' || !roster) return null;
  const close = () => { onMenu(null); trigger.current?.focus(); };
  const rect = trigger.current?.getBoundingClientRect();
  return <>
    <span role="status" className="sr-only">{controlling && pending ? `${pending} pending control request${pending === 1 ? '' : 's'}` : ''}</span>
    {own?.can_control && !controlling && <button type="button" aria-label={takeControl ? 'Take Control' : own.request ? 'Cancel Request' : roster.controller ? 'Request Control' : 'Claim Control'} className="btn btn-primary btn-xs mr-1"
      onClick={event => { takeControl ? viewer.claimControl() : own.request ? viewer.cancelControl(own.request) : roster.controller ? viewer.requestControl() : viewer.claimControl(); event.currentTarget.blur(); }}>
      {own.request && !takeControl ? <X className="size-3.5" /> : <MousePointer2 className="size-3.5" />}
      <span className="hidden sm:inline">{takeControl ? 'Take Control' : own.request ? 'Cancel Request' : roster.controller ? 'Request Control' : 'Claim Control'}</span>
    </button>}
    <button ref={trigger} type="button" id="participants-toggle" data-menu-trigger aria-label={`Participants${pending ? `, ${pending} pending request${pending === 1 ? '' : 's'}` : ''}`}
      aria-haspopup="dialog" aria-expanded={open} onClick={() => onMenu('participants')} className="btn btn-outline btn-xs mr-1">
      <Users className="size-3.5" /> <span className="hidden sm:inline">{roster.sessions.length}{pending ? ` · ${pending} pending` : ''}</span>
    </button>
    {open && <Popover ref={panel} onClick={event => event.stopPropagation()} onClose={close} floating role="dialog" aria-modal="true" aria-label="Participants"
      style={{ top: (rect?.bottom ?? 36) + 4, right: 8 }} className="max-h-[70vh] w-80 max-w-[calc(100vw-1rem)] p-3"
      onKeyDown={event => {
        if (event.key !== 'Tab') return;
        event.preventDefault();
        const buttons = [...event.currentTarget.querySelectorAll('button')];
        if (!buttons.length) return;
        const i = buttons.indexOf(document.activeElement);
        buttons[i < 0 ? (event.shiftKey ? buttons.length - 1 : 0) : (i + (event.shiftKey ? buttons.length - 1 : 1)) % buttons.length]?.focus();
      }}>
      <h2 className="mb-2 text-sm font-semibold">Participants</h2>
      <ul className="min-h-0 overflow-y-auto">
        {roster.sessions.map(member => <li key={member.id} className="border-t border-line py-2 text-xs">
          <span className="font-medium">{member.label}{member.id === String(sessionId) ? ' · You' : ''}</span>
          <span className="ml-2 text-ink-3">{member.id === roster.controller ? 'Controlling' : member.can_control ? 'Can control' : 'View only'}</span>
          {member.request && <div className="mt-2 flex items-center gap-2">
            <span role="status">Control requested</span>
            {controlling && <>
              <button type="button" className="btn btn-primary btn-xs" aria-label={`Approve ${member.label}`} onClick={() => { viewer.decideControl(member.id, member.request, true); close(); }}>Approve</button>
              <button type="button" className="btn btn-outline btn-xs" aria-label={`Decline ${member.label}`} onClick={() => { viewer.decideControl(member.id, member.request, false); close(); }}>Decline</button>
            </>}
          </div>}
        </li>)}
      </ul>
      <button type="button" onClick={close} className="btn btn-outline btn-xs mt-2 self-end">Close</button>
    </Popover>}
  </>;
}
