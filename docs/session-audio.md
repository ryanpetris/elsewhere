# Session audio

Each desktop owns a private PipeWire server, pipewire-pulse and WirePlumber. Their native and Pulse
sockets, configuration and state live in a private temporary directory. The existing Wayland runtime
directory remains usable. PipeWire and pipewire-pulse use private copies of the installed distribution
configuration files with Elsewhere additions in private `.conf.d` directories. System files are untouched;
machine and user configuration fragments are not loaded. Distribution scheduling and profiling defaults
remain available. JACK auto-connection and X11 bell handling are disabled for the private server.
The services load distribution modules and policy, with hardware discovery
and persistent host routing state disabled. They do not enumerate ALSA, Bluetooth or video devices.
This scopes the audio graph; it does not sandbox arbitrary applications running as the same user.

The graph's minimum processing quantum is 1024 frames, or 21.33 ms at 48 kHz. This limits how far
application latency requests can shorten the shared audio interval, at the cost of higher minimum audio latency.

The graph has three virtual devices:

| Name | Purpose |
| --- | --- |
| `elsewhere-output` | Default stereo application output, captured for the browser |
| `elsewhere-microphone` | Default mono source carrying the controlling browser's microphone |
| `elsewhere-microphone-input` | Internal input to the microphone loopback |

The output is a native null sink. The microphone uses a native loopback module. The output and
microphone keep processing while idle, so recording starts without waiting for a playing application
and inactive microphone input produces silence. WirePlumber chooses defaults by priority; the
microphone outranks sink monitors, including on older WirePlumber versions.

Native PipeWire streams capture the output monitor as 48 kHz stereo PCM. Callbacks copy samples to a
bounded queue and return the device buffers before FFmpeg's libopus encoder runs. Arbitrary capture
quanta accumulate into 960-frame packets: 20 ms at 96 kbit/s. Packet timestamps follow capture sample
positions, including gaps, rather than assuming every queued sample was delivered. DTX is enabled
when the installed FFmpeg wrapper supports it; older wrappers send correctly clocked silence.

FFmpeg's libopus decoder converts browser microphone packets to 48 kHz mono. Playback queues hold at
most 200 ms of PCM, discard older speech during bursts, and supply silence on underrun. Malformed
packets do not stop desktop audio. Native capture and playback run in the owned audio helper, with
explicit private socket descriptors and node targets. Routing properties are restored after
PipeWire applies inherited selectors, before activating streams. A target that stops processing
audio for three seconds fails the stream. `pactl info` checks compatibility-protocol startup and defaults.

## Starting applications

Startup commands, menu/API launches and descendants receive `PIPEWIRE_REMOTE`, `PULSE_SERVER` and
`PIPEWIRE_CONFIG_DIR` for the private session. Inherited `PULSE_SINK`, `PULSE_SOURCE`, `PIPEWIRE_NODE`
and PipeWire configuration-name overrides are cleared. Playback and recording use different
WirePlumber defaults, so a global device override is inappropriate.

The startup log prints these connection variables. Clients started separately can use those values:

```sh
PIPEWIRE_REMOTE="<native-socket>" PULSE_SERVER="unix:<pulse-socket>" \
PIPEWIRE_CONFIG_DIR="<session-config-directory>" application
```

The selectors identify sockets already owned by the desktop; no WirePlumber lookup is needed to find
them. Device names remain stable within each isolated graph, including across desktop restarts.

## Readiness and failure

Service version checks, native graph discovery and Pulse default checks share an eight-second
deadline. Media helper startup has a separate eight-second deadline and must produce an encoded audio
packet before clients launch. Blocked native initialization cannot hold the desktop indefinitely.

`--no-audio` starts no audio services. Initialization failure cleans up partial resources and leaves
the desktop running with audio unavailable. Applications receive failing socket selectors rather
than inheriting a host audio server. A later service or media worker failure stops the owned stack and
withdraws playback and microphone capabilities from connected viewers. It does not restart audio.

SIGTERM and Ctrl+C are handled from startup. Audio children have separate process groups so terminal
signals go through the owner's cleanup path. Shutdown asks the audio helper to stop, gives it
500 ms to exit, then kills and reaps it if necessary before removing services and their directory.
The compositor thread is also joined before process exit. Repeated signals do not interrupt this join.
The container runs the compositor as PID 1 so `docker stop` reaches its signal handler.
Forced termination such as SIGKILL cannot run this cleanup. Outside a container, it can leave audio
children and the temporary directory behind.

## Session mixer

Open **Mixer** in the desktop status bar to inspect session devices and application playback and
recording streams. Streams with application metadata are grouped together, but each row controls one
stream. Read-only viewers can inspect; only the current controlling viewer can change audio.
Changes affect the shared session for every viewer.

