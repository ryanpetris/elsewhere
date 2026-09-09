import { storageKey } from '../urls.js';
// No usable token: ask for a token retrieved on the server. The page reloads with it in sessionStorage.
import { useState } from 'react';
import { KeyRound, ShieldAlert } from 'lucide-react';
import { useStore } from '../store.js';
import { Logo } from './ui.jsx';

export function TokenForm({ viewer }) {
  const reason = useStore(viewer.store, s => s.reason);
  const status = useStore(viewer.store, s => s.status);
  const [token, setToken] = useState('');
  const submit = e => {
    e.preventDefault();
    const t = token.trim();
    if (!t) return;
    try { sessionStorage.setItem(storageKey('token'), t); } catch {}
    location.reload();
  };
  return (
    <div className="fixed inset-0 z-20 flex items-center justify-center bg-canvas/85 p-4 backdrop-blur-md">
      <form onSubmit={submit} className="w-[27rem] max-w-full animate-pop rounded-2xl border border-line-2 bg-surface p-6 shadow-pop sm:p-7">
        <div className="flex items-center gap-3">
          <Logo className="size-10" />
          <div>
            <h2 className="text-base leading-tight font-semibold text-ink">Connect to the desktop</h2>
            <p className="mt-0.5 text-xs text-ink-3">Elsewhere · remote desktop</p>
          </div>
        </div>
        {status === 'unauthorized' && (
          <div className="callout callout-bad mt-5 flex items-start gap-2" role="alert">
            <ShieldAlert className="mt-px size-3.5 shrink-0" /> <span>{reason}.</span>
          </div>
        )}
        <p className="mt-5 text-sm leading-relaxed text-ink-2">
          Paste a token from the server. Create an admin token in the server’s execution environment with
        </p>
        <pre className="mt-2 overflow-x-auto rounded-md border border-line bg-canvas px-3 py-2 font-mono text-xs text-ink-2 select-text">elsewhere token create --admin</pre>
        <label className="mt-5 block">
          <span className="eyebrow mb-1.5 block">Token</span>
          <span className="relative block">
            <KeyRound className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-ink-4" />
            <input
              autoFocus
              value={token}
              onChange={e => setToken(e.target.value)}
              placeholder="token"
              spellCheck={false}
              autoComplete="off"
              className="input h-10 pl-9 font-mono"
            />
          </span>
        </label>
        <button type="submit" className="btn btn-primary mt-5 h-10 w-full" disabled={!token.trim()}>
          Connect
        </button>
      </form>
    </div>
  );
}
