// Small shared pieces: buttons, badges, and the colour of a window.

/// Class names, skipping the falsy ones.
export const cx = (...parts) => parts.filter(Boolean).join(' ');

/// An icon button; `active` marks a toggle that is on. Focus leaves it after a click so keys go to the desktop.
export function IconButton({ icon: Icon, label, active = false, onClick, className = '', size = 'md', tone = 'neutral', ...props }) {
  return (
    <button
      {...props}
      type="button"
      title={label}
      aria-label={label}
      aria-pressed={active}
      onClick={e => { onClick?.(e); e.currentTarget.blur(); }}
      className={cx(
        'inline-flex shrink-0 items-center justify-center rounded-md transition-colors focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent',
        size === 'sm' ? 'size-7' : size === 'xs' ? 'size-6' : 'size-8',
        active ? 'bg-accent/15 text-accent-2 ring-1 ring-accent/40 ring-inset' : 'text-ink-3 hover:bg-surface-3 hover:text-ink',
        tone === 'danger' && !active && 'hover:bg-bad/10 hover:text-bad',
        className,
      )}
    >
      <Icon className={size === 'md' ? 'size-4' : 'size-3.5'} strokeWidth={1.75} />
    </button>
  );
}

const TONES = {
  neutral: 'border-line-2 bg-surface-3 text-ink-2',
  accent: 'border-accent/30 bg-accent/10 text-accent-2',
  ok: 'border-ok/30 bg-ok/10 text-ok',
  warn: 'border-warn/30 bg-warn/10 text-warn',
  bad: 'border-bad/30 bg-bad/10 text-bad',
  info: 'border-info/30 bg-info/10 text-info',
};

/// A small status pill.
export function Badge({ tone = 'neutral', dot = false, pulse = false, className = '', children, ...props }) {
  return (
    <span {...props} className={cx('inline-flex shrink-0 items-center gap-1.5 rounded-full border px-2 py-px text-[10px] font-medium whitespace-nowrap', TONES[tone], className)}>
      {dot && <span className={cx('size-1.5 rounded-full bg-current', pulse && 'animate-glow')} />}
      {children}
    </span>
  );
}

/// A vertical hairline between toolbar groups.
export const Divider = ({ className = '' }) => <span aria-hidden="true" className={cx('mx-1 h-5 w-px shrink-0 bg-line-2', className)} />;

/// A section title inside a panel.
export const Eyebrow = ({ className = '', children }) => <h3 className={cx('eyebrow', className)}>{children}</h3>;

const CODEC = { avc1: 'H.264', hev1: 'HEVC', hvc1: 'HEVC', vp09: 'VP9', av01: 'AV1', h264: 'H.264', hevc: 'HEVC', vp9: 'VP9', av1: 'AV1', vp8: 'VP8' };
/// The family of a WebCodecs codec string.
export const codecName = c => CODEC[c?.split('.')[0]] ?? c;

// One hue per app id, so every window of an app gets the same colour (also used for the border overlay).
export function hue(s) {
  let h = 0;
  for (const c of s) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return h % 360;
}
export const windowColor = w => `hsl(${hue(w.app_id || w.title)} 70% 58%)`;

/// The brand mark: the monitor glyph on an accent tile.
export function Logo({ className = 'size-7' }) {
  return (
    <span className={cx('inline-flex shrink-0 items-center justify-center rounded-lg bg-linear-to-br from-accent to-[#a78bfa] text-white shadow-card', className)} aria-hidden="true">
      <svg viewBox="0 0 24 24" className="size-[62%]" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <rect x="3" y="4" width="18" height="13" rx="2" />
        <path d="M8 20h8M12 17v3M7 9.5l2.5 2.5L7 14.5M12 14.5h4" />
      </svg>
    </span>
  );
}
