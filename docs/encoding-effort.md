# Encoding effort

The viewer's Effort selector controls encoding time separately from Quality, which selects a bitrate
ceiling. Fast preserves the default speed settings. Balanced and High can improve compression at the
same target bitrate, but can also lower frame rate or increase delay. A higher setting does not
promise a better picture for every scene.

Changes restart that viewer's desktop or window stream immediately.
The browser remembers the choice for reloads and reconnects, sharing the saved preference across
desktop and window tabs. Codec changes use the saved effort with
the new encoder's mapping. Changing effort preserves the selected ceiling and the congestion
controller's current target and recovery state. During startup, the shared compositor supplies full
frames until the encoder produces a keyframe; other attached viewers share that rendering cost.

## Encoder mappings

The worker applies these settings before opening the encoder and rejects unused FFmpeg options.
VA effort uses the actual quality range reported by the selected device. An unavailable setting
retains the requested preference and reports unavailable, with no claim that it was applied.

| Encoder | Property | Fast | Balanced | High |
|---|---|---|---|---|
| VP8, libvpx | `cpu-used` | 8 | 4 | 2 |
| VP9, libvpx | `cpu-used` | 8 | 6 | 5 |
| H.264, x264 | `preset` | superfast | fast | medium |
| HEVC, x265 | `preset` | ultrafast | superfast | fast |
| AV1, libaom realtime | `cpu-used` | 8 | 6 | 4 |
| VA hardware encoders | `compression_level` | driver maximum | ceiling of half maximum | 1 |
| H.264, OpenH264 | unavailable | encoder default | encoder default | encoder default |

Rate control and low latency settings still apply, including no B-frames and the libvpx real-time
deadline. These are encoder effort settings, not a constant-quality rate control mode. Encoder target
bitrate and measured encoded throughput can differ, especially on a static picture.
The native encoder uses 90% of the stream target. The remaining margin lets variable frame sizes
share the worker's byte budget without immediately reducing frame rate.
VP9 uses `overshoot-pct=0` and `undershoot-pct=100` for native buffer compensation. A full buffer does
not add bits to the frame target, while a depleted buffer permits a stronger reduction. Encoded
packet sizes can still vary.

## Docker checks

Build the release binary and browser assets in the project Docker build stage. Mount the checkout
into a runtime image with Chromium, foot and FFmpeg installed. From `web`,
run `npm run check:encoding-effort` and `npm run check:effort-benchmark`. `ELSEWHERE_BINARY` can point to
a release binary copied from the build image. The selection check covers every codec shared by the
server and browser, all three effort choices, actual decoded frames, reloads, socket reconnects and
congestion adaptation for desktop and window streams.

Set `ELSEWHERE_RENDER_NODE` to exercise a GPU, and `ELSEWHERE_SOFTWARE_ENCODING=1` to combine GPU
rendering with CPU encoding. `ELSEWHERE_CODEC` chooses the initial codec and `ELSEWHERE_TEST_PORT` separates
concurrent correctness checks. With a build that exposes OpenH264 without x264, set
`ELSEWHERE_EXPECT_UNSUPPORTED=1` to check unavailable effort status and saved choice on both stream
types. Encoder discovery can also be masked by an external check shim without changing the application.

For HEVC, run `node checks/hevc-browser.mjs` in the GPU image. The check runs headed Chromium on a
dedicated Wayland desktop so the browser can use its native hardware decoder. It checks desktop and
window playback, requested recovery keys and quality/effort changes, decoding each resulting key in a
fresh WebCodecs decoder. Chromium's headless mode may omit HEVC even when its headed mode supports it.

