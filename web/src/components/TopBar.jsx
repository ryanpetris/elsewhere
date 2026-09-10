// The top bar: brand and context, the launchers, the connection state, and the viewer's own controls.
import { PanelTopClose, PictureInPicture2, CornerUpLeft, Expand, Eye, Hand, Keyboard, LayoutGrid, MousePointer2, PanelRightClose, PanelRightOpen, Power, Settings } from 'lucide-react';
import { useStore } from '../store.js';
import { WINDOW, PIP } from '../api.js';
import { Badge, Divider, IconButton, Logo, codecName, cx } from './ui.jsx';

// status → [dot classes, text]
const STATUS = {
  'no-token': ['bg-ink-4', 'No Token'],
  connecting: ['bg-warn text-warn animate-glow', 'Connecting…'],
  connected: ['bg-ok', 'Connected'],
  retrying: ['bg-warn text-warn animate-glow', 'Reconnecting…'],
  unauthorized: ['bg-bad', 'Not Authorized'],
  error: ['bg-bad', 'Connection Failed'],
  gone: ['bg-ink-4', 'Window Closed'],
  closed: ['bg-ink-4', 'Viewer Closed'],
  quit: ['bg-ink-4', 'Shut Down'],
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
    <button type="button" aria-label="Take Control" onClick={e => { viewer.takeControl(); e.currentTarget.blur(); }} className="btn btn-primary btn-sm mr-1 max-sm:mr-0 max-sm:p-0">
      <MousePointer2 className="size-3.5" /> <span className="hidden sm:inline">Take Control</span>
    </button>
  );
  if (role === 'viewer') return <Badge className="mr-1" title="This token does not allow desktop control"><Eye className="size-3" /> <span className="hidden sm:inline">View Only</span></Badge>;
  if (!windowMode && role === 'controller') return <Badge tone="ok" dot className="mr-1 max-sm:hidden" title="Desktop Control">Controlling</Badge>;
  return null;
}

/// The popup's role, in the badges the main bar uses. Its own Take Control button stands beside this.
function PopupRole({ status, role, text }) {
  if (status !== 'connected') return <span className="shrink-0 text-ink-3">{text}</span>;
  if (role === 'viewer') return <Badge title="This token does not allow desktop control"><Eye className="size-3" /> View Only</Badge>;
  if (role === 'controller') return <Badge tone="ok" dot title="Desktop Control">Controlling</Badge>;
  return <Badge>Watching</Badge>;
}

/// The mouse is inside the desktop and Escape is the way out. It stays until capture ends, so it is
/// the bar's own warning rather than a notice that fades.
const Capture = () => (
  <Badge tone="warn" role="status" data-mouse-capture className="mr-1" title="Press Escape to release the mouse">
    <MousePointer2 className="size-3" /> <span className="max-sm:sr-only">Mouse Captured</span>
  </Badge>
);

export function TopBar({ viewer, windowMode, sidebar, onSidebar, onFullscreen, onHideControls, menu, onMenu, keyboard, onKeyboard }) {
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
      <span className="min-w-0 flex-1 truncate font-medium text-ink">{windowMode ? windowTitle || `Window ${WINDOW}` : 'Remote Desktop'}</span>
      <PopupRole status={status} role={role} text={text} />
      {locked && <MousePointer2 data-mouse-capture className="size-3.5 shrink-0 text-warn" role="img" aria-label="Mouse Captured" />}
      {!windowMode && role === 'participant' && <button type="button" className="btn btn-primary btn-xs" onClick={() => viewer.takeControl()}>Take Control</button>}
      {!windowMode && role === 'controller' && <IconButton icon={Keyboard} label="On-Screen Keyboard" size="sm" active={keyboard} onClick={onKeyboard} />}
      <IconButton icon={CornerUpLeft} label="Return to Viewer" size="sm" onClick={() => window.parent.elsewhereReturn?.()} />
    </header>
  );
  return (
    <header onClick={event => { if (!event.target.closest('[data-menu-trigger]')) onMenu(null); }} className="flex h-12 shrink-0 items-center border-b border-line bg-surface px-1 max-sm:[&_button]:size-7 max-sm:[&_button]:px-0 sm:gap-2 sm:px-3">
      <div className="flex min-w-0 shrink items-center gap-2.5 pr-1">
        <button type="button" data-menu-trigger id="about-toggle" aria-label="About Elsewhere" title="About Elsewhere"
          aria-haspopup="dialog" aria-expanded={menu === 'about'} aria-controls="viewer-about" onClick={event => { onMenu('about'); event.currentTarget.blur(); }}
          className="inline-flex shrink-0 rounded-lg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent">
          <Logo />
        </button>
        <span className="hidden min-w-0 truncate text-sm font-semibold tracking-tight text-ink md:inline">{title}</span>
      </div>
      {acts('apps.launch') && <Divider className="hidden sm:block" />}
      {acts('apps.launch') && <BarButton data-menu-trigger id="apps-toggle" icon={LayoutGrid} label="Applications" active={menu === 'apps'} onClick={() => onMenu('apps')} />}
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
        {locked && <Capture />}
        <Role viewer={viewer} role={role} windowMode={windowMode} />
        {!windowMode && viewer.touch && role === 'controller' && <IconButton icon={Keyboard} label="On-Screen Keyboard" active={keyboard} onClick={onKeyboard} />}
        {!windowMode && viewer.touch && <IconButton icon={Hand} label="Touch as Mouse" active={touchMouse} onClick={() => viewer.setTouchMouse(!touchMouse)} />}
        {!windowMode && (
          <>
            <IconButton data-menu-trigger id="settings-toggle" icon={Settings} label="Settings" active={menu === 'settings'} aria-haspopup="dialog" aria-expanded={menu === 'settings'} aria-controls="viewer-settings" onClick={() => onMenu('settings')} />
            <IconButton icon={sidebar ? PanelRightClose : PanelRightOpen} label="Windows and Statistics" active={sidebar} onClick={onSidebar} />
            <Divider className="hidden sm:block" />
          </>
        )}
        {viewer.pip.supported && <IconButton icon={PictureInPicture2} label="Picture-in-Picture" onClick={() => viewer.pip.open()} />}
        <IconButton id="hide-controls" icon={PanelTopClose} label="Hide Controls (Ctrl+Alt+Shift+H)" onClick={onHideControls} />
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
