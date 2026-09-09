// The top bar: brand and context, the launchers, the connection state, and the viewer's own controls.
import { PictureInPicture2, CornerUpLeft, Expand, Eye, Info, Hand, Keyboard, LayoutGrid, MousePointer2, PanelRightClose, PanelRightOpen, Power, Settings, Terminal } from 'lucide-react';
import { useStore } from '../store.js';
import { WINDOW, PIP } from '../api.js';
import { Badge, Divider, IconButton, Logo, codecName, cx } from './ui.jsx';

// status → [dot classes, text]
const STATUS = {
  'no-token': ['bg-ink-4', 'No token'],
  connecting: ['bg-warn text-warn animate-glow', 'Connecting…'],
  connected: ['bg-ok', 'Connected'],
  retrying: ['bg-warn text-warn animate-glow', 'Reconnecting…'],
  unauthorized: ['bg-bad', 'Not authorized'],
  gone: ['bg-ink-4', 'Window closed'],
  closed: ['bg-ink-4', 'Viewer closed'],
  quit: ['bg-ink-4', 'Shut down'],
};

/// A labelled bar button: the icon always, the text when there is room.
function BarButton({ icon: Icon, label, active = false, onClick, className = '', ...props }) {
  return (
    <button
      {...props}
      type="button"
      title={label}
      aria-label={label}
      aria-pressed={active}
      onClick={e => { onClick?.(e); e.currentTarget.blur(); }}
      className={cx(
        'inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md px-2 text-xs font-medium transition-colors focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent',
        active ? 'bg-accent/15 text-accent-2 ring-1 ring-accent/40 ring-inset' : 'text-ink-2 hover:bg-surface-3 hover:text-ink',
        className,
      )}
    >
      <Icon className="size-4" strokeWidth={1.75} />
      <span className="hidden lg:inline">{label}</span>
    </button>
  );
}

function Role({ viewer, role, windowMode }) {
  if (!windowMode && role === 'participant') return (
    <button type="button" aria-label="Take control" onClick={e => { viewer.takeControl(); e.currentTarget.blur(); }} title="Drive the desktop; it takes this window's size" className="btn btn-primary btn-sm mr-1 max-sm:mr-0 max-sm:p-0">
      <MousePointer2 className="size-3.5" /> <span className="hidden sm:inline">Take control</span>
    </button>
  );
  if (role === 'viewer') return <Badge className="mr-1" title="This token does not allow desktop control"><Eye className="size-3" /> <span className="hidden sm:inline">View only</span></Badge>;
  if (!windowMode && role === 'controller') return <Badge tone="ok" dot className="mr-1 max-sm:hidden" title="Your pointer, keyboard and window size are the desktop's">Controlling</Badge>;
  return null;
}