The benchmark launches a real Wayland Chromium canvas inside the remote desktop. A headless Chromium
viewer decodes and paints its video over WebSocket. Software rendering uses a 30 Hz compositor clock,
1280 by 720 output, a fixed 4 Mbit/s stream target and ceiling, and a 3.6 Mbit/s native encoder target.
Each text, scrolling or moving-shapes scene
starts a fresh viewer session and warms up for 2.5 seconds before a six-second sample, comparing
Fast and High within each codec. The benchmark suppresses browser congestion reports so startup delay
does not lower the target; the selection check exercises adaptation separately. Server transport
pressure can still adapt, so every reported stream target during the sample must remain at 4 Mbit/s.
`EFFORT_CODECS=vp8,h264`, `EFFORT_SCENES=motion` and `EFFORT_SECONDS=6` can narrow or lengthen a run.
`EFFORT_SIZE=1920x1080` changes the source and encoded dimensions; `EFFORT_BITRATE` sets the stream target
and ceiling in kbit/s. Results record the actual encoder, stream target, configured native target and
buffer size, binary hash and installed tool versions. The native values come from the encoder's
configuration trace and must remain unchanged during each sample.

The scene paints a wall clock and frame sequence into each frame. The viewer reads that small stripe
at paint time to measure source-to-canvas delay and sequence gaps. The source sequence span also
reports observed production rate separately from the nominal compositor clock. Sequence gaps, repeats
and regressions describe the decoded marker, which can itself suffer compression artifacts; they are
separate from the browser drop counters. This includes capture, encode,
transport, decode and browser paint submission, plus the same stripe readback for every setting. It
does not include physical display scanout or input-to-response delay. Encoded payload bytes give the
actual bitrate. Browser counters distinguish protocol sequence gaps, delta-drop events and decode
errors. A delta-drop event starts keyframe recovery after a sequence gap or a decoder queue above four
frames. Further deltas skipped while waiting for the key do not increase that counter.

The worker's `ffmpeg encoded` trace reports conversion plus encoding time as `encode_us` and time
from raw submission to packet as `submit_to_packet_us`. These are elapsed times, not CPU time.
The 30 Hz frame budget is 33.3 ms. The benchmark retains JSON results,
traces, decoded screenshots and reference images in its printed temporary directory. Screenshot RGB
PSNR excludes the clock stripe and compares against the scene drawn at the decoded timestamp. It is
a single-frame measure, including color conversion. Each sample captures the first decoded frame at
or after its next phase-30 target in the repeating animation and records the actual phase and any
skipped source frames. Fast and High can therefore capture different phases; their screenshot scores
cannot establish a general quality ranking.

## Software measurements

These Docker measurements use an Intel Core Ultra 7 155H, FFmpeg 9.0.1, libvpx 1.17.0,
x264 0.165.3222, libaom 3.15.0 and Chromium 152.0.7977.82. Other test workloads were stopped.
Each row compares Fast / High in that order, with six-second samples, software rendering,
WebSocket transport, a fixed 4 Mbit/s stream target and a 3.6 Mbit/s native target with a 100 ms buffer.
These are short effort comparisons;
[stream reliability](stream-reliability.md) describes the longer network tests.

At 1280 by 720:

