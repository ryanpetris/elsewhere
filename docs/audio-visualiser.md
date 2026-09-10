# Session audio visualiser

The desktop viewer's audio controls open an expandable visualiser panel. Spectrum
bars, a frequency line with area fill, radial bars and independent left/right
spectra share the Classic, Rainbow and Steel Blue palettes. Style, colours and the
animation switch are local display preferences. Read-only viewers can use them.
Reduced-motion preferences pause animation; status text remains available.

Wave.js 2.0.5 supplies the rendering subset in `web/vendor/wave`, pinned to upstream
revision `03b29e841a9d0dbce5845bb6faf75b9b0088c49f` under MIT. That directory records
the source files and adaptations. npm installs the local package, Vite includes it
in the optional visualiser chunk, and the acknowledgements generator includes its
license. The renderer loads only when the panel opens with playback available.
Opening About or the mixer does not load it. All assets are local.

The visualiser observes the viewer's playback node before browser or system muting.
It cannot identify applications or confirm sound at the speakers. Text distinguishes
unavailable audio, waiting for playback permission, signal and silence. Microphone
capture remains separate.

A dedicated analysis branch upmixes mono to both channels and splits stereo into
two owned analysers. Each uses a 4096-sample FFT, smoothing of 0.7 and a -90 to -15 dB
range. Sixty-four logarithmic bands cover 20 Hz through 20 kHz or Nyquist. Each band
uses its strongest bin. Combined views take the stronger channel per band, so
opposite-phase stereo does not cancel the display. Stereo draws each channel
separately. Drawing scales to the backing canvas and its owning window's pixel ratio.

Playback retains its context, statistics analyser settings and speaker connection.
The branch never connects to speakers. The renderer starts paused. Animation is
capped at 30 fps, with no recurring animation callbacks or analysis reads while
paused, hidden, zero-sized or without a running playback context. Disabling Animate,
reduced motion, hidden controls and viewer fullscreen pause the docked panel.
Closing it releases its branch, canvas, observers and listeners. Setup and draw
failures stop the renderer and report "Visualizer unavailable" without stopping
session playback.

Pop Out Visualizer opens a resizable window sharing the same playback source and
connection. Its visibility, animation scheduling and fullscreen controls belong to
that window. A background opener does not pause a visible popup. The status button
focuses an existing popup; closing it leaves the visualiser closed. Blocked popups
leave the dock available. Navigating or reloading either window, ending the session
or transferring desktop playback to picture-in-picture closes the popup. Temporary
reconnects keep it open and replace its analysis branch when playback returns.

## Verification

Run checks inside Docker with Chromium and Node installed, after `npm ci` and
`npm run build` in `web`:

- `npm run check:visualiser` checks the emitted panel and Wave renderer, lazy loading,
  status and accessible controls, all styles and palettes, frequency placement at
  80 Hz, 1 kHz and 8 kHz, true stereo, mono, silence, HiDPI, graph ownership,
  reduced motion, pause/dispose, partial setup and asynchronous drawing failures.
  Small input arrays and counts exceeding the available bins must produce finite
  bounded geometry. A simulated 144 Hz display checks the rendering cap and stale
  callbacks after pause or disposal.
- `npm run check:panel-windows` checks shared graph and connection ownership, prefixes,
  independent visibility, resize, fullscreen, preferences, reconnects, blocked popups,
  repeated cleanup, context closure and failed cleanup during session termination.
- `npm run check:viewer-disposal` and `node checks/settings.mjs` cover viewer teardown
  and the surrounding controls.

Also run the panel-window check with `BROWSER_CDP` pointing at ordinary Chromium
under Xvfb, launched with remote debugging and
`--autoplay-policy=no-user-gesture-required`. This mode verifies popup rendering
and mixer commands while the opener is genuinely in a background tab, without
Playwright's visibility overrides. Run both browser modes.

For Firefox, install the Playwright Firefox browser and its system libraries in
the rig. Provide a Pulse-compatible virtual audio output through `PULSE_SERVER`;
Firefox needs an output device for a running AudioContext. Run
`BROWSER=firefox node checks/visualiser-renderer.mjs` and
`BROWSER=firefox npm run check:panel-windows`.

The live check is `node checks/session-audio.mjs`, with `ELSEWHERE_TEST_URL` and
`ELSEWHERE_TEST_TOKEN_FILE` pointing at an isolated Docker desktop and an admin token.
It uses finite FFmpeg audio, mpv software-Wayland video and Chromium's fake microphone.
It terminates only processes matching its test signals. The check compensates for
panel height so closed/open/closed-again measurements use the same video viewport.
It records task time, heap and DOM counts, draw and analysis counts, video frames,
PCM peaks and audio underruns. Run it without competing builds or test workloads.

A Docker Chromium 152 software-video run at a constant 928 × 722 video viewport
measured the following. Each sample lasted about three seconds with the same
30 fps moving video and stereo tone, after both decoders processed about two seconds
of media. Task time is browser main-thread time per
second; heap is the sampled JavaScript heap after collection before each interval.

| Panel | Task ms/s | Video fps | Draws/s | Analysis reads/s | Heap MiB | DOM nodes | Audio underruns |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Closed | 100.1 | 28.9 | 0 | 0 | 5.05 | 624 | 0 |
| Open | 145.5 | 28.5 | 30 | 60 | 5.01 | 748 | 0 |
| Closed again | 114.0 | 28.6 | 0 | 0 | 4.90 | 635 | 0 |

PCM peaks stayed within 0.0001 across these samples. These are rig measurements,
not performance limits for every browser or machine. The live check asserts video
throughput, uninterrupted audio, stable level, the drawing cap and stopped analysis
after closure. Direct lifecycle checks cover retained graph edges, listeners,
observers and callbacks over repeated creation and disposal.