Pop Out Mixer opens the panel in a resizable browser window using the same viewer
connection and control permissions. Its meters follow that window's visibility,
independently of the main viewer's controls. The status-bar button focuses an
existing pop-out. Closing the pop-out leaves the mixer closed until reopened.
The pop-out closes when either window navigates or reloads, the main viewer closes,
or the server session ends. Temporary reconnects keep it open.

Volume ranges from 0 to 100 percent with cubic gain: 50 percent means linear gain 0.125. Mute and
volume use the object's native controls. Unsupported controls are disabled or explained. Current
routing is shown for application streams. When more than one compatible session endpoint exists,
the target selector and device default buttons ask WirePlumber to change routing. These controls do
not enumerate host hardware or alter host defaults.

Meters measure actual peaks. Playback, output and microphone meters follow their volume and mute;
recording-stream meters measure before that stream's own controls. Inactive means no recent samples,
not a stored volume setting. Monitor streams are shared between viewers, publish scalar peaks at
about 10 Hz, and are removed when the last visible mixer closes. Meter failures are shown separately
from control availability. The optional output visualiser is independent of this panel.

Muting **Elsewhere microphone** silences the session source while browser capture continues. Use the
microphone capture toggle to stop recording permission use. Opening the mixer, changing its controls,
and subscribing to meters never start browser capture.

The helper owns one native management connection. Object identifiers combine its connection
generation with PipeWire's object serial; reconnects invalidate old identifiers. Authoritative state
is broadcast through latest-value channels, and control queues are bounded. A shared atomic control
epoch rejects queued commands from a revoked controller even if helper input is delayed. An operation
already admitted before handoff may complete afterward. Changes not confirmed by native state within
three seconds produce an error.

## Dependencies

The supported baseline is PipeWire 1.4.2 and WirePlumber 0.5.6. The latter introduces the policy and
stateless profile blocks used by this configuration. Older service versions are unsupported. The
runtime checks daemon and policy versions; media initialization checks for FFmpeg's libopus encoder
and decoder. The linked FFmpeg libraries are required even when audio services are disabled.

| Distribution | Audio packages |
| --- | --- |
| Arch | `pipewire`, `pipewire-pulse`, `wireplumber`, `libpulse` |
| Debian/Ubuntu | `pipewire`, `pipewire-pulse`, `wireplumber`, `pulseaudio-utils` |
| Fedora | `pipewire`, `pipewire-pulseaudio`, `wireplumber`, `pulseaudio-utils` |

Check versions as well as package names. Audio services are optional for installations using
`--no-audio`; Debian metadata recommends them and Arch metadata lists them as optional dependencies.
The native PipeWire client library is a linked runtime dependency even when audio is disabled.
The Docker image contains the complete audio stack and the application starts it.

Runtime isolation does not guarantee that distribution packages coexist with host PulseAudio.
Arch's `pipewire-pulse` conflicts with `pulseaudio`; Fedora also uses mutually exclusive Pulse server
packages. Debian 13's `pipewire-pulse` conflicts with `pulseaudio-module-gsettings` and ships user
service/socket activation. Check the package transaction and service activation before installing on
a host that uses PulseAudio. The Docker image provides these dependencies without changing host audio
packages. Runtime startup never changes host defaults or invokes a service manager.

## Verification

Run verification inside Docker with the checkout and release build mounted. The lifecycle check is
`crates/elsewhere/checks/audio-lifecycle.py`, taking the release binary as its argument. It covers idle
startup, signal handling, missing services/Opus encoder, service and worker readiness timeouts, and
individual service exits. Failed audio must be cleaned up while the desktop keeps running.
`web/checks/private-audio.mjs` exercises native and Pulse playback/recording through a live browser,
microphone silence transitions, session microphone mute without changing consent, sustained mixer traffic,
malformed packet handling and capability withdrawal.
`crates/elsewhere/checks/audio-isolation.py` checks two desktops alongside an unrelated audio graph, separate
tones and lifecycles, and native/Pulse mpv playback with saved device choices across app restarts. It
also runs `web/checks/mixer-isolation.mjs` against both live sessions to check mixer membership and
foreign-object rejection.
The native meter check is `cargo run --release -p elsewhere --example audio-graph`, also
run inside Docker. It creates its own private services and checks playback, output, microphone and
recording peaks through mute and gain changes, then verifies monitoring nodes disappear when meters
are dropped while the management connection stays open. Output monitors follow channel volume and mute. Recording-stream monitoring is before that
stream's own controls; the check separately verifies muted samples delivered to the recorder.

