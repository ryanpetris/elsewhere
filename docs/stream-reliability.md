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
Other machine activity was not fully controlled. The affected multi-viewer samples require a quiet
rerun before attributing the measured slowdown to a reproducible viewer load limit.

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
All 72 samples had zero qdisc packet drops, primary browser delta drops, decoder errors and fallback.
The three single-viewer AV1 720p scroll samples started at 4 Mbit/s and recovered to 8 Mbit/s, each
with four reopens and four key requests. The other 45 single-viewer samples and every page in the
three-viewer 720p samples held 8 Mbit/s during measurement.

The primary protocol-loss counter totaled 16 across the single-viewer samples and two across the
three-viewer 720p samples. Those counts are distinct from browser delta drops and network loss:
replacing unsent video with a key can leave protocol sequence gaps. Source-clock sequence gaps are
different again. In single-viewer H.264 1080p cuts, byte admission delivered 28.6–29.1 frames/s from
about 54 source positions/s, skipping roughly 1,500 source positions per sample to contain output
rate. That is a visible cadence tradeoff despite bounded frame age and paint gaps.

The browser delta-drop counter increments for the first non-key frame discarded after a sequence gap
or when the decoder queue exceeds four. Further discarded deltas while awaiting a key do not increment
it. A nonzero count alone does not identify decoder pressure; the queue and timing observations provide
that distinction.

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
1–1.5 Mbit/s after browser delta drops and reopens. AV1 game samples reached 1.860 s maximum
age even while server queues were empty in about 97% of observations and native encoding p99 was
about 18 ms. Receive-to-decoder-output and drawing timings locate delay downstream of native encoding
and transport; the contributions of CPU, GPU, decoder backend, browser scheduling and measurement
readback remain unresolved.
H.264 scroll had an affected sample followed by two repeats at 8 Mbit/s and about 52–53 frames/s,
with zero primary browser delta drops and worst all-viewer gaps of 103 and 92 ms. These stress
observations must not be described as uniformly low-latency playback, sustained H.264 failure, or
measurements of the corrected controller.
The same build's H.264 cuts sample failed the one-second progress check with a 1.851 s paint gap.
Its low-target recovery also exposed intentional key replacement being counted as congestion;
that failure remains separate from the corrected-controller cuts samples below.

A separate three-viewer AV1 720p scroll condition kept only 100 packets at 36 Mbit/s. Its three
samples recorded 36, 55 and 74 non-injected qdisc drops; the worst paint gap was 1.058 s. That
capacity also holds the propagation delay's packets, so it provides substantially less queue time
than 100 packets at 12 Mbit/s. A 300-packet diagnostic had zero drops and worst gap 75 ms; the
maintained 300-packet 720p matrix is reported above. Sampled queue length did not directly capture
the instantaneous overflow point. The 100-packet results remain evidence for the tighter-buffer
condition, separate from the matrix with equivalent bandwidth headroom and approximate queue time.

A separate 15-second-per-codec buffer comparison used 720p cuts, an 8 Mbit/s target and an earlier
paced build, before the final producer admission settings. At 50, 100 and 200 ms native buffer sizes,
H.264 p99 age was 180, 174 and 340 ms; AV1 was 259, 251 and 250 ms. The H.264 maximum server queue
grew from 165 kB at 100 ms to 420 kB at 200 ms. All six samples held the target without reopens or
browser delta drops. This supported retaining the 100 ms buffer for the formal measurements;
the short comparison does not establish an optimum for every encoder or source.

## Current controller and impaired links

