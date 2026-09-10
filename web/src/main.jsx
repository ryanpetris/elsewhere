import { createRoot } from 'react-dom/client';
import './index.css';
import { createViewer } from './viewer.js';
import { App } from './App.jsx';
import { AudioPanel } from './components/AudioPanel.jsx';
import { MixerPanel } from './components/MixerPanel.jsx';

// The engine lives here, in the entry module: an edit under hot reload re-runs App.jsx, not this.
const root = createRoot(document.getElementById('root'));
const panel = new URLSearchParams(location.search).get('panel');
if (panel !== null) {
  let owner;
  try { owner = window.opener?.elsewhere?.panels.attach(window, panel); } catch {}
  if (owner) {
    document.title = `${owner.title} · Elsewhere`;
    const Panel = panel === 'audio' ? AudioPanel : MixerPanel;
    owner.ready(() => root.unmount());
    root.render(<Panel viewer={owner.viewer} poppedOut onClose={owner.close} />);
  } else {
    root.render(<p className="p-4 text-sm text-ink">Open this panel from the main Elsewhere viewer.</p>);
  }
} else {
  root.render(<App viewer={createViewer()} />);
}
