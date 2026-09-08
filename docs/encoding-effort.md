# Encoding effort

The viewer's Effort selector controls encoding time separately from Quality, which selects a bitrate
ceiling. Fast preserves the default speed settings. Balanced and High can improve compression at the
same target bitrate, but can also lower frame rate or increase delay. A higher setting does not
promise a better picture for every scene.

Changes restart that viewer's desktop or window stream immediately. The page shows Applying effort
until the new encoder produces its first keyframe, then reports the applied choice or Effort
unavailable.
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
| VP9, libvpx | `cpu-used` | 8 | 6 | 4 |
| H.264, x264 | `preset` | superfast | fast | medium |
| HEVC, x265 | `preset` | ultrafast | superfast | fast |
| AV1, libaom realtime | `cpu-used` | 8 | 6 | 4 |
| VA hardware encoders | `compression_level` | driver maximum | ceiling of half maximum | 1 |
| H.264, OpenH264 | unavailable | encoder default | encoder default | encoder default |

Rate control and low latency settings still apply, including no B-frames and the libvpx real-time
deadline. These are encoder effort settings, not a constant-quality rate control mode. Encoder target
bitrate and measured encoded throughput can differ, especially on a static picture.

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
1280 by 720 output and a fixed 4 Mbit/s target and ceiling. Each text, scrolling or moving-shapes scene
starts a fresh viewer session and warms up for 2.5 seconds before a six-second sample, comparing
Fast and High within each codec. The benchmark suppresses browser congestion reports so startup delay
does not lower the target; the selection check exercises adaptation separately. Server transport
pressure can still adapt, so every reported target during the sample must remain at 4 Mbit/s.
`EFFORT_CODECS=vp8,h264`, `EFFORT_SCENES=motion` and `EFFORT_SECONDS=6` can narrow or lengthen a run.
`EFFORT_SIZE=1920x1080` changes the source and encoded dimensions; `EFFORT_BITRATE` sets the target
and ceiling in kbit/s. Results record the actual encoder, binary hash and installed tool versions.

The scene paints a wall clock and frame sequence into each frame. The viewer reads that small stripe
at paint time to measure source-to-canvas delay and sequence gaps. The source sequence span also
reports observed production rate separately from the nominal compositor clock. Sequence gaps, repeats
and regressions describe the decoded marker, which can itself suffer compression artifacts; they are
separate from the browser drop counters. This includes capture, encode,
transport, decode and browser paint submission, plus the same stripe readback for every setting. It
does not include physical display scanout or input-to-response delay. Encoded payload bytes give the
actual bitrate. Browser counters distinguish transport loss, decoder drops and decode errors.

The worker's `ffmpeg encoded` trace reports conversion plus encoding time as `encode_us` and time
from raw submission to packet as `submit_to_packet_us`. These are elapsed times, not CPU time.
The 30 Hz frame budget is 33.3 ms. The benchmark retains JSON results,
traces, decoded screenshots and reference images in its printed temporary directory. Screenshot RGB
PSNR excludes the clock stripe and compares against the scene drawn at the decoded timestamp. It is
a single-frame measure, including color conversion. Both effort settings capture the same phase of
the repeating animation, but this still cannot establish a general quality ranking.

## Software measurements

These Docker measurements use an Intel Core Ultra 7 155H, FFmpeg 9.0.1, libvpx 1.17.0,
x264 0.165.3222, libaom 3.15.0 and Chromium 152.0.7977.82. Other test workloads were stopped.
Each row compares Fast / High in that order, with the six-second samples, software rendering,
WebSocket transport and fixed 4 Mbit/s target described above. These are short effort comparisons;
[stream reliability](stream-reliability.md) describes the longer network tests.

At 1280 by 720:

| Codec / scene | Actual kbit/s | Painted fps | Encode p95, ms | Paint age p95, ms | PSNR, dB |
|---|---:|---:|---:|---:|---:|
| VP8 / text | 2215 / 3221 | 27.6 / 27.6 | 7.7 / 8.0 | 96 / 126 | 37.7 / 37.6 |
| VP8 / scroll | 3790 / 3824 | 27.8 / 27.7 | 10.9 / 12.0 | 129 / 132 | 39.5 / 39.6 |
| VP8 / motion | 4023 / 4018 | 27.6 / 27.6 | 11.4 / 10.8 | 130 / 129 | 22.6 / 22.6 |
| H.264 / text | 982 / 65 | 27.6 / 27.8 | 6.2 / 8.7 | 124 / 124 | 37.9 / 38.0 |
| H.264 / scroll | 2986 / 2655 | 27.8 / 27.6 | 7.4 / 11.2 | 126 / 128 | 40.0 / 40.2 |
| H.264 / motion | 3231 / 3282 | 27.6 / 27.8 | 6.9 / 11.3 | 126 / 127 | 22.7 / 22.7 |
| VP9 / text | 3815 / 3695 | 27.7 / 27.7 | 8.7 / 10.3 | 126 / 127 | 37.5 / 37.5 |
| VP9 / scroll | 3832 / 4632 | 27.6 / 27.6 | 9.6 / 11.3 | 127 / 129 | 40.0 / 40.0 |
| VP9 / motion | 3964 / 3924 | 27.8 / 27.6 | 12.1 / 14.0 | 130 / 132 | 22.7 / 22.7 |
| AV1 / text | 2637 / 121 | 27.5 / 27.6 | 15.5 / 16.2 | 137 / 132 | 37.8 / 38.1 |
| AV1 / scroll | 1809 / 2090 | 27.7 / 27.3 | 15.7 / 37.8 | 140 / 165 | 39.7 / 40.1 |
| AV1 / motion | 3591 / 2311 | 27.6 / 19.2 | 18.0 / 72.4 | 141 / 218 | 22.7 / 22.7 |

At 1920 by 1080, software AV1 uses libaom:

| Codec / scene | Actual kbit/s | Painted fps | Encode p95, ms | Paint age p95, ms | PSNR, dB |
|---|---:|---:|---:|---:|---:|
| AV1 / text | 919 / 809 | 26.6 / 26.5 | 15.7 / 15.7 | 144 / 161 | 38.9 / 39.0 |
| AV1 / scroll | 2028 / 2610 | 26.3 / 26.3 | 22.0 / 23.2 | 169 / 174 | 40.3 / 40.8 |
| AV1 / motion | 3440 / 3402 | 26.0 / 25.8 | 35.9 / 44.6 | 192 / 201 | 22.7 / 22.7 |

The source produced about 27.6 fps at 720p and 26 fps at 1080p despite its nominal 30 Hz clock.
All samples had zero invalid markers and no repeated or regressing source sequences. Browser
transport-loss, decoder-drop and decode-error counters stayed zero. AV1 High at 720p motion had 49 source-sequence gaps
and painted 19.2 fps; its p95 encode time exceeded the 33.3 ms frame budget. Other samples had no
source-sequence gaps. At 1080p, both AV1 motion settings exceeded that frame budget at p95.

The inspected AV1 text and H.264 scrolling captures remain readable. H.264 High used fewer bits for
static text and scrolling, with a small screenshot-score improvement and more encode time.
AV1 High substantially reduced static-text traffic at 720p, but its motion sample lost throughput
without a useful screenshot-score gain. VP8 and VP9 showed little consistent benefit from High.
VP9 High scrolling averaged 4.63 Mbit/s despite its 4 Mbit/s target, so that row is not an equal-output-rate
quality comparison. Fast remains the default; higher effort can trade frame rate for compression,
and these samples do not establish a general quality ranking.
