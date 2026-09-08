# Architecture

Elsewhere is a headless Wayland compositor whose display is a browser tab. Clients render on
the GPU as usual; the composited frame is hardware-encoded (VA-API through FFmpeg) and streamed
over a WebSocket; the browser decodes it with WebCodecs and paints it on a canvas. Mouse, keyboard
and (optionally) audio travel the same socket; the video moves to a WebRTC data channel (`elsewhere-server`'s
`rtc.rs`, str0m) when a viewer picks that transport, which is what reaches a server across NAT through a
TURN relay (the README compares the two under loss). The shared viewer engine keeps the transport
preference separate from the active path. One socket-scoped RTC attempt owns its callbacks and timeout;
one retry timer handles all fallback causes. Closing the socket or viewer cancels both. Server close
messages carry the attempt generation, and socket teardown releases the entire session. The compositor is also the window manager, and it
exposes what it knows and can do as an HTTP/WebSocket API (see [desktop-api.md](desktop-api.md)).

Other documents: [protocol.md](protocol.md) (wire formats and HTTP API), [panels.md](panels.md)
(layer-shell, taskbars, minimize), [desktop-api.md](desktop-api.md) (window metadata, control,
snapshots, browser UI).

## Decisions

| Question | Decision |
|---|---|
| Stack | Rust + Smithay (git master, pinned by commit in `crates/elsewhere-compositor/Cargo.toml`; 0.7.0 kills a client that destroys a toplevel icon before its buffer, as Chromium 152 does); no wlroots. FFmpeg libraries via ffmpeg-next for encoding. axum for HTTP/WebSocket. |
| Transport | WebSocket + WebCodecs. WebCodecs needs a secure context, so the server speaks HTTPS with a self-signed certificate unless `--no-tls` (localhost development). |
| Windowing | Floating desktop: stacking, click-to-focus, decorations by the client or, for those that draw none, by the compositor, xdg move/resize, maximize/fullscreen, minimize, layer-shell panels. `--kiosk` fullscreens every window for nested desktops. |
| Viewers | Any number, each with its own encoder at its own size and codec. One controls (input and output size): the first control-token session, or whoever took control last. A second, read-only token lets people watch. |
| Cursor | Drawn by the browser (CSS cursor from the compositor's image), never composited: pointer motion costs no frames. Clients name a shape through cursor-shape-v1 or upload a surface; either ends as the same image. |
| Rendering cadence | Damage-driven. No commit, no frame, no bandwidth. |
| Auth | Two shared tokens (control and view-only), handed to a viewer once in the URL fragment and kept in `sessionStorage`; rotatable through the API. WebSocket authenticates with its first message; HTTP API uses `Authorization: Bearer`. No cookies. |

## Process layout

The main process has three thread domains joined by channels. Supervised helpers handle native audio
and broadcast network I/O.

```
 Wayland clients ──► $WAYLAND_DISPLAY socket           Xwayland (rootless; we are its window manager)
                              │
  ┌───────────────────────────▼──────────────────┐  Frame (dmabuf + lease, or pixels)  ┌─────────────────────┐
  │ compositor thread (calloop, Smithay)         │ ────────────────────────────► │ FFmpeg worker             │
  │  wl_compositor · shm · linux-dmabuf · xdg     │      (every viewer's)          │ per viewer and window:    │
  │  layer-shell · foreign-toplevel · seat · ...  │ ◄── last lease dropped ⇒ free ─│  DRM PRIME → scale_vaapi  │
  │  desktop::Space<Window>  (floating WM)        │                                │  → VAAPI encoder         │
  │  GlesRenderer on GBM/EGL (render node)        │                                └────────────┬─────────────┘
  │  OutputDamageTracker → 4-slot dmabuf swapchain│                                             │ StreamMsg
  └──────────────▲───────────────────────────────┘                                             ▼
                 │ Command (calloop channel)   Event (tokio mpsc) ▲
  ┌──────────────┴──────────────────────────────────────────────┴──────────────────────────────────────────┐
  │ tokio thread: axum · HTTPS (rustls, rcgen self-signed) · /ws · /ws/window · /api · /mcp · web/dist      │
  └──────────────────────────────────────────────────────────────▲──────────────────────────────────────────┘
                                                                 │ wss (binary frames both ways)
  ┌──────────────────────────────────────────────────────────────┴──────────────────────────────────────────┐
  │ browsers: VideoDecoder → canvas · AudioDecoder → Web Audio · the controller's input → messages · React UI │
  └─────────────────────────────────────────────────────────────────────────────────────────────────────────┘
```

Zero-copy video path: client dmabuf → GLES composite into a GBM-allocated dmabuf → the VA-API
post-processor and encoder import that same dmabuf → bitstream → browser GPU decode. No CPU pixel
copies. Without a GPU (`--render-node none`, or no node) the renderer is llvmpipe on Mesa's surfaceless
EGL platform, frames are rendered into one texture and read back (`gpu::Targets::Texture`,
`FrameBuffer::Memory`) for the software encoders, and there is no dmabuf or explicit-sync global: clients
draw into shared memory.

Audio uses a private PipeWire server, pipewire-pulse and WirePlumber per desktop. A native null sink
receives application playback; a native mono loopback publishes the browser microphone. Hardware
discovery and host routing state are excluded. The main process owns service startup and cleanup.
A supervised helper process runs native PipeWire capture and FFmpeg stereo Opus encoding, plus
FFmpeg decoding and native PipeWire microphone playback. Explicit native socket descriptors select
the private graph. Framed
Opus and typed mixer messages cross the helper's pipes; browser audio packet framing remains separate.
The helper's native management loop subscribes to graph state and creates shared passive meters only
while viewers subscribe. Controller epochs use a shared atomic mapping so delayed helper input cannot
authorize queued commands after handoff. Authenticated desktop sockets receive authoritative snapshots
and subscribed scalar levels through latest-value channels. The helper lets the
owner bound media initialization and stop workers before destroying services, even when native
initialization blocks. The application launch path exports private native/Pulse selectors and clears inherited
device overrides. See [session audio](session-audio.md) for readiness, failure and compatibility checks.

The webcam comes back as VP8 frames decoded into a `v4l2loopback` device (`--webcam`), a camera to applications.

## Crates

The compositor crate never depends on FFmpeg and the stream crate never on Smithay; both depend on a
small shared-types crate. That boundary keeps encoders and transports pluggable and compile times sane.

| Crate | Role |
|---|---|
| `elsewhere-core` | Plain types shared by everything: `Command` (server → compositor), `Event` (compositor → server), `Frame`/`FrameBuffer`, `FrameSink`, `StreamMsg`, `WindowInfo`, `ControlMsg`, `InputMsg`, `Snapshot`, the decoration layout. Serde and JSON schemas on the API types. |
| `elsewhere-compositor` | Smithay. `lib.rs` (state, loop, output, resize, spawn), `handlers.rs` (protocol delegates), `input.rs` (browser and API input → seat, focus, decorations), `render.rs` (frame), `gpu.rs` (render node, GBM, EGL and dmabuf swapchains, or the surfaceless platform and a texture read back), `grabs.rs` (move/resize), `decor.rs` (title bars), `xwayland.rs`, `foreign_toplevel.rs`, `workspace.rs`, `desktop.rs` (window list, control, snapshots), `window_stream.rs`, `clipboard.rs`, `cursor.rs`. |
| `elsewhere-stream` | FFmpeg. `FfmpegSink: FrameSink` owns a bounded viewer worker. `encoder.rs` configures codecs and CPU conversion; `gpu.rs` imports DMA-bufs and performs VAAPI conversion. Native PipeWire capture/playback, Opus codecs, VP8 webcam decoding and V4L2 output, plus independent H.264/AAC RTMP broadcasts. |
| `elsewhere-server` | axum. TLS and token bootstrap, the viewer assets (`web/dist`, embedded with `include_str!`; its build script insists on a web build first), `/ws` (viewer sessions, roles) and `/ws/window/{id}` sessions, `rtc.rs` (the WebRTC data-channel transport: str0m peers on one UDP socket per address, the video's other pipe), `/api` (`api.rs` holds the operations, `elements.rs` the accessibility walk), `/mcp` (`mcp.rs`), audio and event broadcast. |
| `elsewhere` | The `elsewhere` binary: clap CLI, thread spawning, channel wiring, the audio devices, the render node or its absence. |

`web/` is the viewer: React 19 and Tailwind CSS 4, built by Vite into `web/dist` by `make web` (the
`Makefile` runs it before cargo; the Dockerfile and the release workflow do the same; `web/dist` is
not tracked). `src/viewer.js` is the engine (the
WebSocket, WebCodecs decoding onto the canvas, input, clipboard, audio, the `elsewhere` console helpers); it
publishes its state on a small store and React only renders the chrome around the canvas
(`src/App.jsx` and `src/components/`). `src/keycodes.js` maps DOM `code` to evdev (generated from
Chromium's table).

## Compositor

**GPU without KMS.** `DrmNode` for the render node → `DrmDeviceFd` (unprivileged; the "unable to become
drm master" log is expected) → `GbmDevice` → `EGLDisplay`/`EGLContext` → `GlesRenderer`. Frames render
into a 4-slot `Swapchain<Dmabuf>` allocated through GBM with a modifier negotiated at startup: the
renderer-supported layouts that pass a real FFmpeg import/conversion trial, tiled preferred over linear.
Each slot's `Dmabuf` is bound directly (the renderer caches FBOs by dmabuf identity).

**Frame loop.** A calloop timer at the output refresh, plus on-demand rendering right after input or
commits once a frame period has passed. `render_frame` renders only if something is dirty; if the
damage tracker reports no damage, or no viewer is connected, nothing is encoded; otherwise the frame
goes to every viewer's encoder, each holding a share of the slot's lease (carried by copies that still
hold the dmabuf, not by the converted frames the VPP or the CPU make of it, which the encoders keep). After rendering the
GPU is waited on (`SyncPoint::wait`) before any early return, because the next commit releases client
buffers. The rendered slot leaves as a `Frame` whose lease (the `Slot`) is attached to the
`AVBufferRef` owned by the imported frame; the slot is free after GPU conversion releases it.

**Client buffer safety.** A pre-commit hook blocks the commit until the client's GPU work is done:
the explicit-sync acquire point when the client uses linux-drm-syncobj (GTK's Vulkan renderer puts no
implicit fences on its dmabufs), else the dmabuf's implicit fences.
GTK renderer and Qt backend overrides are inherited from the launcher environment; see the
[application environment settings](../README.md#run).

**Output.** One `Output` ("ELSEWHERE-1") whose mode is the browser's canvas in device pixels and whose
scale is the browser's `devicePixelRatio`, so logical pixels equal CSS pixels and pointer coordinates
need no conversion. `Command::Resize` changes the mode, resizes the swapchain, re-arranges layers,
re-fits windows (`relayout`), and reopens the encoder with a new stream id. Sizes are rounded
down to even for 4:2:0 encoders.

**Windows.** `desktop::Space<Window>` holds Wayland toplevels and X11 windows alike. New windows
cascade inside the work area (the output minus panel exclusive zones); maximize fills the work area,
fullscreen the output. Focus, raising and activation go through one function (`focus_window`), which
the click handler, the taskbar protocol, the desktop API and minimize all use. Minimized windows leave
the space into a list (no rendering, hit-testing or frame callbacks) and come back through `relayout`.
Client buffers are wl_shm, linux-dmabuf or single-pixel-buffer-v1 (GTK4's solid backgrounds), and
alpha-modifier-v1 fades a surface without redrawing it. A toplevel with an xdg parent (set_parent, or another client's window through xdg-foreign v2, as
GTK4 and Qt portal dialogs do; GTK3 exports through v1, which Smithay doesn't offer) opens centred on
the parent and is raised with it; xdg-activation lets a client
bring a window forward (a link opened from another program, a second instance of an application).
Windows that don't draw their own decorations (X11 windows, Wayland toplevels that ask for server-side
decorations or bind neither xdg-decoration nor KDE's server-decoration protocol) get a title bar drawn
by the compositor (`decor.rs`, see [desktop-api.md](desktop-api.md)). Super/Alt + left drag moves any
window besides.

**Frame pacing.** A frame clock at the output's refresh rate renders when something is dirty. After
every tick, rendered or not, the compositor releases the fifo barriers (fifo-v1) and the commit timers
due by then (commit-timing-v1) of every surface a client has, mapped or not, so a client that queues
one frame per refresh never stalls and a hidden one keeps going; the commits this lets through render
on the next tick, or at once after an idle one. content-type-v1 is recorded per window for the API.

**Input.** Browser keys arrive as evdev codes (xkb keycode = evdev + 8); the compositor never
auto-repeats (clients do, via `repeat_info`) and ignores repeats. Pointer motion hit-tests overlay/top
layers, then windows, then bottom/background layers. Pointer locks (relative-pointer + pointer-
constraints) are mirrored to the browser's Pointer Lock API; the browser then sends raw deltas.
The application's fullscreen button requests keyboard capture for the active driving viewer.
In supported fullscreen sessions, normal Escape reaches the remote application and holding Escape
invokes the browser's release gesture. Ordinary pointer release does not end fullscreen keyboard
capture. Outside supported fullscreen, including browser-only F11 fullscreen, normal Escape may
release the pointer. Capture resumes through a deliberate click after the browser releases it.

**Xwayland.** Started at boot; its `DISPLAY` is printed and passed to `--exec` children. X11 windows
are ordinary space elements; clipboard and primary selection are bridged both ways; `WM_CHANGE_STATE`
iconify goes through the same minimize code. The keyboard focuses an X11 window as an `X11Surface`
(`KeyboardFocus` in `handlers.rs`), so Smithay applies the window's focus model from `WM_HINTS` and
`WM_TAKE_FOCUS` (X input focus, the take-focus message, or both); an X11 client that only ever saw its
surface focused gets no `FocusIn`, and Chromium, for one, then opens no menus. Clicks on
override-redirect windows (X11 menus, tooltips) leave the focus alone, and an unmapped window hands it
to the top-most one left. The pointer is not clamped to the output: a window that hangs past its edge
(a popped-out one sized by its own tab) takes clicks there, except an X11 one, whose Xwayland screen is
the output; the server tells the popup and the API caller when a click aims at such a spot. The frame
that moves the pointer onto a new surface carries no
relative-pointer delta: Xwayland warps its device to the entry point and would apply the delta on top,
which put a synthesized click far from its target.

**Panels and taskbars.** wlr-layer-shell and a hand-written wlr-foreign-toplevel-management (v2)
make waybar and xfce4-panel work as ordinary clients. Details in [panels.md](panels.md).

## Streaming

One `FfmpegSink` per desktop or window viewer owns a long-lived encoder thread. It creates, uses and
destroys its native contexts on that thread. Hardware encoding uses this path:

```
compositor DMA-buf → DRM PRIME import → scale_vaapi to NV12 → VAAPI encoder → raw WebCodecs packet
```

Startup trials allocate real compositor buffers and test import and conversion on the selected render
node. Tested tiled layouts take precedence over linear fallback. Each imported descriptor owns its FD
and compositor lease through an `AVBufferRef`. Conversion synchronizes the output VA surface before
releasing the input, so the encoder's reference pictures do not retain compositor slots. Source
layouts must match the dimensions, stride, offset, fourcc and actual modifier the compositor supplied.
RGB input is full range; converted NV12 and encoded output use limited-range BT.709.

With `--software-encoding`, the compositor supplies memory or linear DMA-buf pixels. The worker maps
and synchronizes DMA-buf CPU access, converts through libswscale, and uses libvpx, libx264 or
OpenH264, libx265, or libaom. The compositor clock runs at 30 Hz in this mode. Software codec
preference is VP8, H.264, VP9, HEVC, AV1; hardware preference is AV1, HEVC, VP9, H.264. Native capability
probes require an actual keyframe. The browser intersects that list with its WebCodecs support;
`--codec` wins when both sides support it. AV1 and VP9 codec levels are selected from picture size.

Submission does not wait for the worker. It replaces one pending raw picture, applies the frame cap,
and returns a retry deadline when the cap rejects a picture. Initialization and output or admission
pressure return `Deferred`; the worker requests a complete picture when it becomes ready.
`Held` asks for a retry on the next compositor tick, including transient lock contention and initial
keyframe delivery. Retry state belongs to each desktop or window stream, so compositor-scheduled
retries of unchanged content do not resubmit it to healthy viewers. Worker recovery requests a full
redraw for all streams once. Broadcast cadence is tracked separately per sink.
Each pending picture includes its source
layout. A control or resize change invalidates incompatible pending work; repeated changes coalesce
before the worker publishes a new stream. The worker requests a complete redraw when a new encoder
is ready, including on an idle desktop. Accepted final pictures are encoded without requiring later
animation. The compositor also requests one refinement frame 150 ms after the picture settles; it
uses the current target and bypasses the frame cap without a bitrate-change cycle.

The worker also budgets input from the bytes it delivers. An encoder can exceed its target bitrate
even at the largest quantizer. The worker accumulates those bytes with a 100 ms burst allowance,
so variable frame sizes can share budget across render ticks. It waits when the unpaid budget exceeds
that allowance, releases raw input and requests a fresh complete picture when input can resume.
Conversion and encoding time pay down the budget; blocked output does not. Idle time cannot grow
the allowance. Rate changes rescale unpaid bytes; key requests and encoder reopens preserve them.
One encoded packet can exceed the allowance because its size is known only after encoding.
The native encoder targets 90% of the stream's current bitrate budget, leaving room for rate-control
variation. The byte budget and congestion controller use the full stream
target. Native bitrate and buffer settings appear in the `ffmpeg video rate` debug trace.

The encoder-to-server channel holds two messages. The worker can wait with one encoded packet but
releases pending raw pictures and refuses more input during that wait. Configuration and the first
keyframe reserve their output slots together. Already encoded deltas stay in reference order;
recovery discards obsolete worker output and begins a new stream with an independently decodable
keyframe. Each transport sends the stream configuration before its video. The server clears older
unsent RTC pictures on recovery, retaining the configuration ahead of the replacement key. Repeated
configurations for the same stream on that connection leave the browser decoder intact. The browser ignores delayed
WebSocket video while RTC is active; a new WebSocket configuration closes that RTC attempt before
changing the decoder. Bytes accepted by SCTP remain subject to the ordered data channel's
retransmission behavior.
The viewer keeps the last painted picture while waiting for a new stream's keyframe. Canvas dimensions
change only when the next decoded picture is ready to paint, so decoder restarts leave the picture visible.
Each peer admits one 16 KiB fragment at a time, with spacing derived from its current stream target.
The rate allows 25% headroom and charges 10% for wire overhead. Idle time accumulates no send credit;
keyframes, encoder restarts and target changes preserve the next fragment's existing deadline.
Native SCTP write refusal and frames rejected by full queues feed congestion control.
Waiting for the pacing deadline and replacing unsent video with a recovery key do not.
Pending video with no SCTP byte acknowledgements for three seconds gives video back to the WebSocket. Encoder
restarts do not reset that deadline. A frame waiting three seconds at the application queue's front
also triggers fallback.

Video settings disable B-frames and lookahead and constrain burst size with a short buffer budget.
VA encoders use CBR, one reference and one asynchronous operation. Software encoders use their
low-delay rate-control settings; software GOPs are long and VA GOPs are 1024 frames. Requested recovery
forces a keyframe with the headers needed by a fresh browser decoder. Only libx264 applies bitrate
changes live; other encoders reopen. Capture timestamps retain the same clock origin across reopens.

Each viewer chooses a bitrate ceiling independently. Very Low, Low, Medium, High and Max use 2, 5,
`--bitrate` at 8 by default, 12 and 25 Mbit/s. Max is the default. The rate controller halves the target
under sustained output backlog, slow sends, excess RTT or browser delay/drop reports. It holds a
reduction for two seconds and raises the target by a quarter after five clean seconds, up to the
ceiling. Targets below 3 Mbit/s cap delivery at 30 fps. Both read-only and controlling viewers report
congestion. Encoder reopening preserves this adaptation state.
RTC delay reports use the first fragment's arrival time so deliberate spacing of a large frame's
remaining fragments does not itself signal congestion. Full-frame arrival gaps and decoder drops
still feed recovery. A delayed tail on an isolated low-frame-rate picture may reach the native
three-second stall deadline before those browser checks detect it.

Effort is separate from Quality. Fast, Balanced and High map to encoder-specific speed settings and
preserve the requested preference across codec changes and reconnects. The page shows pending until
the first keyframe, then applied or unavailable. See [encoding-effort.md](encoding-effort.md) for
mappings and measurements. Encoder failures reach the server as `StreamMsg::Failed`; successful
recovery clears the failure state for both desktop and window streams.

Last sink drop signals stop and releases pending input. Weak control handles cannot keep the worker
alive. Output waits observe cancellation without joining on the compositor thread. Native driver
calls run on the worker and can still block if the driver hangs.

Native PipeWire captures the private output monitor at 48 kHz stereo. FFmpeg libopus accumulates
capture quanta into 960-sample, 20 ms packets with capture-derived timestamps. The browser decodes
and schedules them on an AudioContext with a small jitter buffer. Microphone and broadcast audio use
the same private graph. See [session-audio.md](session-audio.md) and [broadcasts.md](broadcasts.md).

## Server

axum with rustls. On first start the server writes a self-signed certificate (every local address and
`localhost` as SANs, so the fingerprint it prints can be compared in the browser), its key and a random
token into the data directory (`$XDG_CONFIG_HOME/elsewhere`, or `~/.config/...`). ALPN is pinned to
HTTP/1.1 because WebSocket upgrades need it.

A session becomes a viewer only after it sends a token (see [protocol.md](protocol.md)); which of the
two tokens decides whether it may act. Each session forwards its own encoder's output with a
ten-second send deadline; state messages and audio are broadcast to every session. Encoder output
belonging to a superseded stream id is discarded. The controller and the sizing rules are in
[desktop-api.md](desktop-api.md).

## Web viewer

`VideoDecoder` with `optimizeForLatency`; frames are drawn onto a 2D canvas as they decode. A WebGPU
external-texture path exists behind `?renderer=webgpu` but is opt-in because Chromium on Linux
occasionally presented a blank frame with it. The canvas fills the stage, the area between the top
bar, the side panel and the status bar; the desktop's output takes the stage's size (a `ResizeObserver`
sends a debounced `Resize`), and the old picture is stretched until the new stream arrives. Fullscreen
is requested on the stage, so the chrome disappears and the output becomes the screen's size; the
Keyboard Lock API then lets shortcuts like Ctrl+W reach the desktop. The status bar shows fps, bandwidth,
input-to-frame latency and loss counters; the Statistics tab of the side panel adds per-stage timings
(receive to decoded, decoded to paint, paint interval as p50/p95), decode queue depth, keyframe cadence
and audio lead once a second, collected only while it is shown; `elsewhere()` in the console returns the same
as JSON.

## Running and deployment

See the README for flags and the `Dockerfile` for a complete Arch Linux image with the Xfce applications
and panel, Firefox, Chromium, PipeWire and Mesa's GL and Vulkan drivers (`make docker-run`). The desktop
needs no panel: the viewer's application menu (`GET /api/applications`, from the `.desktop` files) and
power menu, with its window list, stand in for one. Practical notes: `--exec` runs at startup, with a
Wayland session's environment; nested desktops need `--kiosk`; the data directory should be persisted in
containers or each new container creates new tokens.

## Known limitations

- One workspace, one output; one pointer and keyboard, driven by one viewer at a time.
- Window streams carry no audio.