| Codec / scene | Actual kbit/s | Painted fps | Source gaps | Encode p95, ms | Paint age p95, ms | PSNR, dB |
|---|---:|---:|---:|---:|---:|---:|
| VP8 / text | 2289 / 3164 | 27.6 / 27.6 | 0 / 0 | 9.2 / 9.0 | 127 / 126 | 37.7 / 37.6 |
| VP8 / scroll | 3524 / 3775 | 27.0 / 25.0 | 4 / 17 | 10.6 / 12.7 | 127 / 131 | 39.4 / 39.5 |
| VP8 / motion | 3662 / 3656 | 27.8 / 27.7 | 0 / 0 | 11.5 / 11.4 | 130 / 129 | 22.7 / 22.7 |
| H.264 / text | 1127 / 80 | 27.6 / 27.7 | 0 / 0 | 6.5 / 8.3 | 123 / 124 | 37.9 / 38.0 |
| H.264 / scroll | 2713 / 2425 | 27.7 / 27.6 | 0 / 0 | 7.0 / 12.0 | 124 / 129 | 39.9 / 40.0 |
| H.264 / motion | 2887 / 2922 | 27.6 / 27.6 | 0 / 0 | 6.9 / 11.0 | 124 / 128 | 22.8 / 22.8 |
| VP9 / text | 3212 / 3274 | 27.6 / 27.6 | 0 / 0 | 9.2 / 10.0 | 127 / 128 | 37.5 / 37.5 |
| VP9 / scroll | 3409 / 3388 | 27.6 / 27.6 | 0 / 0 | 10.8 / 10.6 | 128 / 129 | 39.9 / 40.0 |
| VP9 / motion | 3608 / 3562 | 27.5 / 27.5 | 0 / 0 | 12.8 / 15.1 | 131 / 134 | 22.7 / 22.7 |
| AV1 / text | 2178 / 202 | 27.6 / 27.8 | 0 / 0 | 14.6 / 16.9 | 135 / 134 | 37.7 / 38.1 |
| AV1 / scroll | 1750 / 1794 | 25.6 / 27.3 | 8 / 0 | 16.0 / 34.3 | 137 / 157 | 38.4 / 40.2 |
| AV1 / motion | 3275 / 2153 | 27.5 / 19.7 | 0 / 46 | 17.8 / 71.7 | 141 / 225 | 22.7 / 22.7 |

At 1920 by 1080, software AV1 uses libaom:

| Codec / scene | Actual kbit/s | Painted fps | Source gaps | Encode p95, ms | Paint age p95, ms | PSNR, dB |
|---|---:|---:|---:|---:|---:|---:|
| AV1 / text | 993 / 890 | 25.0 / 25.0 | 9 / 9 | 16.6 / 16.7 | 146 / 170 | 38.8 / 38.9 |
| AV1 / scroll | 2087 / 2080 | 26.3 / 26.1 | 0 / 0 | 21.2 / 22.7 | 163 / 168 | 39.9 / 40.8 |
| AV1 / motion | 3092 / 3052 | 26.0 / 26.0 | 0 / 0 | 35.4 / 43.7 | 192 / 200 | 22.7 / 22.7 |

The source produced about 27.6 fps at 720p and 26 fps at 1080p despite its nominal 30 Hz clock.
All samples had zero invalid markers and no repeated or regressing source sequences. Browser
transport-loss, decoder-drop and decode-error counters stayed zero. Every screenshot in these tables
captured phase 30 without skipping its target phase.

AV1 High at 720p motion had 46 source-sequence gaps and painted 19.7 fps; its p95 encode time exceeded
the 33.3 ms frame budget. At 1080p, both AV1 motion settings exceeded that budget at p95. Rate admission
can also skip source frames when packet sizes exceed the byte budget, even when most encode times
fit the frame budget. The source-gap column counts missing source markers separately from browser drops.

Separate 60-second checks used the same stream and native targets. VP8 Fast motion delivered all
observed source frames at 27.6 fps and 3.65 Mbit/s. Two VP9 High scrolling runs painted 27.6 and
27.3 fps at 3.40 and 3.51 Mbit/s, with source rates of 27.6 fps. The first had no source gaps; the
second had 18 near startup and a largest gap between encoded packets of 249 ms during the first
ten-second interval of its native trace. Its remaining five intervals sustained 27.6 to 27.7 encoded fps.
All three runs had zero browser loss, drops or decode errors and no repeated or regressing markers.

The inspected AV1 text and H.264 and VP9 scrolling captures remain readable. The motion captures
preserve the scene's shapes, with softer edges than the reference. H.264 High used fewer bits for
static text and scrolling, with a small screenshot-score improvement and more encode time.
AV1 High substantially reduced static-text traffic at 720p, but its motion sample lost throughput
without a useful screenshot-score gain. VP8 and VP9 showed little consistent benefit from High.
Fast remains the default; higher effort can trade frame rate for compression, and these samples do
not establish a general quality ranking.
