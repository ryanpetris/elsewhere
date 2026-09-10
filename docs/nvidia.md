# NVIDIA validation

NVIDIA uses GLES texture rendering, synchronized XRGB readback, CPU conversion to limited-range
BT.709 YUV420P, and FFmpeg NVENC. The renderer and encoder are matched by PCI address.
See the [NVIDIA setup](../README.md#nvidia) for native and Docker requirements.

## Hardware evidence

Docker checks used an RTX 3070 Ti Laptop GPU, NVIDIA 610.57.04, FFmpeg 9.0.1, Arch Linux and
Chromium 152. The headed viewer ran on a separate Intel GPU so Chromium could expose its HEVC
decoder. H.264 and HEVC passed. Startup checks an initial key, a delta frame and a requested recovery key
with increasing timestamps; NVENC forces IDRs for all three candidate codecs. The AV1 encoder probe correctly rejected this GPU; AV1 encoding
still needs validation on hardware that supports it. Multiple physical NVIDIA GPUs and older
FFmpeg/driver combinations were not tested. The tested FFmpeg library embeds a minimum NVIDIA
driver requirement of 610.00, corresponding to its NVENC 13.1 build. The requirement comes from
FFmpeg's build-time NVENC headers, not Elsewhere's build. Other FFmpeg packages can require a
different driver. [FFmpeg's driver/API checks](https://github.com/FFmpeg/FFmpeg/blob/n9.0.1/libavcodec/nvenc.c#L215)
report the required API and minimum driver when initialization fails.

| Surface or behavior | Check |
|---|---|
| Accelerated Wayland/Xwayland clients | `eglgears_wayland` and `glxgears` animate in window video and produce PNGs; `glxinfo` confirms NVIDIA direct rendering |
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
| Repeated viewer resize/effort changes and teardown | `viewer-lifecycle.mjs`, five isolated cycles, FDs and threads return to baseline |
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

The isolated lifecycle run kept file descriptors and threads at their idle baseline; retained RSS
rose from about 401 to 429 MiB across five cycles. An earlier run alongside other GPU checks
exceeded the fixture's 64 MiB growth bound on cycle three. The isolated pass does not establish
a memory bound under every competing workload.

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

## Running the checks

Build the viewer and release binary in the Docker build image. Mount that checkout at `/src` in
a GPU runtime image containing Chromium, Playwright dependencies, FFmpeg, Foot, Wayland development
tools, a C compiler, Mesa demo clients (`glxinfo`, `glxgears`, `eglgears_wayland`), GTK 3 and Python GI/Cairo. From `/src/web`:

```sh
ELSEWHERE_RENDER_NODE=/dev/dri/renderD129 node checks/gpu-surfaces.mjs
ELSEWHERE_RENDER_NODE=/dev/dri/renderD129 ELSEWHERE_CODEC=hevc node checks/gpu-surfaces.mjs
ELSEWHERE_RENDER_NODE=/dev/dri/renderD129 node checks/hevc-browser.mjs
ELSEWHERE_RENDER_NODE=/dev/dri/renderD129 node checks/screenshot-sizing.mjs
ELSEWHERE_RENDER_NODE=/dev/dri/renderD129 node checks/thumbnails.mjs
ELSEWHERE_RENDER_NODE=/dev/dri/renderD129 node checks/encoding-effort.mjs
ELSEWHERE_RENDER_NODE=/dev/dri/renderD129 node checks/codec-recovery.mjs
ELSEWHERE_RENDER_NODE=/dev/dri/renderD129 node checks/fixed-screen-size.mjs
ELSEWHERE_RENDER_NODE=/dev/dri/renderD129 BROADCAST_GPU=1 node checks/broadcasts.mjs
ELSEWHERE_RENDER_NODE=/dev/dri/renderD129 EFFORT_CODECS=h264 EFFORT_SIZE=1920x1080 EFFORT_BITRATE=8000 node checks/effort-benchmark.mjs
```

Replace the node with the GPU being tested. `ELSEWHERE_BROWSER_RENDER_NODE` selects the separate
browser host for the surface/HEVC checks and defaults to `/dev/dri/renderD128`. Run checks that use
the same listen ports sequentially. For the compositor retry fixture, set `ELSEWHERE_MEMORY_FRAMES=1` with the NVIDIA render node.
`ELSEWHERE_TEST_CAPACITY` optionally adds viewers until NVENC
rejects another session and verifies retry after releasing sessions; choose a count above the
particular driver's limit and run without competing GPU checks.
