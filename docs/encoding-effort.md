# Encoding effort

The viewer's Effort selector controls encoding time separately from Quality, which selects a bitrate
ceiling. Fast preserves the default speed settings. Balanced and High can improve compression at the
same target bitrate, but can also lower frame rate or increase delay. A higher setting does not
promise a better picture for every scene.

Changes restart that viewer's desktop or window stream immediately. The page shows Applying effort
until the new pipeline produces its first keyframe, then reports the applied choice or Effort
unavailable.
The browser remembers the choice for reloads and reconnects, sharing the saved preference across
desktop and window tabs. Codec changes use the saved effort with
the new encoder's mapping. Changing effort preserves the selected ceiling and the congestion
controller's current target and recovery state. During startup, the shared compositor supplies full
frames until the encoder produces a keyframe; other attached viewers share that rendering cost.

## Encoder mappings

The pipeline sets these properties before entering PLAYING. It checks that the property exists, is
writable, and accepts the value. Unknown encoders or unavailable properties retain their own defaults
and report unavailable, with no claim that the requested effort was applied.

| Encoder | Property | Fast | Balanced | High |
|---|---|---|---|---|
| VP8, libvpx | `cpu-used` | 8 | 4 | 2 |
| VP9, libvpx | `cpu-used` | 8 | 6 | 4 |
| H.264, x264 | `speed-preset` | superfast | fast | medium |
| HEVC, x265 | `speed-preset` | ultrafast | superfast | fast |
| AV1, SVT | `preset` | 12 | 10 | 8 |
| VA hardware encoders | `target-usage` | 7 | 4 | 1 |
| H.264, OpenH264 | unavailable | encoder default | encoder default | encoder default |

Rate control and low latency settings still apply, including no B-frames and the libvpx real-time
deadline. These are encoder effort settings, not a constant-quality rate control mode. Encoder target
bitrate and measured encoded throughput can differ, especially on a static picture.

## Docker checks

Build the release binary and browser assets in the project Docker build stage. Mount the checkout
into a runtime image with Chromium, foot and the software GStreamer plugins installed. From `web`,
run `npm run check:encoding-effort` and `npm run check:effort-benchmark`. `ELSEWHERE_BINARY` can point to
a release binary copied from the build image. The selection check covers every codec shared by the
server and browser, all three effort choices, actual decoded frames, reloads, socket reconnects and
congestion adaptation for desktop and window streams.

To exercise OpenH264 fallback, set `GST_PLUGIN_SYSTEM_PATH` to a directory of links to the installed
plugins except `libgstx264.so`, use a fresh `GST_REGISTRY`, clear `GST_PLUGIN_PATH`, and set
`ELSEWHERE_EXPECT_UNSUPPORTED=1` for the selection check. It checks unavailable status and saved choice
on both stream types.

The benchmark launches a real Wayland Chromium canvas inside the remote desktop. A headless Chromium
viewer decodes and paints its video over WebSocket. Software rendering uses a 30 Hz compositor clock,
1280 by 720 output and a fixed 4 Mbit/s target and ceiling. Each text, scrolling or moving-shapes scene
starts a fresh viewer session and warms up for 2.5 seconds before a six-second sample, comparing
Fast and High within each codec. The benchmark suppresses browser congestion reports so startup delay
does not lower the target; the selection check exercises adaptation separately. Server transport
pressure can still adapt, so every reported target during the sample must remain at 4 Mbit/s.
`EFFORT_CODECS=vp8,h264`, `EFFORT_SCENES=motion` and `EFFORT_SECONDS=6` can narrow or lengthen a run.

The scene paints a wall clock and frame sequence into each frame. The viewer reads that small stripe
at paint time to measure source-to-canvas delay and sequence gaps. The source sequence span also
reports observed production rate separately from the nominal compositor clock. Sequence gaps, repeats
and regressions describe the decoded marker, which can itself suffer compression artifacts; they are
separate from the browser drop counters. This includes capture, encode,
transport, decode and browser paint submission, plus the same stripe readback for every setting. It
does not include physical display scanout or input-to-response delay. Encoded payload bytes give the
actual bitrate. Browser counters distinguish transport loss, decoder drops and decode errors.

GStreamer's [latency tracer](https://gstreamer.freedesktop.org/documentation/coretracers/latency.html)
measures traversal through the encoder element, including internal buffering. This is elapsed
encoding latency, not CPU time. The 30 Hz frame budget is 33.3 ms. The benchmark retains JSON results,
traces, decoded screenshots and reference images in its printed temporary directory. Screenshot RGB
PSNR excludes the clock stripe and compares against the scene drawn at the decoded timestamp. It is
a single-frame measure, including color conversion. Both effort settings capture the same phase of
the repeating animation, but this still cannot establish a general quality ranking.

## Measurements

Docker software rig, GStreamer 1.28.6, Chromium 152, libvpx 1.17.0, x264 revision 3222 and
SVT-AV1 4.2.0. All rows use the 1280 by 720, nominal 30 Hz, 4000 kbit/s configuration above.
Each row is one six-second sample. Timing columns show median / 95th percentile in milliseconds.

