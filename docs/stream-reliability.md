Run `npm run check:reliability` from `web` inside an isolated Docker rig with Chromium, FFmpeg,
`iproute2`, `ethtool`, Python, the GPU device and `NET_ADMIN`. The checkout and release binary must be mounted.
The check requires an unused loopback shaper. It saves and restores the loopback MTU and offloads.

The default run measures H.264 and AV1 at 1280×720 and 1920×1080, three 60-second samples for
each of the four scenes. Allow about 50 minutes for the complete matrix.
The 12 Mbit/s link and 20 ms one-way delay are configured before connecting RTC, followed by six
seconds of warmup. Quality uses an 8 Mbit/s ceiling with normal adaptation enabled. Results include
minimum target and time at the ceiling so a bitrate reduction remains visible.
The shaper holds at most 100 packets at 12 Mbit/s. `RELIABILITY_LINK_MBPS` scales that capacity in
proportion to the starting rate, rounded up, so 36 Mbit/s uses 300 packets. This keeps a full queue's
approximate transmission time the same for comparable packet sizes. [Netem](https://man7.org/linux/man-pages/man8/tc-netem.8.html)
counts packets held for the 20 ms delay against the same limit. Capacity changes during a sample keep
the initial packet limit. Even with zero configured random loss, bursts can overflow the queue;
per-sample counters report both total and deliberately injected drops. Such overflow and SCTP recovery
are part of the reliability diagnosis.

The shared `effort-scene.html` renderer provides detailed scene cuts, scrolling text, camera-like
motion and a synthetic moving picture. The optional exploratory `cycle` mode changes every 900
source frames, about 15 seconds at 60 Hz; the formal matrix measures each scene separately.
The moving picture advances every other source frame. A separate settled text picture follows each
sample. Cut samples also capture the first decoded picture observed within five source frames of a
cut, alongside a later picture. These scenes exercise screen encoding; they do not run a game or
decode a source video.

Use short clean-link runs for correctness while preparing the rig:

```sh
RELIABILITY_PROFILE=clean RELIABILITY_CODECS=h264 RELIABILITY_SIZES=1280x720 \
RELIABILITY_REPEATS=1 RELIABILITY_SECONDS=3 RELIABILITY_WARMUP=1 \
RELIABILITY_SCENE=cuts npm run check:reliability
```

Run `RELIABILITY_PROFILE=capacity`, `loss`, `burst-loss` or `fallback` separately. Capacity starts
at 12 Mbit/s, drops to 4 Mbit/s at one third of the sample, then recovers to 12 Mbit/s at two thirds.
Every change records its timestamp and qdisc state. Random loss is 0.5% at 12 Mbit/s. Burst loss uses
[netem's Gilbert-Elliot model](https://man7.org/linux/man-pages/man8/tc-netem.8.html), with 0.125%
entry into the loss state, 25% exit, 100% loss within a burst and no loss outside it. Fallback blocks server UDP traffic from 30% to 60% of each sample while
TCP remains available. Use the default 60-second duration for that recovery trial.
`RELIABILITY_SCENE=cuts|scroll|game|video|text` isolates a scene; `RELIABILITY_SCENES` accepts a
comma-separated subset. `ELSEWHERE_BINARY`,
`ELSEWHERE_RENDER_NODE`, `ELSEWHERE_TEST_PORT` and `RELIABILITY_OUTPUT` select the binary, device,
port and artifact directory.
`RELIABILITY_BITRATE` changes the Medium ceiling in kbit/s for rate-control diagnosis. The formal
controlled-link timing gate applies to the default 8000 kbit/s ceiling.

For a separate consumer-isolation run, set `RELIABILITY_PROFILE=clean`, `RELIABILITY_VIEWERS=3`
and `RELIABILITY_BLOCKED_CONSUMERS=2`. Real browser viewers continue decoding while the TCP consumers
stop reading with a 4096-byte receive-window clamp. Consumers alternate between Very Low with a
30 fps cap and Medium with no frame cap. Each verifies its selected target and cap, waits 30 or 20
seconds respectively, checks whether the server closed after its send deadline, then reconnects.
Use a 90-second sample to exercise repeated closure at both rates. Consumer events and every viewer's
paint progress are recorded. Samples of 60 seconds or more require every blocked consumer to remain
alive, observe at least two server closures and reconnect at least twice. Every real viewer must
paint without a one-second gap. Short correctness samples report the closure gate as unexercised.
The default matrix has one real viewer and no blocked consumers.

Repeat the scene/codec/resolution matrix with `RELIABILITY_VIEWERS=3 RELIABILITY_LINK_MBPS=36`.
The shaper provides one shared 36 Mbit/s link with 20 ms delay, a 300-packet limit and an 8 Mbit/s
ceiling per viewer. This preserves the single-viewer bandwidth headroom ratio and approximate queue
transmission time while measuring simultaneous encoding.
It does not simulate three independent links. A separate three-viewer run at the default 12 Mbit/s
tests competition for shared capacity and is expected to reduce individual targets.

The printed artifact directory contains raw observations, summaries, server traces, environment
settings, decoded pictures and matching source references. Environment metadata includes CPU/GPU
model information, native library/driver
versions, loaded VA driver modules, the binary hash and any experimental encoder override.
Summaries report median, p95, p99 and maximum frame age, paint gap, frame size,
fixed 100 ms and one-second arrival/encoding rates, queue
bytes, encode latency, encoder open time and delivered stream restarts. Encoder rates and timings
follow the primary viewer's stream IDs, including its replacement streams. Queue summaries follow
its session; separate per-session quarter distributions include the other viewers. Reopen timing
runs from encoder initialization to its first encoded key, including redraw waits after opening.
It excludes control dispatch, teardown and delivery; paint gaps show the complete interruption.
Queue measurements distinguish network backlog, the server's retained
frames, bytes accepted from its front frame, and the browser's incomplete fragments.

Formal stable 720p samples fail the check if any viewer's p99 frame age reaches 300 ms or any paint
gap reaches 500 ms. This includes every viewer in the three-viewer 36 Mbit/s matrix.
Timing failures are collected across the matrix before exit. Per-session queue quarter
distributions and longest intervals without an empty queue provide evidence for backlog review.
The one-second empty-queue flag is diagnostic; a continuously occupied queue does not alone prove
growth. Inspect these observations and text/cut pictures before declaring the reliability targets met.

Clock markers measure source drawing through browser canvas painting on one machine. They do not
measure physical display scanout. Invalid markers and sequence regressions are reported. Sampled
queue maxima may miss shorter peaks; trace logging and marker readback in every viewer add
measurement overhead.
PSNR and text pixel error accompany the screenshots and do not replace visual inspection. Run timed
comparisons with other builds, browser checks and fixture workloads stopped.
Each picture records its source sequence, source timestamp, capture time and observed StreamState target.
That reported target can briefly precede the encoder's new stream. The text capture requires a source
timestamp after the text switch and at least 60 source frames in that phase.

## Recorded results

The audited formal coverage below contains 48 single-viewer samples and 24 three-viewer 720p samples:
three 60-second repeats of each scene for each listed codec/resolution. It uses an Intel Core Ultra
7 155H with integrated Intel Arc graphics, FFmpeg 9.0.1, libavcodec 63.1.101, Chromium 152,
libva 2.24, Intel media driver 26.2.4 and Mesa 26.2.2. Encoding uses VAAPI and Fast effort.
The source, compositor, encoders and viewer browser share one machine; multiple viewers are pages
in one browser instance, not independent physical clients.

Forty-five single-viewer samples and the 24 three-viewer 720p samples use the same build. Three single-viewer
samples use a build with equivalent hardware media code and settings; its software VP9 settings
differ. These formal samples precede the RTC pressure-accounting correction that excludes intentional
recovery replacement from congestion; the table describes those measured builds.

Ranges span individual sample results, including every page for three-viewer timing and frame rate.
Encoded rates are each sample's primary-viewer mean, not aggregate traffic or peak rate. Every row
contains 12 samples. Single-viewer links use 12 Mbit/s and 100 packets; three-viewer links use
36 Mbit/s and 300 packets. Both have 20 ms one-way delay.

| Codec | Size | Viewers | p99 frame age (ms) | Worst paint gap (ms) | Painted frames/s | Encoded Mbit/s |
|---|---|---:|---:|---:|---:|---:|
| H.264 | 1280×720 | 1 | 121–185 | 104.3 | 54.3–54.5 | 6.519–6.606 |
| AV1 | 1280×720 | 1 | 128–234 | 232.9 | 53.5–54.2 | 5.082–6.602 |
| H.264 | 1920×1080 | 1 | 128–236 | 205.7 | 28.6–53.8 | 6.396–8.004 |
| AV1 | 1920×1080 | 1 | 140–261 | 370.4 | 52.2–53.6 | 5.398–6.487 |
| H.264 | 1280×720 | 3 | 127–184 | 104.1 | 53.9–54.4 | 6.470–6.546 |
| AV1 | 1280×720 | 3 | 106–238 | 225.2 | 53.3–54.2 | 5.446–6.586 |

Every observed viewer in both 720p matrices met the p99-below-300-ms and gap-below-500-ms targets.
All 72 samples had zero qdisc packet drops, primary decoder-pressure drops, decoder errors and fallback.
The three single-viewer AV1 720p scroll samples started at 4 Mbit/s and recovered to 8 Mbit/s, each
with four reopens and four key requests. The other 45 single-viewer samples and every page in the
three-viewer 720p samples held 8 Mbit/s during measurement.

The primary protocol-loss counter totaled 16 across the single-viewer samples and two across the
three-viewer 720p samples. Those counts are distinct from decoder-pressure drops and network loss:
replacing unsent video with a key can leave protocol sequence gaps. Source-clock sequence gaps are
different again. In single-viewer H.264 1080p cuts, byte admission delivered 28.6–29.1 frames/s from
about 54 source positions/s, skipping roughly 1,500 source positions per sample to contain output
rate. That is a visible cadence tradeoff despite bounded frame age and paint gaps.

Per-session queue distributions stayed stable across sample quarters and repeatedly returned to
empty, with at most 475 ms between observed empty states. The largest single-viewer primary queue
was 393 kB with a 313 ms front-frame age; the three-viewer 720p primary maxima were 280 kB and
177 ms. These observations show no accumulating server backlog in these samples.

Matching decoded pictures still show a quality cost after dense cuts. One retained H.264 1080p
first-cut picture at an observed 8 Mbit/s target had PSNR 14.80 dB and visibly smeared, noisy detail;
its settled text was readable, with softened glyphs and thin rules. A retained AV1 720p first-cut
picture lost detail at 20.11 dB, while its moving picture and settled text remained clear. These
unequal resolutions do not establish a codec-quality ranking.

Diagnostic native three-viewer 1080p samples from the same pre-correction build expose downstream
playback pressure, tracked in
[issue #73](https://github.com/ryanpetris/elsewhere/issues/73). One AV1 cuts sample averaged about 33 frames/s per
viewer, reached 890 ms worst viewer p99 age and 2.585 s maximum displayed age, and ended near
1–1.5 Mbit/s after decoder-pressure drops and reopens. AV1 game samples reached 1.860 s maximum
age even while server queues were empty in about 97% of observations and native encoding p99 was
about 18 ms. Receive-to-decoder-output and drawing timings locate delay downstream of native encoding
and transport; the contributions of CPU, GPU, decoder backend, browser scheduling and measurement
readback remain unresolved.
H.264 scroll had an affected sample followed by two repeats at 8 Mbit/s and about 52–53 frames/s,
with zero primary decoder-pressure drops and worst all-viewer gaps of 103 and 92 ms. These stress
observations must not be described as uniformly low-latency playback, sustained H.264 failure, or
measurements of the corrected controller.

A separate three-viewer AV1 720p scroll condition kept only 100 packets at 36 Mbit/s. Its three
samples recorded 36, 55 and 74 non-injected qdisc drops; the worst paint gap was 1.058 s. That
capacity also holds the propagation delay's packets, so it provides substantially less queue time
than 100 packets at 12 Mbit/s. A 300-packet diagnostic had zero drops and worst gap 75 ms; the
maintained 300-packet 720p matrix is reported above. Sampled queue length did not directly capture
the instantaneous overflow point. The 100-packet results remain evidence for the tighter-buffer
condition, separate from the matrix with equivalent bandwidth headroom and approximate queue time.
