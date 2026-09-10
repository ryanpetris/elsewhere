import { Lines, Wave } from '@foobar404/wave';

const palettes = {
  classic: ['#36d399', '#f5d547', '#f26856'],
  rainbow: ['#4b9fff', '#ab72ff', '#f66abd', '#ffb454', '#7ce8bb'],
  steelblue: ['#4a719c', '#83b4dc', '#d0e9ff'],
};

// Peak magnitude in logarithmic bands, from 20 Hz through 20 kHz or Nyquist.
function frequencyBands(data, sampleRate, count = 64) {
  const bands = new Float32Array(count);
  if (!data.length) return bands;
  const binHz = sampleRate / (data.length * 2), high = Math.min(20000, sampleRate / 2);
  for (let i = 0; i < count; i++) {
    const start = Math.min(data.length - 1, Math.max(0, Math.floor(20 * (high / 20) ** (i / count) / binHz)));
    const end = Math.min(data.length, Math.max(start + 1, Math.ceil(20 * (high / 20) ** ((i + 1) / count) / binHz)));
    for (let bin = start; bin < end; bin++) bands[i] = Math.max(bands[i], data[bin] / 255);
  }
  return bands;
}

export function createVisualiser(container, { context, source, onError = () => {} }) {
  let win = container.ownerDocument.defaultView, doc = container.ownerDocument;
  let canvas, drawing, input, splitter, observer, raf = 0, last = 0, attached = false, disposed = false, paused = true;
  let style = 'bars', palette = 'classic', animation;
  const nodes = [], analysers = [], data = [];
  const stop = () => {
    const pending = raf; raf = 0;
    try { if (pending) win.cancelAnimationFrame(pending); } catch {}
    if (attached) { attached = false; try { source.disconnect(input); } catch {} }
  };
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    // Teardown steps are independent, including when the shared context has already closed.
    for (const cleanup of [stop, () => observer?.disconnect(), () => context.removeEventListener('statechange', sync),
      () => doc.removeEventListener('visibilitychange', sync), () => win.removeEventListener('pagehide', dispose),
      () => win.removeEventListener('resize', resize),
      ...nodes.map(node => () => node.disconnect()), () => canvas?.remove()]) {
      try { cleanup(); } catch {}
    }
    nodes.length = analysers.length = data.length = 0;
    container = context = source = win = doc = canvas = drawing = input = splitter = observer = animation = onError = null;
  };
  const fail = error => { const report = onError; dispose(); report(error); };
  function configure() {
    const colors = palettes[palette], color = drawing.createLinearGradient(0, canvas.height, 0, 0);
    colors.forEach((value, i) => color.addColorStop(i / (colors.length - 1), value));
    animation = style === 'line' ? new Wave({ color }) : new Lines({ color, radial: style === 'radial' });
  }
  function resize() {
    if (disposed) return;
    try {
      const width = Math.round(container.clientWidth * win.devicePixelRatio), height = Math.round(container.clientHeight * win.devicePixelRatio);
      if (canvas.width !== width || canvas.height !== height) { canvas.width = width; canvas.height = height; configure(); }
      sync();
    } catch (error) { fail(error); }
  }
  function tick(time) {
    raf = 0;
    if (disposed || paused || !attached) return;
    try {
      if (time - last >= 1000 / 30) {
        last = time - (time - last) % (1000 / 30);
        analysers.forEach((analyser, i) => analyser.getByteFrequencyData(data[i]));
        const [left, right] = data.map(bytes => frequencyBands(bytes, context.sampleRate));
        drawing.fillStyle = '#07111c'; drawing.fillRect(0, 0, canvas.width, canvas.height);
        if (style === 'stereo') {
          const gap = 8 * win.devicePixelRatio, width = (canvas.width - gap) / 2;
          animation.draw(left, drawing, { width });
          animation.draw(right, drawing, { x: width + gap, width });
        } else {
          const mixed = left.map((value, i) => Math.max(value, right[i]));
          animation.draw(mixed, drawing);
        }
      }
      raf = win.requestAnimationFrame(tick);
    } catch (error) { fail(error); }
  }
  function sync() {
    if (disposed) return;
    try {
      if (paused || doc.hidden || context.state !== 'running' || !canvas.width || !canvas.height) { stop(); return; }
      if (!attached) { attached = true; source.connect(input); last = win.performance.now() - 1000 / 30; }
      if (!raf) raf = win.requestAnimationFrame(tick);
    } catch (error) { fail(error); }
  }
  try {
    canvas = doc.createElement('canvas'); canvas.style.cssText = 'width:100%;height:100%;display:block';
    drawing = canvas.getContext('2d');
    if (!drawing) throw Error('Canvas 2D unavailable');
    input = context.createGain(); nodes.push(input);
    // Explicit speaker upmix duplicates mono input; stereo keeps its independent channels.
    input.channelCount = 2; input.channelCountMode = 'explicit'; input.channelInterpretation = 'speakers';
    splitter = context.createChannelSplitter(2); nodes.push(splitter); input.connect(splitter);
    for (let channel = 0; channel < 2; channel++) {
      const analyser = context.createAnalyser(); nodes.push(analyser); analysers.push(analyser);
      analyser.fftSize = 4096; analyser.minDecibels = -90; analyser.maxDecibels = -15; analyser.smoothingTimeConstant = .7;
      data.push(new Uint8Array(analyser.frequencyBinCount)); splitter.connect(analyser, channel);
    }
    container.append(canvas); configure();
    observer = new win.ResizeObserver(resize); observer.observe(container);
    context.addEventListener('statechange', sync); doc.addEventListener('visibilitychange', sync); win.addEventListener('pagehide', dispose); win.addEventListener('resize', resize);
    resize();
    if (disposed) throw Error('Visualizer initialization failed');
  } catch (error) { dispose(); throw error; }
  return {
    style(value, gradient) {
      if (disposed) return;
      style = ['bars', 'line', 'radial', 'stereo'].includes(value) ? value : 'bars';
      palette = Object.hasOwn(palettes, gradient) ? gradient : 'classic'; configure();
    },
    pause(value) { if (!disposed) { paused = value; sync(); } },
    dispose,
  };
}