| Codec | Effort | Scene | Actual kbit/s | Painted fps | Encoder ms | Source-to-canvas ms | PSNR dB |
|---|---|---|---:|---:|---:|---:|---:|
| vp8 | fast | text | 562 | 27.3 | 3.7 / 4.7 | 127 / 132 | 36.0 |
| vp8 | high | text | 595 | 27.3 | 3.5 / 4.5 | 127 / 131 | 35.9 |
| vp8 | fast | scroll | 2954 | 27.3 | 5.5 / 7.8 | 130 / 135 | 38.4 |
| vp8 | high | scroll | 2987 | 27.5 | 5.6 / 7.6 | 130 / 134 | 38.2 |
| vp8 | fast | motion | 3727 | 27.5 | 5.9 / 7.8 | 129 / 134 | 22.4 |
| vp8 | high | motion | 3720 | 27.3 | 5.9 / 8.6 | 131 / 135 | 22.4 |
| h264 | fast | text | 717 | 27.3 | 1.8 / 2.9 | 125 / 130 | 36.6 |
| h264 | high | text | 91 | 27.3 | 3.4 / 4.5 | 127 / 130 | 36.6 |
| h264 | fast | scroll | 3288 | 27.5 | 2.3 / 3.6 | 127 / 130 | 39.3 |
| h264 | high | scroll | 1321 | 27.5 | 7.0 / 8.6 | 130 / 134 | 39.6 |
| h264 | fast | motion | 3606 | 27.3 | 2.3 / 3.4 | 127 / 132 | 22.4 |
| h264 | high | motion | 3481 | 27.3 | 6.3 / 8.4 | 130 / 135 | 22.3 |
| vp9 | fast | text | 3974 | 27.5 | 3.4 / 5.2 | 127 / 131 | 36.3 |
| vp9 | high | text | 3906 | 27.5 | 3.8 / 5.6 | 127 / 132 | 36.3 |
| vp9 | fast | scroll | 3812 | 27.5 | 4.1 / 6.7 | 129 / 133 | 38.9 |
| vp9 | high | scroll | 4147 | 27.3 | 5.4 / 8.2 | 130 / 135 | 38.8 |
| vp9 | fast | motion | 3813 | 27.5 | 5.5 / 7.7 | 129 / 134 | 22.4 |
| vp9 | high | motion | 3831 | 27.5 | 6.2 / 9.2 | 130 / 135 | 22.4 |
| av1 | fast | text | 16 | 27.3 | 396.9 / 403.7 | 521 / 530 | 25.2 |
| av1 | high | text | 12 | 27.3 | 396.5 / 401.5 | 520 / 526 | 30.7 |
| av1 | fast | scroll | 34 | 27.7 | 397.1 / 404.7 | 523 / 533 | 28.8 |
| av1 | high | scroll | 22 | 27.3 | 396.5 / 401.4 | 519 / 526 | 33.5 |
| av1 | fast | motion | 143 | 27.3 | 397.3 / 404.1 | 525 / 532 | 19.9 |
| av1 | high | motion | 116 | 27.3 | 396.3 / 401.1 | 521 / 527 | 19.9 |

All 24 samples reported zero transport loss, decoder drops and decode errors. Paint rates were
27.3 to 27.7 fps, below the nominal 30 Hz clock, with no throughput penalty from High in
these short runs. The rate inferred from the decoded source-sequence span matched the paint count;
these share the same decoded samples and are not independent rate measurements. VP8, x264 and VP9 had no missing, repeated or regressing source markers. AV1 Fast
text had two missing and two repeated markers with two regressions; scrolling had three missing and
three repeated markers. Its visibly softened marker makes those counts unsuitable as proof of
transport or decoder loss. The browser counters stayed zero, and the remaining AV1 rows had no marker
gaps or repeats.

VP8, x264 and VP9 met the 33.3 ms encoder traversal budget at both efforts in every scene, including
the 95th percentile. High added about 5 ms to median x264 scrolling encode time and about 4 ms for
motion, with a few milliseconds more source-to-canvas delay. VP8 and VP9 showed smaller timing costs.
AV1 did not meet the latency budget at either effort: roughly 400 ms inside the encoder and 520 ms to
the canvas despite steady throughput. Internal buffering dominates these AV1 timings, so they do not
show how much CPU work each preset uses. These figures apply to this software rig and these scenes,
not to other resolutions, machines or hardware encoders.

The x264 text and scrolling captures were legible at both efforts. High's scrolling screenshot had a
higher PSNR, 39.6 versus 39.3 dB, while using about 1.3 rather than 3.3 Mbit/s. Its text sample used
91 rather than 717 kbit/s at the same rounded 36.6 dB score. VP8 and VP9 text stayed
legible without a consistent benefit from High. In motion, the larger shapes remained distinct with
VP8, x264 and VP9, while fine checkerboard detail suffered; High did not improve those PSNR snapshots.
AV1 High made text visibly cleaner than Fast, which smeared glyphs and thin lines. Text PSNR rose
from 25.2 to 30.7 dB and scrolling from 28.8 to 33.5 dB while using fewer bits, with no measured
latency increase because buffering dominated. Both AV1 motion
captures were visibly softened, with no improvement in High's single-frame score.

Actual AV1 throughput was far below its configured ceiling in these short samples, 12 to 143 kbit/s.
The comparison therefore demonstrates effort at the same configured target, not equal actual output
rates or proof that rate control spends its whole budget. Constant-quality mode remains separate.
HEVC was not decodable in this browser rig and VA hardware was unavailable, so their mappings are
not performance claims. Balanced was checked for application and playback, but this table compares
only Fast with High.
