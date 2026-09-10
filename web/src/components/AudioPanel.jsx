import { useEffect, useRef, useState } from 'react';
import { AudioLines, ChevronsDownUp, ChevronsUpDown, ExternalLink, Maximize, Minimize, X } from 'lucide-react';
import { pref } from '../api.js';
import { useStore } from '../store.js';
import { IconButton, cx } from './ui.jsx';

const loadRenderer = () => import('../visualiser.js');

export function AudioPanel({ viewer, hidden = false, onClose, onPopOut, poppedOut = false }) {
  const panel = useRef(null), canvas = useRef(null), renderer = useRef(null);
  const playback = useStore(viewer.store, s => s.playback);
  const audio = useStore(viewer.store, s => s.stats.audio);
  const status = useStore(viewer.store, s => s.status);
  const available = useStore(viewer.store, s => s.audioAvailable);
  const [style, setStyle] = useState(() => pref.getStr('visualiser.style', 'bars'));
  const [gradient, setGradient] = useState(() => pref.getStr('visualiser.gradient', 'classic'));
  const [animate, setAnimate] = useState(() => pref.get('visualiser.animate', true));
  const [reduced, setReduced] = useState(() => matchMedia('(prefers-reduced-motion: reduce)').matches);
  const [visible, setVisible] = useState(() => !document.hidden);
  const [expanded, setExpanded] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const [error, setError] = useState('');
  const [ready, setReady] = useState(false);
  const paused = hidden || !visible || !animate || reduced || status !== 'connected' || !available;
  const options = useRef({});
  useEffect(() => { options.current = { style, gradient, paused }; }, [style, gradient, paused]);

  useEffect(() => {
    const media = matchMedia('(prefers-reduced-motion: reduce)');
    const motion = () => setReduced(media.matches);
    const visibility = () => setVisible(!document.hidden);
    const full = () => setFullscreen(document.fullscreenElement === panel.current);
    media.addEventListener('change', motion);
    document.addEventListener('visibilitychange', visibility);
    document.addEventListener('fullscreenchange', full);
    return () => {
      media.removeEventListener('change', motion);
      document.removeEventListener('visibilitychange', visibility);
      document.removeEventListener('fullscreenchange', full);
    };
  }, []);

  useEffect(() => {
    if (!playback) return;
    let cancelled = false, instance;
    setError(''); setReady(false);
    loadRenderer().then(({ createVisualiser }) => {
      if (cancelled) return;
      instance = createVisualiser(canvas.current, { ...playback, onError: fail });
      renderer.current = instance;
      const { style, gradient, paused } = options.current;
      instance.style(style, gradient);
      instance.pause(paused);
      setReady(true);
    }).catch(() => fail());
    function fail() {
      try { instance?.dispose(); } catch {}
      if (renderer.current === instance) renderer.current = null;
      instance = null;
      if (!cancelled) { setError('Visualizer unavailable.'); setReady(false); }
    }
    return () => {
      cancelled = true;
      try { instance?.dispose(); } catch {}
      if (renderer.current === instance) renderer.current = null;
    };
  }, [playback]);

  useEffect(() => {
    try {
      renderer.current?.style(style, gradient);
      renderer.current?.pause(paused);
    } catch {
      try { renderer.current?.dispose(); } catch {}
      renderer.current = null; setReady(false);
      setError('Visualizer unavailable.');
    }
  }, [style, gradient, paused]);

  const message = status !== 'connected' ? 'Connecting…'
    : !playback ? available ? 'Waiting for audio…' : 'Audio unavailable.'
    : audio?.state === 'suspended' ? 'Playback paused.'
    : audio?.signalPeak > 0.0001 ? 'Playing' : 'Silent';
  const live = status === 'connected' && playback && audio?.state !== 'suspended';
  return (
    <section ref={panel} hidden={hidden} aria-label="Audio Visualizer" className={cx('flex shrink-0 flex-col border-t border-line bg-surface text-xs', poppedOut && 'h-full overflow-auto', fullscreen && 'bg-canvas')}>
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-line px-3">
        <AudioLines className="size-3.5 text-ink-3" />
        <strong className="font-medium text-ink">Audio Visualizer</strong>
        <span className="ml-auto flex items-center gap-1">
          {!poppedOut && <IconButton icon={expanded ? ChevronsDownUp : ChevronsUpDown} label={expanded ? 'Collapse' : 'Expand'} size="sm" blurOnClick={false} onClick={() => setExpanded(!expanded)} aria-expanded={expanded} />}
          {onPopOut && <IconButton icon={ExternalLink} label="Pop Out Visualizer" size="sm" onClick={onPopOut} />}
          {document.fullscreenEnabled && <IconButton icon={fullscreen ? Minimize : Maximize} label={fullscreen ? 'Exit Fullscreen' : 'Fullscreen Visualizer'} size="sm" blurOnClick={false} onClick={() => {
            const action = fullscreen ? document.exitFullscreen() : panel.current.requestFullscreen();
            action.catch(() => setError('Fullscreen unavailable.'));
          }} />}
          <IconButton icon={X} label="Close Visualizer" size="sm" onClick={onClose} />
        </span>
      </div>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 px-3 py-2">
        <label className="inline-flex items-center gap-1.5 text-ink-3">Style <select className="select" value={style} onChange={e => { setStyle(e.target.value); pref.setStr('visualiser.style', e.target.value); }}>
          <option value="bars">Spectrum Bars</option><option value="line">Line Spectrum</option>
          <option value="radial">Radial Spectrum</option><option value="stereo">Stereo Spectrum</option>
        </select></label>
        <label className="inline-flex items-center gap-1.5 text-ink-3">Colours <select className="select" value={gradient} onChange={e => { setGradient(e.target.value); pref.setStr('visualiser.gradient', e.target.value); }}>
          <option value="classic">Classic</option><option value="rainbow">Rainbow</option><option value="steelblue">Steel Blue</option>
        </select></label>
        <label className="inline-flex items-center gap-1.5 text-ink-2"><input type="checkbox" className="check" checked={animate} onChange={e => { setAnimate(e.target.checked); pref.set('visualiser.animate', e.target.checked); }} /> Animate</label>
        <p role="status" className="flex min-w-0 items-center gap-2 text-ink-3 sm:ml-auto">
          <span className={cx('size-1.5 shrink-0 rounded-full', live ? 'bg-ok' : 'bg-ink-4')} />
          <span className="truncate">{message} {reduced ? 'Reduced motion.' : !animate ? 'Paused' : ''}</span>
          {audio?.state === 'suspended' && <button type="button" onClick={viewer.resumeAudio} className="btn btn-link btn-xs">Start Playback</button>}
        </p>
      </div>
      {error && <p role="alert" className="callout callout-warn mx-3 mb-2">{error}</p>}
      {playback && !ready && !error && <p className="px-3 pb-1.5 text-ink-4">Loading…</p>}
      <div ref={canvas} className={cx('mx-3 mb-3 overflow-hidden rounded-lg bg-canvas ring-1 ring-line', poppedOut && 'min-h-32 flex-1')} style={poppedOut ? undefined : { height: fullscreen ? 'calc(100vh - 160px)' : expanded ? '35vh' : '130px' }} aria-hidden="true" />
    </section>
  );
}