`cargo run --release -p elsewhere --example audio-mixer` checks native and Pulse controls,
per-stream isolation, real routing to a second output, default selection, object removal, reconnect,
monitor cleanup and cross-process control revocation. `web/checks/session-mixer.mjs` checks the rendered
panel, authoritative controls, three-viewer authorization and shared subscriptions.

`cargo run -p elsewhere --example audio-graph -- --media` starts private services and runs the native
media integration test. It checks 1024-frame capture quanta into 960-frame Opus packets, continuous
timestamps, hostile inherited selectors, malformed and burst microphone packets, underrun silence,
resume, missing targets and joined shutdown. It then verifies media nodes did not survive their workers.
The example requires Cargo and the checkout; codec and letterboxing unit checks run with
`cargo test -p elsewhere-stream --lib`.

The browser check's fake capture source is a test WAV;
production capture still requires browser consent.

Microphone capture uses AudioWorklet to send mono 1024-frame PCM blocks to the Opus encoder.
Timestamps count frames at the AudioContext's actual sample rate. The processor leaves local output
silent. Stopping invalidates starts waiting for permission or module loading; callbacks from an old capture
cannot affect a new one. Capture requires AudioWorklet.

Run `node web/checks/microphone.mjs` inside Docker for real Chromium capture, Opus decoding,
continuous timestamps, silent local output, repeated starts and stops, delayed permission results,
and setup/processing/encoder failures. Both browser runs use a button click with normal autoplay
policy. Add `--firefox` with geckodriver on port 4445 and a working PulseAudio output for the browser.
`private-audio.mjs` also checks repeated AudioWorklet delivery to native and Pulse recorders, the
pending-permission button, control handover and disconnect. Chromium 152 and Firefox 155 pass the
standalone checks; Chromium also passes the recorder and viewer checks.

The native media integration check passes with FFmpeg 9, PipeWire 1.6.8 and WirePlumber 0.5.17.
Its four-second playback interval delivers continuous Opus without timestamp gaps and joins media
workers within the helper's 500 ms shutdown allowance. Native virtual nodes keep device lifetime
independent of browser capture and application streams.

For a ten-minute playback clock check, run `node checks/session-audio.mjs --av-seconds=600` from `web`
with `ELSEWHERE_TEST_URL` and `ELSEWHERE_TEST_TOKEN_FILE` pointing at the dedicated Docker desktop.
FFmpeg generates synchronized flashes and chirps; mpv plays them through the private native graph.
The check compares observed canvas flashes with the AudioContext output clock. It checks pulse loss,
absolute offset and the change between the first and last 15-pulse median offsets. It does not
measure sound at the speakers or physical display scanout.

A 600-second software-rendered run matched 300 pulses. Audio followed video by 173.09 ms near the
start and 166.43 ms near the end, a change of -6.66 ms. The largest matched offset was 240.64 ms.
The first observed matched pair was 185.81 ms. A separate startup check uses black/silent preroll
and ordinal pulse matching to distinguish a delayed pulse from the following cycle. Its first source
pulse offset was 109.33 ms, with every matched pulse below 144 ms. These offsets remain visible
alongside drift; a stable clock does not establish close audiovisual synchronization.

The webcam device check is `python web/checks/webcam-native.py /dev/videoN`, after building
`cargo build -p elsewhere-stream --example webcam-output`. Expose an unused v4l2loopback
device only to the dedicated Docker container. The check decodes actual YUYV capture from the
selected device, verifies the 1280 by 720 aspect fit and borders, recovers after malformed VP8,
injects temporary write pressure and a permanent device failure, and checks bounded worker stop.
An unprivileged run without device access must fail cleanly.

### Standalone native capture

`python crates/elsewhere/checks/native-capture.py` runs 30 fresh private stacks in Docker using
`pw-record` for capture and FFmpeg tones through `pw-cat` for playback. Each trial waits for running
virtual nodes, captures output and idle microphone silence, then checks two microphone tone/stop
cycles. Every capture must produce at least 20,480 sample frames and exit within six seconds.
Tone captures also wait for actual signal within that deadline. All 30 fresh-stack trials pass with
FFmpeg 9, PipeWire 1.6.8 and WirePlumber 0.5.17.
Failures retain the configuration and logs inside the container; capture timeouts also save a graph snapshot.

References: [PipeWire configuration](https://docs.pipewire.org/page_daemon.html),
[native loopback](https://docs.pipewire.org/page_module_loopback.html),
[WirePlumber file isolation](https://pipewire.pages.freedesktop.org/wireplumber/daemon/locations.html),
[WirePlumber 0.5.6 profiles](https://github.com/PipeWire/wireplumber/blob/0.5.6/src/config/wireplumber.conf),
[Fedora Pulse server packaging](https://fedoraproject.org/wiki/Changes/DefaultPipeWire).