The pressure-accounting build from source commit
[`4cc0fe9`](https://github.com/ryanpetris/elsewhere/commit/4cc0fe9), with binary hash prefix `2902bd23`,
has nine additional three-viewer H.264 1080p samples: three 60-second repeats each of cuts,
game-like motion and video-like motion.
They use the shared 36 Mbit/s, 20 ms, 300-packet link and normal adaptation under an 8 Mbit/s ceiling
per viewer. These results are separate from the earlier cohorts. The first cuts sample also enables
the existing AutoRate debug messages; each artifact records its effective logging filter.
These timing cohorts describe the identified build. Keeping the previous canvas picture visible
through configuration changes has separate functional verification and is not a rerun of these timings.

| Scene | Samples | p99 frame age (ms) | Maximum frame age (ms) | Worst paint gap (ms) | Painted frames/s | Primary encoded Mbit/s |
|---|---:|---:|---:|---:|---:|---:|
| Cuts | 3 | 207–457 | 700 | 593.7 | 22.0–29.9 | 6.788–8.007 |
| Game-like motion | 3 | 118–663 | 1532 | 740.0 | 34.8–52.0 | 2.794–6.208 |
| Video-like motion | 3 | 183–842 | 1125 | 765.4 | 10.5–52.7 | 2.439–5.872 |

Timing and frame-rate ranges include all three pages. All nine samples passed the native-geometry,
decode-error and one-second progress checks, with zero qdisc drops. This is not uniformly low-latency
1080p playback: the primary minimum targets were 3.906, 1.000 and 1.525 Mbit/s for the three scene
groups, and some secondary pages also reduced their targets. A video sample initiated two WebSocket
fallbacks with the browser's repeated-loss-or-stalls reason despite zero qdisc drops; its primary RTC
fraction was 95.3%. The first attempt returned to RTC during the sample, while the second was still
recovering at its end.
Primary browser delta-drop/reopen totals were 6/5 for cuts, 44/7 for game-like motion and 27/28 for
video-like motion.

The affected game sample confirms that the downstream limitation in issue #73 also occurs with the
current controller. Native encoding p99 was 19.7 ms and the primary front-frame age stayed below
45 ms, with queues empty in about 96% of observations. Browser receive-to-output p95 reached
1.145 s and the maximum displayed age reached 1.532 s. These measurements locate the backlog without
identifying a particular decoder backend or separating browser scheduling from readback overhead.

The cuts validation recorded 174 AutoRate evaluation windows across its three viewers, all with
zero congested-frame counts despite encoder reopens. The controller still reduced targets in windows
with a nonzero `slow` count. Deliberate replacement of queued video contributes no congestion count;
the capacity trial below checks that genuine congestion still reduces the target and permits recovery.

The following ten samples use the same build, 720p cuts and normal adaptation. Each lasts 60 seconds,
except the 180-second capacity trials. Competition uses three viewers sharing 12 Mbit/s and 100
packets; the other conditions have one viewer. Frame age, gaps and frame-rate ranges include every
viewer. Each p99 value is the worst per-viewer p99, not a pooled percentile. Targets and encoded means
describe the primary viewer. Packet counts show total qdisc drops
followed by the deliberately injected subset.

| Condition | Codec | Frame age p99 / max (ms) | Worst paint gap (ms) | Painted frames/s | Minimum → final target (Mbit/s) | Encoded Mbit/s | Packet drops total / injected |
|---|---|---:|---:|---:|---:|---:|---:|
| Random 0.5% loss | H.264 | 530 / 742 | 398.8 | 32.6 | 2.500 → 7.446 | 4.050 | 143 / 143 |
| Random 0.5% loss | AV1 | 449 / 743 | 825.4 | 39.8 | 1.861 → 1.861 | 2.505 | 103 / 103 |
| Burst loss | H.264 | 996 / 1308 | 1048.2 | 18.6 | 1.250 → 2.977 | 2.355 | 102 / 102 |
| Burst loss | AV1 | 304 / 434 | 537.3 | 30.8 | 1.000 → 3.050 | 1.323 | 65 / 65 |
| UDP blackout | H.264 | 176 / 217 | 3353.9 | 47.9 | 4.000 → 8.000 | 6.085 | 561 / 561 |
| UDP blackout | AV1 | 232 / 354 | 3398.3 | 48.5 | 4.000 → 8.000 | 5.652 | 569 / 569 |
| Capacity 12 → 4 → 12 Mbit/s | H.264 | 350 / 3088 | 2593.6 | 39.2 | 1.000 → 8.000 | 4.891 | 79 / 0 |
| Capacity 12 → 4 → 12 Mbit/s | AV1 | 260 / 3534 | 1693.4 | 43.9 | 1.000 → 8.000 | 4.629 | 64 / 0 |
| Shared-capacity competition | H.264 | 1245 / 1636 | 1458.4 | 18.8–25.5 | 1.906 → 3.721 | 2.431 | 142 / 0 |
| Shared-capacity competition | AV1 | 302 / 1453 | 1541.8 | 30.8–39.6 | 2.000 → 4.652 | 2.397 | 98 / 0 |

The capacity drops occurred at 60 seconds and restoration at 120 seconds. H.264 returned to its
8 Mbit/s ceiling 22.79 seconds after restoration; AV1 took 19.05 seconds. H.264's debug trace recorded
four congestion windows during the reduced-capacity phase, including 34 congested frames out of 56
in one window. It recorded no congestion or slow-feedback windows after restoration. That trial
therefore exercises both genuine pressure and recovery with deliberate key replacement excluded.
The H.264 capacity run includes AutoRate debug logging in addition to the default trace filter.

Both UDP-blackout checks passed their explicit fallback and return requirements. They reached
WebSocket about 3.35 seconds after UDP was blocked and returned to RTC 1.74 seconds (H.264) and
1.84 seconds (AV1) after UDP restoration. Their low frame-age percentiles coexist with multi-second
paint gaps because no new picture arrived during the interruption. H.264 random loss and AV1
capacity also included brief browser-initiated fallback intervals.

Both shared-capacity competition checks failed the one-second secondary-viewer progress requirement;
their nonzero exits and measurements are retained. They continued decoding valid frames, but real
queue overflow and recovery produced visible stalls. The random-loss, burst-loss and competition
rows had no periodic target observations at the 8 Mbit/s ceiling. These are measurements of adaptive
behavior under impaired or insufficient capacity, not full-rate quality results. All ten samples
had zero decoder errors and valid source markers.

Across these impaired-link samples, native encoding p99 ranged from 6.3 to 13.5 ms and the longest
encoder-open-to-key interval was 398 ms. The largest primary server queue was 563 kB and the largest
encoded picture was 266 kB. Peak encoded rates were 23.24 Mbit/s in a fixed 100 ms bin and
8.40 Mbit/s in a one-second bin. Browser arrival callbacks reached 51.62 Mbit/s in a 100 ms bin
during recovery; callback batches are not instantaneous link-throughput measurements. The maximum
paint gaps and displayed ages above retain the visible cost of that recovery.

## Allocator reuse across viewer sessions

On glibc builds, the desktop server defaults to two allocation arenas before starting its worker
threads. Workers can reuse freed codec allocations across sessions without retaining a separate
arena for each worker. A nonempty `MALLOC_ARENA_MAX` or `glibc.malloc.arena_max` entry in
`GLIBC_TUNABLES` takes precedence, including an explicit zero for glibc's automatic limit.
Empty values use the application default. If glibc rejects the tuning call, startup continues with
a warning. Other allocator tunables keep their glibc defaults unless set
by the operator. The audio and broadcast helper processes do not apply this default.
GNU libc documents the arena limit in its [allocation tunables](https://sourceware.org/glibc/manual/latest/html_node/Memory-Allocation-Tunables.html)
and the startup API in its [malloc tuning parameters](https://sourceware.org/glibc/manual/latest/html_node/Malloc-Tunable-Parameters.html).

This limits arena proliferation, not total process memory. Active allocations still depend on
viewer count, resolution and codec. Fewer arenas can increase allocation contention at higher
concurrency; deployments with different workloads can select their own limit.

A targeted Docker comparison used glibc 2.44, FFmpeg 9.0.1 and Chromium 152. Each software cycle
opened three animated window viewers plus a read-only observer, resized the windows, changed
encoding effort, checked the final static pictures and closed the window viewers. A desktop viewer
remained connected. Initial browser viewports were 800×600; resize requests ranged from 640×480 to
960×640. Software rendering and VP8 encoding used the same workload for each policy.

| Allocator policy | Idle RSS across four cycles, MiB | Mean painted frames/s | Median per-window p95 paint interval, ms | Median final-picture response, ms |
|---|---|---:|---:|---:|
| glibc default | 244, 314, 376, 450 | 24.0 | 51.0 | 25.1 |
| Two arenas | 195, 204, 180, 191 | 24.1 | 50.0 | 31.5 |
| Fixed 512 KiB mmap threshold | 180, 190, 197, 208 | 22.5 | 56.8 | 32.3 |

Matched idle live allocations stayed near 25–26 MB. In the first three default-policy samples,
free arena space grew from 118 to 267 MB. With two arenas, free arena space was 60 MB after the
first cycle and 54 MB after the fourth. The fourth default-policy allocation sample preceded
teardown and is excluded from this comparison. The allocation probe samples every 100 ms;
RSS, descriptors and threads were read directly after teardown, so the fourth RSS value is retained.
No default-policy plateau was observed within these four cycles.
Allocation quantities use decimal MB; RSS uses MiB.
A fixed 128 KiB mmap threshold also reduced retention, but delivered about 22.5 frames/s in its
three completed cycles. That run's fourth cycle failed the original file-descriptor gate because
an additional HTTP connection remained open.

The two-arena policy retained the default workload's throughput. Its final-picture response median
was about 6 ms higher across 12 observations per policy; the means were 30.8 and 33.4 ms, with
both policies' maximum near 66 ms. One two-arena window sample had a 76 ms p95 paint interval;
the other eleven were between 47.8 and 52.4 ms. These short synthetic comparisons
do not establish game performance or identical latency under every load. A separate two-cycle
VAAPI H.264 comparison passed resize, effort, final-picture and teardown checks; final idle RSS
was 248 MiB with the glibc default and 203 MiB with the application default.

Run `npm run check:viewer-lifecycle` in the Docker rig to exercise the application default. A
five-cycle software run kept idle RSS between 204 and 228 MiB with bounded descriptors and threads.
The descriptor gate accounts for up to three remaining HTTP or WebSocket connections separately
from other descriptors and permits the live desktop's bounded DMA buffer pool on GPU runs.
Run `python3 scripts/check-allocator.py` in a glibc Docker image to verify the actual startup
`mallopt` call and explicit allocator overrides against the selected `ELSEWHERE_BINARY`.
Native release builds and this startup check passed on Arch with glibc 2.44, Debian 13 with glibc
2.41, Ubuntu 24.04 with glibc 2.39 and Ubuntu 26.04 with glibc 2.43. The allocator comparison and
viewer timing checks above ran on Arch; the other distributions have startup coverage, not repeated
viewer performance measurements. Builds using another C library do not apply the glibc policy.
