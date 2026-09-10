# Session audio visualiser

The desktop viewer's audio controls open an expandable visualiser panel. It offers
spectrum bars, a line/area spectrum, a radial spectrum and a stereo spectrum.
Style, colours and the animation switch are local display preferences. Read-only
viewers can use them. Reduced-motion preferences pause animation.

This displays the mixed audio at this viewer's Web Audio playback node, before
browser or system muting. It cannot identify applications or confirm sound at the
speakers. Text distinguishes unavailable audio, waiting for playback permission,
signal and silence. The microphone capture control remains separate.

The renderer loads when playback is available and the panel opens. Its analysis
branch never connects to the speakers. Closing the panel disposes that branch;
hiding the page or hiding the controls or entering viewer fullscreen, disabling animation and reduced motion
pause drawing and disconnect the analysis input. Playback retains its context and
speaker connection. Animation is capped at 30 fps.

## Verification

In the Docker image, install Node, npm and Chromium, then run `npm ci` in `web`.
`npm run build && npm run check:visualiser` exercises the emitted viewer in
Chromium.
The checks cover graph ownership, repeated disposal and click listener counts,
style changes, HiDPI, fullscreen, reduced motion, animation off, delayed audio
initialization and source replacement.
The signal/silence comparison waits for coloured Classic bars on the current
canvas, then for a painted background pixel and no coloured pixels after the oscillator
stops. Twelve consecutive Docker runs passed, including animation-disabled and
reduced-motion checks and the unavailable-renderer fallback. Suppressing canvas path fills in a temporary test copy
failed the signal readiness check within five seconds.
Freezing FFT reads after the signal snapshot failed the silence readiness check.

The live check is `node checks/session-audio.mjs`, with `ELSEWHERE_TEST_URL` and
`ELSEWHERE_TEST_TOKEN_FILE` pointing at an isolated Docker desktop and a token granting `desktop.view` and `audio.listen`.
It uses finite FFmpeg audio and mpv software-Wayland video test signals, then
Chromium's fake microphone device. It terminates test processes whose command
lines match its own signals; use a dedicated rig.

A software-rendered Docker run with a 440 Hz signal decoded 85 video frames in
three seconds both with the panel closed and open, with zero audio underruns.
The measured PCM peak was 0.10113 closed and 0.10112 open. Browser task time was
151 ms/s closed, 132 ms/s open and 160 ms/s closed again. Opening the panel also
shrinks the desktop video viewport, so those task-time samples do not isolate
the renderer's cost. They establish that video and audio continued smoothly in
that rig, not a general performance guarantee. Playback returned to silence. Fake microphone start/stop passed. Restarting
an audio-enabled session with audio disabled cleared the old visualiser and
reported unavailable audio after reconnect.