export function TopBar({ viewer, windowMode, sidebar, onSidebar, onFullscreen, menu, onMenu, keyboard, onKeyboard, terminal, onTerminal }) {
  const status = useStore(viewer.store, s => s.status);
  const stream = useStore(viewer.store, s => s.stream);
  const windowTitle = useStore(viewer.store, s => s.windowTitle);
  const role = useStore(viewer.store, s => s.role);
  const locked = useStore(viewer.store, s => s.locked);
  const touchMouse = useStore(viewer.store, s => s.touchMouse);
  const [dot, text] = STATUS[status];
  const permissions = useStore(viewer.store, s => s.permissions);
  const acts = permission => !windowMode && status === 'connected' && permissions.includes(permission);
  const title = windowMode ? windowTitle || `Window ${WINDOW}` : 'Elsewhere';
  if (PIP) return (
    <header className="flex h-9 shrink-0 items-center gap-2 border-b border-line bg-surface px-2 text-xs">
      <span className={`size-2 shrink-0 rounded-full ${dot}`} title={text} />
      <span className="min-w-0 flex-1 truncate font-medium text-ink">{windowMode ? windowTitle || `Window ${WINDOW}` : 'Remote desktop'}</span>
      <span className="shrink-0 text-ink-3">{status === 'connected' ? role === 'viewer' ? 'View only' : role === 'controller' ? 'Controlling' : 'Watching' : text}</span>
      {locked && <MousePointer2 className="size-3.5 shrink-0 text-accent-2" aria-label="Pointer captured" />}
      {!windowMode && role === 'participant' && <button type="button" className="btn btn-primary btn-xs" onClick={() => viewer.takeControl()}>Take control</button>}
      {!windowMode && role === 'controller' && <IconButton icon={Keyboard} label="On-screen keyboard" size="sm" active={keyboard} onClick={onKeyboard} />}
      <IconButton icon={CornerUpLeft} label="Return to main viewer" size="sm" onClick={() => window.parent.elsewhereReturn?.()} />
    </header>
  );
  return (
    <header onClick={event => { if (!event.target.closest('[data-menu-trigger]')) onMenu(null); }} className="flex h-12 shrink-0 items-center border-b border-line bg-surface px-1 max-sm:[&_button]:size-7 max-sm:[&_button]:px-0 sm:gap-2 sm:px-3">
      <div className="hidden min-w-0 shrink items-center gap-2.5 pr-1 sm:flex">
        <Logo />
        <span className="hidden min-w-0 truncate text-sm font-semibold tracking-tight text-ink md:inline">{title}</span>
      </div>
      {(acts('apps.launch') || acts('commands.execute')) && <Divider className="hidden sm:block" />}
      {acts('apps.launch') && <BarButton data-menu-trigger id="apps-toggle" icon={LayoutGrid} label="Applications" active={menu === 'apps'} onClick={() => onMenu('apps')} />}
      {acts('commands.execute') && <BarButton id="terminal-toggle" icon={Terminal} label="Terminal" active={terminal} onClick={onTerminal} />}
      <div className="flex min-w-0 shrink items-center rounded-full px-1 py-1 text-xs text-ink-2 sm:ml-1 sm:gap-2 sm:border sm:border-line sm:bg-surface-2 sm:pr-3 sm:pl-2.5" title={stream && status === 'connected' ? `${text} · ${codecName(stream.codec)} ${stream.width}×${stream.height}` : text}>
        <span className={`size-2 shrink-0 rounded-full ${dot}`} />
        <span className="hidden truncate sm:inline">{text}</span>
        {stream && status === 'connected' && (
          <span className="hidden truncate font-mono text-[11px] text-ink-3 md:inline">
            {codecName(stream.codec)} · {stream.width}×{stream.height}{stream.scale !== 1 ? ` @${stream.scale.toFixed(2)}` : ''}
          </span>
        )}
      </div>
      <div className="ml-auto flex shrink-0 items-center sm:gap-0.5">
        <Role viewer={viewer} role={role} windowMode={windowMode} />
        {!windowMode && viewer.touch && role === 'controller' && <IconButton icon={Keyboard} label="On-screen keyboard" active={keyboard} onClick={onKeyboard} />}
        {!windowMode && viewer.touch && <IconButton icon={Hand} label="Touch as mouse: tap, hold for the right button, two fingers scroll, pinch to zoom (off: applications get the touch points)" active={touchMouse} onClick={() => viewer.setTouchMouse(!touchMouse)} />}
        {!windowMode && (
          <>
            <IconButton data-menu-trigger id="settings-toggle" icon={Settings} label="Settings" active={menu === 'settings'} aria-haspopup="dialog" aria-expanded={menu === 'settings'} aria-controls="viewer-settings" onClick={() => onMenu('settings')} />
            <IconButton icon={sidebar ? PanelRightClose : PanelRightOpen} label="Windows and statistics" active={sidebar} onClick={onSidebar} />
            <Divider className="hidden sm:block" />
          </>
        )}
        <IconButton data-menu-trigger id="about-toggle" icon={Info} label="About" active={menu === 'about'} aria-haspopup="dialog" aria-expanded={menu === 'about'} aria-controls="viewer-about" onClick={() => onMenu('about')} />
        {viewer.pip.supported && <IconButton icon={PictureInPicture2} label="Picture-in-picture" onClick={() => viewer.pip.open()} />}
        <IconButton icon={Expand} label="Fullscreen" onClick={onFullscreen} />
        {acts('server.manage') && (
          <>
            <Divider className="hidden sm:block" />
            <IconButton data-menu-trigger id="power-toggle" icon={Power} label="Quit Elsewhere" active={menu === 'power'} tone="danger" onClick={() => onMenu('power')} />
          </>
        )}
      </div>
    </header>
  );
}
