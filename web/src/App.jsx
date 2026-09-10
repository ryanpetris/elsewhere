// The viewer: chrome around the stage. State comes from the engine (viewer.js) through its store.
import { useEffect, useState } from 'react';
import { Loader2, Terminal as TerminalIcon, X } from 'lucide-react';
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
import { IconButton } from './components/ui.jsx';
import '@xterm/xterm/css/xterm.css';

// A remembered on/off switch.
function usePref(key, fallback) {
  const [on, set] = useState(() => pref.get(key, fallback));
  return [on, v => { set(v); pref.set(key, v); }];
}

export function App({ viewer }) {
  const status = useStore(viewer.store, s => s.status);
  const controlsHidden = useStore(viewer.store, s => s.controlsHidden);
  const role = useStore(viewer.store, s => s.role);
  const permissions = useStore(viewer.store, s => s.permissions);
  const [sidebar, setSidebar] = usePref('sidebar', matchMedia('(min-width: 48rem)').matches); // a phone starts with the stage alone
  const [audioPanel, setAudioPanel] = useState(false);
  const [mixerPanel, setMixerPanel] = useState(false);
  const [keyboard, setKeyboard] = useState(false);
  const [Keyboard, setKeyboardComponent] = useState(null);
  const [keyboardError, setKeyboardError] = useState(null);
  const toggleKeyboard = () => {
    setKeyboard(!keyboard);
    if (!keyboard && !Keyboard) {
      setKeyboardError(null);
      import('./components/Keyboard.jsx').then(module => setKeyboardComponent(() => module.Keyboard))
        .catch(() => setKeyboardError('Keyboard could not load. Reload the page to retry.'));
    }
  };
  const [terminal, setTerminal] = useState(false);
  const [TerminalPanel, setTerminalPanel] = useState(null);
  const [terminalError, setTerminalError] = useState(null);
  const toggleTerminal = () => {
    viewer.setControlsHidden(false);
    if (terminal && !hidden) { setTerminal(false); return; }
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
  useEffect(() => { if (filesOpen) { viewer.setControlsHidden(false); setSidebar(true); setTab('files'); } }, [filesOpen]);
  const [menu, setMenu] = useState(null); // One top-bar menu at a time.
  const closeMenu = event => {
    setMenu(null);
    if (event?.type === 'keydown' || event?.detail === 0) document.getElementById(`${menu}-toggle`)?.focus();
  };
  const [fullscreen, setFullscreen] = useState(false); // the chrome is gone then, so nothing is collected for it
  const windowMode = !!WINDOW;
  const hidden = controlsHidden || fullscreen;
  useEffect(() => { if (hidden) setMenu(null); }, [hidden]);
  useEffect(() => {
    const on = () => { const full = viewer.isFullscreen(); setFullscreen(full); if (full) setMenu(null); };
    document.addEventListener('fullscreenchange', on);
    return () => document.removeEventListener('fullscreenchange', on);
  }, [viewer]);
  useEffect(() => viewer.setElementsOn(elements && !windowMode && !PIP), [viewer, elements, windowMode]);
  const canType = status === 'connected' && permissions.includes('desktop.control') && (windowMode || role === 'controller');
  useEffect(() => { if (!canType) setKeyboard(false); }, [canType]);
  useEffect(() => viewer.setStatsOn(!PIP && sidebar && tab === 'stats' && !hidden), [viewer, sidebar, tab, hidden]);

  return (
    <div data-viewer="" className="relative flex h-full w-full flex-col overflow-hidden bg-canvas font-sans text-ink-2 select-none">
      <div hidden={hidden}><TopBar
        viewer={viewer}
        windowMode={windowMode}
        sidebar={sidebar} onSidebar={() => setSidebar(!sidebar)}
        onFullscreen={viewer.fullscreen}
        onHideControls={() => viewer.setControlsHidden(true)}
        menu={menu} onMenu={m => setMenu(menu === m ? null : m)}
        keyboard={keyboard} onKeyboard={toggleKeyboard} canType={canType}
      /></div>
      {menu === 'about' && !fullscreen && <About viewer={viewer} onClose={closeMenu} />}
      {menu === 'apps' && <Launcher viewer={viewer} onClose={closeMenu} />}
      {menu === 'power' && <PowerMenu viewer={viewer} onClose={closeMenu} />}
      {menu === 'settings' && !windowMode && !fullscreen && <Settings viewer={viewer} borders={borders} onBorders={setBorders} elements={elements} onElements={setElements} onClose={closeMenu} />}
      <div className="relative flex min-h-0 flex-1">
        <Stage viewer={viewer} windowMode={windowMode} borders={borders && !windowMode && !PIP} elements={elements && !windowMode && !PIP}>
          {keyboard && canType && !hidden && <div className="absolute inset-x-0 bottom-0 z-20 max-h-full overflow-y-auto">
            {Keyboard ? <Keyboard viewer={viewer} onClose={() => setKeyboard(false)} /> : <div role="status" className="border-t border-line bg-surface p-3 text-xs">{keyboardError || 'Opening keyboard…'}</div>}
          </div>}
        </Stage>
        {/* stays mounted while hidden, so the thumbnails don't reload on every toggle */}
        {!windowMode && !PIP && <Sidebar viewer={viewer} tab={tab} onTab={setTab} hidden={!sidebar || hidden} />}
      </div>
      {/* the docks open under the stage and the side panel, full width, where a phone's drawer never covers them */}
      <div hidden={hidden}>
      {terminal && permissions.includes('commands.execute') && !PIP && (TerminalPanel
        ? <TerminalPanel hidden={hidden} viewer={viewer} onClose={closeTerminal} />
        : (
          <div className="flex h-10 shrink-0 items-center gap-3 border-t border-line bg-surface px-3 text-xs">
            <TerminalIcon className="size-3.5 text-ink-3" />
            <span className="font-medium text-ink">Terminal</span>
            <span role="status" className="flex items-center gap-2 text-ink-3">{terminalError ? <span className="text-warn">{terminalError}</span> : <><Loader2 className="size-3 animate-spin" /> Opening terminal…</>}</span>
            <IconButton icon={X} label="Close Terminal" size="sm" className="ml-auto" onClick={closeTerminal} />
          </div>
        ))}
      </div>
      {audioPanel && !windowMode && <AudioPanel viewer={viewer} hidden={hidden} onClose={() => setAudioPanel(false)} onPopOut={() => { if (viewer.panels.open('audio')) setAudioPanel(false); }} />}
      {mixerPanel && !windowMode && <MixerPanel viewer={viewer} hidden={hidden} onPopOut={() => { if (viewer.panels.open('mixer')) setMixerPanel(false); }} onClose={() => { setMixerPanel(false); document.getElementById('session-mixer-toggle')?.focus(); }} />}
      {!PIP && <StatusBar canType={canType} terminal={terminal} onTerminal={!windowMode ? toggleTerminal : undefined} controlsHidden={hidden} onShowControls={() => viewer.setControlsHidden(false)} mixerPanel={mixerPanel} onMixer={!windowMode ? () => { if (viewer.panels.focus('mixer')) return; viewer.setControlsHidden(false); setMixerPanel(hidden || !mixerPanel); } : undefined} viewer={viewer} audioPanel={audioPanel} onAudioPanel={!windowMode ? () => { if (viewer.panels.focus('audio')) return; viewer.setControlsHidden(false); setAudioPanel(hidden || !audioPanel); } : undefined} />}
      {(status === 'no-token' || status === 'unauthorized') && <TokenForm viewer={viewer} />}
    </div>
  );
}
