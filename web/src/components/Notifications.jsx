// Desktop notifications as a stack of toasts over the stage: the application's icon, summary and body,
// its action buttons, and a close button. Clicking the toast is the notification's default action.
import { useEffect, useState } from 'react';
import { Bell, X } from 'lucide-react';
import { useStore } from '../store.js';
import { notificationIcon } from '../api.js';
import { IconButton } from './ui.jsx';

// Notification bodies may carry a little markup (<b>, <a>); only their text is shown.
const plain = html => new DOMParser().parseFromString(html, 'text/html').body.textContent ?? '';

export function Notifications({ viewer }) {
  const list = useStore(viewer.store, s => s.notifications);
  if (!list.length) return null;
  return (
    <div className="absolute top-3 right-3 flex w-80 max-w-[90%] flex-col gap-2">
      {list.map(n => <Toast key={n.id} n={n} viewer={viewer} />)}
    </div>
  );
}

function Toast({ n, viewer }) {
  const [icon, setIcon] = useState(null);
  useEffect(() => {
    // fetched again when the application replaces the notification (rev); the old picture is released
    let live = true, url = null;
    setIcon(null);
    if (n.icon) notificationIcon(n.id).then(u => { if (live) { url = u; setIcon(u); } else if (u) URL.revokeObjectURL(u); });
    return () => { live = false; if (url) URL.revokeObjectURL(url); };
  }, [n.id, n.rev, n.icon]);
  const act = (e, action) => { e.stopPropagation(); viewer.notify(n.id, action); };
  const buttons = n.actions.filter(([key]) => key !== 'default');
  return (
    <div onClick={e => act(e, 'default')} className="animate-rise cursor-pointer rounded-xl border border-line-2 bg-surface/95 p-3 text-sm text-ink-2 shadow-pop backdrop-blur">
      <div className="flex items-start gap-3">
        <span className="flex size-9 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-surface-3">
          {icon ? <img src={icon} alt="" className="size-7 object-contain" /> : <Bell className="size-4 text-ink-3" />}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2">
            <span className="truncate font-medium text-ink">{n.summary}</span>
            {n.app && <span className="ml-auto shrink-0 text-[11px] text-ink-4">{n.app}</span>}
          </div>
          {n.body && <div className="mt-0.5 line-clamp-4 text-xs leading-relaxed whitespace-pre-line text-ink-2">{plain(n.body)}</div>}
          {buttons.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {buttons.map(([key, label]) => (
                <button key={key} type="button" onClick={e => act(e, key)} className="btn btn-outline btn-xs">{label}</button>
              ))}
            </div>
          )}
        </div>
        <IconButton icon={X} label="Dismiss" size="xs" blurOnClick={false} onClick={e => act(e, undefined)} className="-mt-1 -mr-1" />
      </div>
    </div>
  );
}
