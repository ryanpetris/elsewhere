import { storageKey } from '../urls.js';
// No usable token: ask for a token retrieved on the server. The page reloads with it in sessionStorage.
import { useState } from 'react';
import { KeyRound } from 'lucide-react';
import { useStore } from '../store.js';

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
    <div className="fixed inset-0 z-20 flex items-center justify-center bg-zinc-950/80 backdrop-blur-sm">
      <form onSubmit={submit} className="w-[30rem] max-w-[calc(100vw-2rem)] rounded-xl border border-zinc-800 bg-zinc-900 p-6 shadow-2xl">
        <div className="flex items-center gap-2 text-zinc-100">
          <KeyRound className="size-5 text-indigo-400" />
          <h2 className="text-base font-semibold">Connect to the desktop</h2>
        </div>
        <p className="mt-2 text-sm text-zinc-400">
          {status === 'unauthorized' ? `${reason}. ` : ''}Paste a token from the server. Run <code>elsewhere token</code> there for control access, or <code>elsewhere token --viewer</code> for read-only access.
        </p>
        <input
          autoFocus
          value={token}
          onChange={e => setToken(e.target.value)}
          placeholder="token"
          spellCheck={false}
          autoComplete="off"
          className="mt-4 w-full rounded-md border border-zinc-700 bg-zinc-950 px-3 py-2 font-mono text-sm text-zinc-100 placeholder:text-zinc-600 focus:border-indigo-400 focus:outline-none"
        />
        <div className="mt-4 flex justify-end">
          <button type="submit" className="rounded-md bg-indigo-500 px-4 py-1.5 text-sm font-medium text-white hover:bg-indigo-400 disabled:opacity-50" disabled={!token.trim()}>
            Connect
          </button>
        </div>
      </form>
    </div>
  );
}
