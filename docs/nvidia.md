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
report the required API and minimum driver when initialization fails. FFmpeg error output remains
visible, including expected probe failures for unsupported optional codecs. The verified encoder
list reports which codecs are usable.

`nvidia-startup.py` checks the release binary's discovery and failure paths. Driver stubs
exercise CUDA ordinals zero and one with distinct device handles, an absent PCI match, missing
CUDA/NVENC libraries and an NVENC API mismatch. Real-device checks also reject a missing DRM
node and hidden CUDA access. Startup fails with the relevant diagnostic; encoder-probe failures
also suggest `--software-encoding`. FFmpeg error output includes its required API and minimum driver. These injected checks do not
establish encoding on two physical NVIDIA GPUs or an older driver installation.

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
| Repeated viewer resize/effort changes and teardown | `viewer-lifecycle.mjs`, two 40-cycle NVIDIA runs pass FD/thread recovery and the documented RSS bounds; see the memory section |
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

### Browser color fidelity

Chromium 152's headed Intel hardware decode path can convert limited-range BT.709 to RGB
with BT.601 coefficients. The same captured H.264 recovery packet produced these mixed-color
samples in Docker; the source PNG is RGB (229, 42, 97):

| Decoder/output path | Center RGB |
|---|---|
| Independent FFmpeg RGB decode | (229, 41, 96) |
| Headless software WebCodecs | (230, 43, 96) |
| Headed software WebCodecs | (230, 42, 97) |
| Headed hardware WebCodecs, Canvas2D and `copyTo` RGBA | (214, 19, 96) |

Software decoding exposes I420 samples Y=90, U=133, V=208 with BT.709 metadata. The hardware
path exposes BGRX: the wrong RGB values are already present in `VideoFrame.copyTo`, and
constructing a memory-backed frame from those bytes preserves them. The shift precedes the
viewer's Canvas2D/WebGPU output. It also reproduces with Intel VA-API encoding and NVIDIA HEVC;
`video-colors.mjs` covers the Intel H.264 case, and a separate manual HEVC measurement
shows that the shift is not specific to H.264. The BT.601 interpretation of those YUV samples produces the shifted
RGB values. Chromium's [VA-API blit](https://chromium.googlesource.com/chromium/src/+/refs/heads/main/media/gpu/vaapi/vaapi_wrapper.cc)
leaves its input/output color standards unspecified, consistent with that measurement; the
exact upstream call responsible has not been instrumented.

For color-sensitive viewing on the affected Chromium/Intel setup, launch a separate browser
session with `chromium --user-data-dir=/tmp/elsewhere-browser --disable-accelerated-video-decode`
and select H.264. This uses software video decoding while retaining GPU rendering. A normal
browser launch can reuse an existing process and ignore new flags, so use a separate profile.
HEVC may not be available with hardware decoding disabled. The source compositor and NVENC
encoder still use the NVIDIA GPU.

