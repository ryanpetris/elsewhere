// The viewer: chrome around the stage. State comes from the engine (viewer.js) through its store.
import { useEffect, useState } from 'react';
import { useStore } from './store.js';
import { WINDOW, PIP, pref } from './api.js';
import { TopBar } from './components/TopBar.jsx';
import { Stage } from './components/Stage.jsx';
import { Sidebar } from './components/Sidebar.jsx';
import { StatusBar } from './components/StatusBar.jsx';
import { TokenForm } from './components/TokenForm.jsx';
import { Launcher, PowerMenu } from './components/Launcher.jsx';
import { About } from './components/About.jsx';
import { Settings } from './components/Settings.jsx';
import { MixerPanel } from './components/MixerPanel.jsx';
import { AudioPanel } from './components/AudioPanel.jsx';
import { Keyboard, focusKeyboard } from './components/Keyboard.jsx';
import '@xterm/xterm/css/xterm.css';

// A remembered on/off switch.
function usePref(key, fallback) {
  const [on, set] = useState(() => pref.get(key, fallback));
  return [on, v => { set(v); pref.set(key, v); }];
}

export function App({ viewer }) {
  const status = useStore(viewer.store, s => s.status);
  const role = useStore(viewer.store, s => s.role);
  const permissions = useStore(viewer.store, s => s.permissions);
  const [sidebar, setSidebar] = usePref('sidebar', matchMedia('(min-width: 48rem)').matches); // a phone starts with the stage alone
  const [audioPanel, setAudioPanel] = useState(false);
  const [mixerPanel, setMixerPanel] = useState(false);
  const [keyboard, setKeyboard] = useState(false);
  const [terminal, setTerminal] = useState(false);
  const [TerminalPanel, setTerminalPanel] = useState(null);
  const [terminalError, setTerminalError] = useState(null);
  const toggleTerminal = () => {
    if (terminal) { setTerminal(false); return; }
    setTerminal(true); setTerminalError(null);
    if (!TerminalPanel) import('./components/TerminalPanel.jsx')
      .then(module => setTerminalPanel(() => module.default))
      .catch(() => setTerminalError('Terminal could not load. Reload the page to retry.'));
  };
  const closeTerminal = () => { setTerminal(false); document.getElementById('terminal-toggle')?.focus(); };
  const [borders, setBorders] = usePref('borders', false);
  const [elements, setElements] = usePref('elements', false);
  const [tab, setTab] = useState('windows');
  const filesOpen = useStore(viewer.store, s => s.filesOpen);
  useEffect(() => { if (filesOpen) { setSidebar(true); setTab('files'); } }, [filesOpen]);
  const [menu, setMenu] = useState(null); // One top-bar menu at a time.
  const closeMenu = event => {
    setMenu(null);
    if (event?.type === 'keydown' || event?.detail === 0) document.getElementById(`${menu}-toggle`)?.focus();
  };
  const [fullscreen, setFullscreen] = useState(false); // the chrome is gone then, so nothing is collected for it
  const windowMode = !!WINDOW;
  useEffect(() => {
    const on = () => { const full = viewer.isFullscreen(); setFullscreen(full); if (full) setMenu(null); };
    document.addEventListener('fullscreenchange', on);
    return () => document.removeEventListener('fullscreenchange', on);
  }, [viewer]);
  useEffect(() => viewer.setElementsOn(elements && !windowMode && !PIP), [viewer, elements, windowMode]);
  useEffect(() => { if (role !== 'controller') setKeyboard(false); }, [role]); // only the controller's typing counts
  useEffect(() => viewer.setStatsOn(!PIP && sidebar && tab === 'stats' && !fullscreen), [viewer, sidebar, tab, fullscreen]);

  return (
    <div className="relative flex h-full w-full flex-col overflow-hidden bg-zinc-950 text-zinc-300 select-none">
      <TopBar
        viewer={viewer}
        windowMode={windowMode}
        sidebar={sidebar} onSidebar={() => setSidebar(!sidebar)}
        onFullscreen={viewer.fullscreen}
        menu={menu} onMenu={m => setMenu(menu === m ? null : m)}
        keyboard={keyboard} onKeyboard={() => (keyboard ? focusKeyboard() : setKeyboard(true))}
        terminal={terminal} onTerminal={toggleTerminal}
      />
      {menu === 'about' && !fullscreen && <About viewer={viewer} onClose={closeMenu} />}
      {menu === 'apps' && <Launcher viewer={viewer} onClose={closeMenu} />}
      {menu === 'power' && <PowerMenu viewer={viewer} onClose={closeMenu} />}
      {menu === 'settings' && !windowMode && !fullscreen && <Settings viewer={viewer} borders={borders} onBorders={setBorders} elements={elements} onElements={setElements} onClose={closeMenu} />}
      <div className="relative flex min-h-0 flex-1">
        <Stage viewer={viewer} windowMode={windowMode} borders={borders && !windowMode && !PIP} elements={elements && !windowMode && !PIP} />
        {/* stays mounted while hidden, so the thumbnails don't reload on every toggle */}
        {!windowMode && !PIP && <Sidebar viewer={viewer} tab={tab} onTab={setTab} hidden={!sidebar || fullscreen} />}
      </div>
      {keyboard && <Keyboard viewer={viewer} onClose={() => setKeyboard(false)} />}
      {terminal && permissions.includes('commands.execute') && !PIP && (TerminalPanel
        ? <TerminalPanel viewer={viewer} onClose={closeTerminal} />
        : <div className="flex items-center gap-3 p-3 text-sm"><span role="status">{terminalError || 'Opening terminal…'}</span><button type="button" onClick={closeTerminal}>Close terminal</button></div>)}
      {audioPanel && !windowMode && <AudioPanel viewer={viewer} hidden={fullscreen} onClose={() => setAudioPanel(false)} />}
      {mixerPanel && !windowMode && <MixerPanel viewer={viewer} hidden={fullscreen} onClose={() => { setMixerPanel(false); document.getElementById('session-mixer-toggle')?.focus(); }} />}
      {!PIP && <StatusBar mixerPanel={mixerPanel} onMixer={!windowMode ? () => setMixerPanel(!mixerPanel) : undefined} viewer={viewer} audioPanel={audioPanel} onAudioPanel={!windowMode ? () => setAudioPanel(!audioPanel) : undefined} />}
      {(status === 'no-token' || status === 'unauthorized') && <TokenForm viewer={viewer} />}
    </div>
  );
}
