# NVIDIA validation

NVIDIA uses GLES texture rendering, synchronized XRGB readback, CPU conversion to limited-range
BT.709 YUV420P, and FFmpeg NVENC. The renderer and encoder are matched by PCI address.
See the [NVIDIA setup](../README.md#nvidia) for native and Docker requirements.

## Hardware evidence

Docker checks used an RTX 3070 Ti Laptop GPU, NVIDIA 610.57.04, FFmpeg 9.0.1, Arch Linux and
Chromium 152. The headed viewer ran on a separate Intel GPU so Chromium could expose its HEVC
decoder. H.264 and HEVC passed. Startup checks an initial key, a delta frame and a requested recovery key
with increasing timestamps; NVENC forces IDRs for all three candidate codecs. The AV1 encoder probe correctly rejected this GPU. Multiple physical NVIDIA GPUs and older
NVIDIA drivers were not tested. The tested FFmpeg library embeds a minimum NVIDIA
driver requirement of 610.00, corresponding to its NVENC 13.1 build. The requirement comes from
FFmpeg's build-time NVENC headers, not Elsewhere's build. Other FFmpeg packages can require a
different driver. [FFmpeg's driver/API checks](https://github.com/FFmpeg/FFmpeg/blob/n9.0.1/libavcodec/nvenc.c#L215)
report the required API and minimum driver when initialization fails.

AV1 passed on an RTX 4000 Ada with NVIDIA 610.57.04, an Ubuntu 26.04 host and the Arch
runtime with FFmpeg 9.0.1 and Chromium 152. The compositor reported NVIDIA GLES; the viewer's
WebGPU device reported NVIDIA Lovelace with `isFallbackAdapter=false`. Desktop/window video,
Canvas2D/WebGPU, PiP/popouts, WebSocket/WebRTC, tiny/odd/X11 crops, screenshots, thumbnails,
quality/effort changes and injected encoder-failure recovery passed. Fresh AV1 recovery keys
also decoded after 3840×2160 startup and encoder reopening. This validates browser AV1 decoding,
not browser hardware decoding or sustained 4K throughput.

A Debian 13 container on the same Ada host runs the v0.10.0 package with FFmpeg 7.1.5. H.264, HEVC and AV1
startup probes pass, and OpenArena renders through NVIDIA with private session audio.

| Surface or behavior | Check |
|---|---|
| Accelerated Wayland/Xwayland clients | `eglgears_wayland` and `glxgears` animate in window video and produce PNGs; `glxinfo` confirms NVIDIA direct rendering |
| X11 frame extents and placement | `x11-placement.py` on NVIDIA checks managed/popup geometry, resizing and pointer coordinates; `gpu-surfaces.mjs` checks visible window video and PNG dimensions through Canvas2D/WebGPU |
| Wayland decoration negotiation | `decorations.py` on NVIDIA checks object lifetimes, modes, maximize/fullscreen, pixels and pointer coordinates |
| Desktop, hidden controls, fullscreen, window popout | `gpu-surfaces.mjs`, H.264 and HEVC, four colored edges |
| Desktop/window Document PiP, PiP from popout, reopen and resize | `gpu-surfaces.mjs`, actual child viewer rendering |
| Canvas2D and WebGPU | `gpu-surfaces.mjs`, pixels read from the presented canvas or GPU texture |
| WebSocket and WebRTC | `gpu-surfaces.mjs`, active transport and fresh painted recovery picture |
| Large desktop startup and codec fallback | 5120×1440 starts with H.264/HEVC allowed, falls back to HEVC, fresh recovery keys decode |
| Desktop resolution changes and existing window target resize | `gpu-surfaces.mjs`, Config, normalized frame and canvas dimensions |
| Small NVENC windows | Pictures below the startup-proven 320×180 encoder surface are black-padded; Config and the shared browser crop retain native size and input coordinates |
| Odd native window sizes | Native 1263×869 PNG and even 1264×870 encoded window |
| HTTP and MCP screenshots/snapshots | `screenshot-sizing.mjs`, native, width, height, percentage, DPR 1/1.5/2 |
| Sidebar thumbnails and snapshot downloads | `thumbnails.mjs`, Wayland/X11, popups, subsurfaces, minimized windows, updates and visibility |
| Quality, effort, reconnect and congestion adaptation | `encoding-effort.mjs`, desktop/window H.264, presets p1/p3/p5 |
| HEVC recovery keys and encoder reopening | `hevc-browser.mjs`, fresh decoder for each requested key and quality/effort change |
| Compositor backpressure with NVIDIA texture targets | `render-retry` with `ELSEWHERE_MEMORY_FRAMES=1`, Held/Deferred/RetryAt and final pictures |
| Repeated viewer resize/effort changes and teardown | `viewer-lifecycle.mjs`, FDs and threads return to baseline; retained-RSS bound is not consistently met, see #131 |
| NVENC session limit | Additional viewer fails without closing its socket, an existing viewer still paints, retry succeeds after releasing sessions |
| Returned encoder errors | `codec-recovery.mjs`, desktop/window retry, codec fallback, exhaustion and explicit retry |
| Fixed/automatic desktop sizing and control handoffs | `fixed-screen-size.mjs` |
| RTMP broadcasts sharing NVIDIA readback | `broadcasts.mjs`, 30/60 fps, output dimensions and keyframes |
| NVIDIA NVENC H.264, Intel VA-API, CPU-only, NVIDIA with CPU encoding | `viewer-lifecycle.mjs --colors`, primary colors, gray ramp and alpha against compositor PNGs |

The live edge checks include 1920×1080, 1346×908 and 1264×870. They assert the normalized picture
and canvas dimensions and inspect all four colored edges. Original decoder dimensions remain in
the logs: decoder padding is permitted when normalization presents the intended image correctly.
The synthetic `video-frame.mjs` and `video-crop.mjs` checks also passed with deliberately padded
pictures, fractional-scale pointer mapping and real SwiftShader WebGPU rendering. These exercise
#94's crop handling even when an NVENC decoder returns exact dimensions. `viewer-disposal.mjs`
passed retained-frame, queued-decode and authorization/disconnect cleanup checks.

Headed Chromium shifts some saturated colors in both NVENC and Intel VA-API streams. The X11
fixture's RGB (229, 42, 97) appears as (214, 19, 96) through headed NVENC H.264 and (230, 43, 96)
headless. Both headed Canvas2D and WebGPU reproduce it. The landmark checks use coarse color
tolerances to verify geometry; they do not establish exact headed-browser color fidelity.
[Issue #130](https://github.com/ryanpetris/elsewhere/issues/130) tracks isolation of the browser
decode/import/conversion path. The separate headless chart checks compare against compositor PNGs.

One isolated lifecycle run kept file descriptors and threads at their idle baseline while retained
RSS rose from about 401 to 429 MiB across five cycles. Further isolated runs exceeded the fixture's
64 MiB growth bound with both the integrated and pre-integration binaries: 432 to 526 MiB and
498 to 579 MiB, respectively. File descriptors and threads still returned to baseline.
[Issue #131](https://github.com/ryanpetris/elsewhere/issues/131) tracks whether this is retained
allocation ownership or allocator/driver caching. The memory assertion remains unchanged; the
isolated pass does not establish a stable memory bound.
A diagnostic run calling `malloc_trim(0)` once per second in the server passed five cycles at
371 to 391 MiB idle RSS. This supports allocator retention as a contributor; the diagnostic is
not part of the application and does not establish a production memory bound.

## Performance samples

`effort-benchmark.mjs` renders text, scrolling and motion in a Wayland Chromium client inside the
NVIDIA desktop. A separate browser decodes the stream and reads a timestamp/sequence marker from
the canvas. These are six-second samples with other validation workloads on the same laptop;
they are not isolated hardware limits or a sustained-load guarantee.

| Size and scene | Effort | Ceiling | Delivered fps | Conversion + encode p50/p95 | End-to-end p50/p95 |
|---|---|---|---|---|---|
| 1920×1080, text/scroll/motion | Fast | 8 Mbit/s | 50.1–51.1 | 7.3–7.6 / 10.4–10.8 ms | 101–104 / 111–127 ms |
| 1920×1080, text/scroll/motion | High | 8 Mbit/s | 49.8–51.1 | 12.7–14.4 / 16.0–16.9 ms | 108–111 / 118–133 ms |
| 3840×2160, motion | Fast | 25 Mbit/s | 34.1 | 28.3 / 37.2 ms | 203 / 224 ms |
| 3840×2160, motion | High | 25 Mbit/s | 22.6 | 44.7 / 53.4 ms | 205 / 229 ms |

No decoder errors, transport losses or browser-reported drops occurred in these samples.
The 4K samples skipped 25 source frames on Fast and 98 on High; the source itself produced about
38–39 fps. Readback and conversion cost matter at this size. Fast remains the default.

A subsequent 1080p comparison ran each encoder mode separately on the same rig, with the same
8 Mbit/s ceiling and six-second text, scroll and motion samples. NVENC delivered about 50–51 fps;
explicit CPU encoding with x264 delivered about 23–27 fps at its 30 Hz compositor cadence.
This compares the supported modes, not encoders at an equal source rate.

One-second resource samples across those runs, including setup and scene transitions:

| Mode | Server CPU median / peak | Server RSS median / peak | GPU utilization median / peak | NVENC utilization median / peak | GPU memory median / peak |
|---|---|---|---|---|---|
| NVENC | 49% / 85% | 456 / 548 MiB | 9% / 14% | 13% / 46% | 399 / 507 MiB |
| x264 with NVIDIA rendering | 76% / 114% | 374 / 387 MiB | 21% / 30% | 0% / 0% | 182 / 194 MiB |

CPU percentages use one core as 100% and cover the Elsewhere process, including its encoder
threads. GPU figures cover the whole device, including the source application's rendering.
Readback time was not isolated; conversion and encoding share the worker timing above.

Six-second AV1 samples on the Ada rig used 1920×1080 text, scrolling and motion at an 8 Mbit/s
ceiling. Fast delivered 53.5–53.7 fps with conversion/encode p50 5.3–5.5 ms and p95 5.7–5.9 ms;
High delivered 53.5–53.8 fps with p50 6.5–6.6 ms and p95 7.0–7.8 ms. No source gaps, losses,
drops or decode errors occurred. End-to-end p50 was 79–99 ms and p95 85–108 ms with the source
and browser on the same host. These samples do not measure WAN latency or maximum GPU throughput.

## Docker graphics verification

`Dockerfile.nvidia` extends the standard image with a link from
`/usr/lib/gbm/nvidia-drm_gbm.so` to the Ubuntu/Debian runtime path,
`/usr/lib/x86_64-linux-gnu/gbm/nvidia-drm_gbm.so`. On Arch hosts, the NVIDIA runtime replaces
that link with its native `../libnvidia-allocator.so.1` link. Both paths were checked on their
respective hosts. The driver backend and allocator library come from the same host installation;
no driver version is built into the image. Xwayland starts with only `PATH` and `XDG_RUNTIME_DIR`,
so its backend must be found in the default GBM directory; `GBM_BACKENDS_PATH` does not reach it.

Use `--runtime=nvidia --gpus all` with the capabilities in the README. On the Ubuntu rig,
`--gpus all` with the default runc runtime exposed NVENC but omitted NVIDIA EGL vendor and Vulkan
ICD registrations. Even with the NVIDIA runtime, the Arch default GBM directory did not find the
Ubuntu backend. Both conditions must be correct to obtain NVIDIA rendering.

Require a `GL Renderer:` line naming NVIDIA in the compositor log in addition to the NVENC probe. For an
accelerated X11 client, run `glxinfo -B` inside the Elsewhere session and require NVIDIA direct
rendering. When testing NVIDIA WebGPU, use `ELSEWHERE_BROWSER_NVIDIA=1` below: it enables the
Chromium Vulkan/ANGLE path and asserts the vendor and non-fallback status of the device that
actually paints each WebGPU viewer. A successful `nvidia-smi`, encoder probe or SwiftShader
WebGPU check alone does not satisfy these rendering checks.

## Running the checks

Build the viewer and release binary in the Docker build image. Mount that checkout at `/src` in
a GPU runtime image. Start it with `--runtime=nvidia --gpus all` and the README capabilities;
on Ubuntu/Debian hosts it needs the same GBM link as `Dockerfile.nvidia`. Include Chromium,
Playwright dependencies, FFmpeg, Foot, Wayland development
tools, X11 development headers, a C compiler, Mesa demo clients (`glxinfo`, `glxgears`, `eglgears_wayland`), GTK 3 and Python GI/Cairo. From `/src/web`:

```sh
ELSEWHERE_RENDER_NODE=/dev/dri/renderD129 node checks/gpu-surfaces.mjs
ELSEWHERE_RENDER_NODE=/dev/dri/renderD129 ELSEWHERE_CODEC=hevc node checks/gpu-surfaces.mjs
ELSEWHERE_RENDER_NODE=/dev/dri/renderD129 ELSEWHERE_BROWSER_RENDER_NODE=/dev/dri/renderD129 ELSEWHERE_BROWSER_NVIDIA=1 ELSEWHERE_CODEC=av1 node checks/gpu-surfaces.mjs
ELSEWHERE_RENDER_NODE=/dev/dri/renderD129 node checks/hevc-browser.mjs
ELSEWHERE_RENDER_NODE=/dev/dri/renderD129 node checks/screenshot-sizing.mjs
ELSEWHERE_RENDER_NODE=/dev/dri/renderD129 node checks/thumbnails.mjs
ELSEWHERE_RENDER_NODE=/dev/dri/renderD129 python ../crates/elsewhere-compositor/checks/x11-placement.py
ELSEWHERE_RENDER_NODE=/dev/dri/renderD129 python ../crates/elsewhere-compositor/checks/decorations.py
ELSEWHERE_RENDER_NODE=/dev/dri/renderD129 node checks/encoding-effort.mjs
ELSEWHERE_RENDER_NODE=/dev/dri/renderD129 node checks/codec-recovery.mjs
ELSEWHERE_RENDER_NODE=/dev/dri/renderD129 node checks/fixed-screen-size.mjs
ELSEWHERE_RENDER_NODE=/dev/dri/renderD129 BROADCAST_GPU=1 node checks/broadcasts.mjs
ELSEWHERE_RENDER_NODE=/dev/dri/renderD129 EFFORT_CODECS=h264 EFFORT_SIZE=1920x1080 EFFORT_BITRATE=8000 node checks/effort-benchmark.mjs
```

Replace the node with the GPU being tested. The AV1 command requires an AV1-capable NVIDIA GPU.
The surface check requires NVIDIA GLES whenever the source uses NVENC. `ELSEWHERE_BROWSER_RENDER_NODE` selects the separate
browser host for the surface/HEVC checks and defaults to `/dev/dri/renderD128`. Run checks that use
the same listen ports sequentially. The decoration fixture also needs fetched Wayland protocol
sources in `CARGO_HOME/registry/src`. For the compositor retry fixture, set `ELSEWHERE_MEMORY_FRAMES=1` with the NVIDIA render node.
`ELSEWHERE_TEST_CAPACITY` optionally adds viewers until NVENC
rejects another session and verifies retry after releasing sessions; choose a count above the
particular driver's limit and run without competing GPU checks.