`video-colors.mjs` replays one captured packet through FFmpeg and software browser paths,
including a headed browser with this flag, and requires the mixed color within four RGB values.
The headed workaround check also requires GPU compositing, accelerated Canvas2D, a hardware GL
renderer and hardware video decoding disabled. The tested browser reported Intel Iris Xe through ANGLE.
`--diagnose` also records the native headed hardware path without treating its known color
error as a passing fidelity check. The display-edge checks use coarse tolerances for geometry,
not color fidelity. [Issue #130](https://github.com/ryanpetris/elsewhere/issues/130) records the
isolation and measured workaround.

### Viewer lifecycle memory

`viewer-lifecycle.mjs` checks FD/thread recovery and retained desktop allocation geometry from
the first idle checkpoint. It runs ten complete warmup cycles followed by five measured cycles;
`ELSEWHERE_LIFECYCLE_CYCLES=30` requests thirty measured cycles. Idle RSS must stay within
192 MiB of the first idle checkpoint throughout the run, and within 64 MiB of the checkpoint
after the tenth warmup cycle. The first bound catches growth during warmup too.

Isolated long runs measured first-to-peak idle RSS growth between 101 and 119 MiB.
The 192 MiB whole-run bound allows that measured allocator retention plus at least 64 MiB;
the stricter post-warmup bound checks subsequent growth. In the 32-cycle allocation diagnostic,
RSS was 448 MiB after the first cycle, 555 MiB after ten cycles and 562 MiB at the end.
Free malloc chunks grew from 102 to 201 MiB. Allocated arena chunks plus malloc-mapped
allocations grew from 39.2 to 40.0 MiB; GPU memory stayed at 260 MiB. Resident anonymous memory
grew from 160 to 266 MiB, tracking the increase in free allocator chunks. These measurements
support allocator caching as the main source of retained RSS, rather than unreleased GPU sessions.
They establish behavior over the measured workload, not an indefinite memory guarantee.
The [per-cycle measurements](nvidia-lifecycle.csv) include two fresh 40-cycle runs that enforced both limits. The stock run ended 6.7 MiB above its tenth-cycle
baseline; the allocation-observed run ended 10.3 MiB above it. Growth slowed but did not stop.
In the observed run, GPU memory fell from 987 MiB active to 260 MiB idle on every cycle;
malloc-reported allocations fell from about 125 MiB active to 40 MiB idle. FD/thread recovery,
stream recovery and final-picture assertions passed in both runs. After warmup, the observed
run's anonymous memory rose another 5.4 MiB and file-backed proportional resident memory rose
4.9 MiB. This later growth is not fully attributed to allocator retention.
The same assertions passed on Intel VA-API, Mesa CPU-only rendering and NVIDIA rendering with
CPU encoding. The complete per-cycle CSV leaves allocator fields blank when the observer was
not enabled.

| Mode | Cycles | First idle MiB | After warmup MiB | Peak idle MiB | Maximum post-warmup growth MiB |
|---|---|---|---|---|---|
| NVIDIA NVENC | 40 | 521.6 | 616.0 | 622.7 | 6.7 |
| NVIDIA NVENC with allocator observer | 40 | 447.6 | 545.9 | 556.2 | 10.3 |
| Intel VA-API | 15 | 295.8 | 313.6 | 314.0 | 0.4 |
| CPU only | 15 | 232.7 | 275.6 | 283.8 | 2.8 |
| NVIDIA rendering with CPU encoding | 15 | 295.5 | 280.5 | 329.0 | 23.4 |

The NVIDIA CPU-encoding run oscillated between idle checkpoints; its maximum increase is not a
steady growth rate. It ended 1.5 MiB above its warmup checkpoint.
[Issue #131](https://github.com/ryanpetris/elsewhere/issues/131) records the investigation.

`--allocator` builds a glibc observer and records fresh active/idle `mallinfo2` snapshots,
`smaps_rollup`, and device memory beside each cycle. The observer walks allocator bins under
arena locks once per second, which can affect timing; compare against the default uninstrumented
run. `allocated` counts arena allocations and `mmap` counts malloc-mapped allocations. `free`
counts free chunks, including nonresident pages, so it is not a measure of resident free memory.
See the [glibc allocator statistics](https://sourceware.org/glibc/manual/latest/html_node/Statistics-of-Malloc.html).

## Performance samples

The [complete measurements](nvidia-performance.json) contain 36 ten-second samples on the
RTX 3070 Ti Laptop GPU and Core i7-12700H: H.264 text, scrolling and motion, Fast/High effort,
1080p/4K, and one/three independent viewers. Each case ran sequentially in Docker without other
validation workloads. The source Chromium, server and decoding browsers share the host.
1080p uses an 8 Mbit/s ceiling per viewer; 4K uses 25 Mbit/s. These are measured workloads,
not a sustained throughput guarantee or WAN latency measurements.

Ranges below span the three scenes and, for fps and latency, all viewers. Timing pairs are
p50 / p95 milliseconds. Readback includes waiting for pending GPU compositing, framebuffer
transfer, mapping and the CPU row copy. It is not an isolated PCIe transfer measurement.
Conversion/encoding timings pool all viewer workers; per-viewer fps and latency remain separate
in the JSON. The benchmark slices trace/resource measurements before PNG export and PSNR work.

| Encoder, size, viewers | Effort | Delivered fps per viewer | GPU wait + readback | Conversion | Encode only | Source-to-paint |
|---|---|---|---|---|---|---|
| NVENC, 1080p, 1 | Fast | 49.3-50.8 | 2.4-2.7 / 3.0-3.8 | 4.1-4.5 / 7.0-7.4 | 3.5-3.6 / 3.8 | 93.0-108.0 / 103.0-127.0 |
| NVENC, 1080p, 1 | High | 50.2-50.8 | 2.4-2.6 / 2.9-3.0 | 4.9-6.5 / 7.2-8.0 | 9.1-9.4 / 9.2-9.6 | 109.0-113.0 / 119.0-135.0 |
| CPU, 1080p, 1 | Fast | 22.6-27.0 | 2.9-10.2 / 3.7-11.8 | 3.9-7.0 / 6.5-8.1 | 3.9-5.0 / 4.5-7.6 | 166.0-217.0 / 170.0-227.0 |
| CPU, 1080p, 1 | High | 22.9-23.1 | 9.7-10.0 / 10.0-10.5 | 3.6-5.2 / 5.8-7.3 | 6.1-9.7 / 7.9-14.4 | 214.0-217.0 / 221.0-226.0 |
| NVENC, 1080p, 3 | Fast | 49.4-50.4 | 2.6-2.8 / 3.2-3.9 | 4.5-5.5 / 7.9-10.0 | 5.3-5.8 / 8.1-8.6 | 99.0-111.0 / 114.0-132.0 |
| NVENC, 1080p, 3 | High | 50.1-51.2 | 2.4-2.7 / 2.8-3.3 | 5.4-6.0 / 8.5-9.8 | 10.2-10.8 / 14.3-15.3 | 110.0-116.0 / 119.0-138.0 |
| CPU, 1080p, 3 | Fast | 22.9-26.9 | 3.0-9.6 / 3.7-10.3 | 3.7-7.0 / 7.2-10.5 | 6.0-7.7 / 8.1-11.2 | 170.0-218.0 / 176.0-230.0 |
| CPU, 1080p, 3 | High | 22.8-23.0 | 9.5-9.8 / 10.0-10.3 | 3.8-3.9 / 7.0-7.8 | 11.5-20.5 / 14.3-31.3 | 218.0-230.0 / 225.0-244.0 |
| NVENC, 4K, 1 | Fast | 33.3-33.8 | 8.9 / 12.0-13.1 | 16.0-16.4 / 21.9-22.4 | 12.8-13.0 / 13.5-14.2 | 188.0-200.0 / 204.0-220.0 |
| NVENC, 4K, 1 | High | 17.3-19.1 | 8.2-9.2 / 12.2-13.0 | 17.3-22.1 / 23.2-29.0 | 34.7-35.8 / 35.7-36.5 | 218.0-228.0 / 239.0-242.0 |
| NVENC, 4K, 3 | Fast | 27.3-28.6 | 10.8-11.8 / 15.3-16.6 | 19.4-20.2 / 27.4-28.6 | 13.2-13.9 / 20.0-21.3 | 219.0-253.0 / 240.0-291.0 |
| NVENC, 4K, 3 | High | 16.8-17.0 | 8.9-9.2 / 11.8-13.0 | 17.0-18.9 / 24.1-26.4 | 40.3-42.0 / 44.1-44.7 | 223.0-229.0 / 237.0-255.0 |

Server CPU percentages use one core as 100% and include its encoder threads. They exclude the
source and viewer browsers. GPU counters cover the whole device, including source rendering.
CPU columns show the range of scene medians / highest sample; memory and GPU columns show
peaks. Full median/peak counters and delivered payload bitrate for every viewer are in the JSON.
The low CPU High payload rates come from the nearly static text scene, which compresses well
below the configured ceiling while continuing to deliver frames.

| Encoder, size, viewers | Effort | Server CPU % | Server RSS MiB | GPU / NVENC % | GPU memory MiB | Payload Mbit/s per viewer |
|---|---|---|---|---|---|---|
| NVENC, 1080p, 1 | Fast | 43-46 / 53 | 477 | 9 / 15 | 399 | 5.89-6.10 |
| NVENC, 1080p, 1 | High | 46-55 / 58 | 513 | 10 / 44 | 399 | 6.02-6.12 |
| CPU, 1080p, 1 | Fast | 61-71 / 73 | 396 | 30 / 0 | 182 | 1.22-4.55 |
| CPU, 1080p, 1 | High | 80-103 / 106 | 431 | 30 / 0 | 182 | 0.04-4.41 |
| NVENC, 1080p, 3 | Fast | 101-120 / 131 | 902 | 13 / 40 | 828 | 5.93-6.04 |
| NVENC, 1080p, 3 | High | 116-126 / 134 | 836 | 12 / 81 | 828 | 6.01-6.16 |
| CPU, 1080p, 3 | Fast | 206-230 / 242 | 711 | 29 / 0 | 172 | 1.45-4.65 |
| CPU, 1080p, 3 | High | 295-499 / 537 | 729 | 30 / 0 | 172 | 0.05-4.47 |
| NVENC, 4K, 1 | Fast | 101-103 / 106 | 815 | 20 / 39 | 1003 | 12.48-12.59 |
| NVENC, 4K, 1 | High | 75-84 / 87 | 768 | 19 / 64 | 1003 | 6.48-7.13 |
| NVENC, 4K, 3 | Fast | 251-257 / 259 | 1493 | 26 / 79 | 2005 | 10.22-10.72 |
| NVENC, 4K, 3 | High | 141-155 / 162 | 1584 | 21 / 100 | 2005 | 6.31-6.48 |

Every viewer reported zero decoder errors, transport losses and delta-drop events in these
samples. Source frames can still be skipped: delivered fps is the measured outcome. NVENC's
nominal compositor cadence is 60 Hz; explicit CPU encoding retains its 30 Hz cadence. The
comparison measures the supported modes at their respective source rates. Fast is the default;
High increases encoding time and reduces delivered throughput under the tested 4K loads.

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

Require a `GL Vendor:` line naming NVIDIA in the compositor log in addition to the NVENC probe. For an
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
ELSEWHERE_RENDER_NODE=/dev/dri/renderD129 node checks/video-colors.mjs --diagnose
ELSEWHERE_RENDER_NODE=/dev/dri/renderD129 python ../crates/elsewhere-stream/checks/nvidia-startup.py
ELSEWHERE_RENDER_NODE=/dev/dri/renderD129 node checks/hevc-browser.mjs
ELSEWHERE_RENDER_NODE=/dev/dri/renderD129 node checks/screenshot-sizing.mjs
ELSEWHERE_RENDER_NODE=/dev/dri/renderD129 node checks/thumbnails.mjs
ELSEWHERE_RENDER_NODE=/dev/dri/renderD129 python ../crates/elsewhere-compositor/checks/x11-placement.py
ELSEWHERE_RENDER_NODE=/dev/dri/renderD129 python ../crates/elsewhere-compositor/checks/decorations.py
ELSEWHERE_RENDER_NODE=/dev/dri/renderD129 ELSEWHERE_LIFECYCLE_CYCLES=30 node checks/viewer-lifecycle.mjs
ELSEWHERE_RENDER_NODE=/dev/dri/renderD129 ELSEWHERE_LIFECYCLE_CYCLES=30 node checks/viewer-lifecycle.mjs --allocator
ELSEWHERE_RENDER_NODE=/dev/dri/renderD129 node checks/encoding-effort.mjs
ELSEWHERE_RENDER_NODE=/dev/dri/renderD129 node checks/codec-recovery.mjs
ELSEWHERE_RENDER_NODE=/dev/dri/renderD129 node checks/fixed-screen-size.mjs
ELSEWHERE_RENDER_NODE=/dev/dri/renderD129 BROADCAST_GPU=1 node checks/broadcasts.mjs
ELSEWHERE_RENDER_NODE=/dev/dri/renderD129 EFFORT_CODECS=h264 EFFORT_SIZE=1920x1080 EFFORT_BITRATE=8000 EFFORT_SECONDS=10 node checks/effort-benchmark.mjs
```

For the 1080p performance comparison, run the benchmark with `EFFORT_VIEWERS=1` and `3`,
then repeat both with `ELSEWHERE_SOFTWARE_ENCODING=1`. For the two NVENC 4K cases, use
`EFFORT_SIZE=3840x2160 EFFORT_BITRATE=25000` with one and three viewers. Each invocation
measures text, scrolling and motion at Fast and High effort. The JSON and original trace files
remain in the artifact directory printed by the check.

The lifecycle and benchmark checks force Mesa software rendering for `ELSEWHERE_RENDER_NODE=none`
and require llvmpipe or softpipe in the compositor log. Omitting a DRM node alone can still select
NVIDIA through EGL in a GPU-enabled container.

Replace the node with the GPU being tested. The AV1 command requires an AV1-capable NVIDIA GPU.
The surface check requires NVIDIA GLES whenever the source uses NVENC. `ELSEWHERE_BROWSER_RENDER_NODE` selects the separate
browser host for the surface/HEVC checks and defaults to `/dev/dri/renderD128`. Run checks that use
the same listen ports sequentially. The decoration fixture also needs fetched Wayland protocol
sources in `CARGO_HOME/registry/src`. For the compositor retry fixture, set `ELSEWHERE_MEMORY_FRAMES=1` with the NVIDIA render node.
`ELSEWHERE_TEST_CAPACITY` optionally adds viewers until NVENC
rejects another session and verifies retry after releasing sessions; choose a count above the
particular driver's limit and run without competing GPU checks.
