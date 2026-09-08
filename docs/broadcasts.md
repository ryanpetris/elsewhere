# Desktop broadcasts

The Broadcasts sidebar panel sends the generated desktop to RTMP/RTMPS ingest services. Enter an
ingest URL and stream key, choose output size, frame rate, bitrate, desktop sound or silence, and
whether to include the mouse pointer. Save a browser preset and press Start. Each running output
has its own Stop button and status. The control token permits start and stop even when another
viewer controls the desktop. Viewer-token connections can read status but cannot change streams.

Presets, including keys, live in local storage under `elsewhere.broadcastPreset.<id>`. They are
shared by instances at different paths of the same origin in the same browser profile. Scheme,
hostname, or port differences create separate storage. Tabs refresh presets through storage events.
Editing or removing a preset does not affect any running output. Running-stream status always
comes from the currently connected host. Clearing browser storage removes presets.

## YouTube and Twitch setup

Service instructions and encoder recommendations checked against the linked official documentation
on 2026-09-07. Elsewhere is the encoder in these instructions. Connect with a control token and
open **Broadcasts → Add preset**. Choose **Desktop sound** if host audio is available, otherwise
**Silence**, and choose whether to include the pointer. The preset name is a local label; set the
public title, category, audience, and visibility on the service itself.

### YouTube

1. In [YouTube Studio](https://studio.youtube.com/), choose **Create → Go live**. Complete the
   channel's live-streaming activation if prompted; first-time activation can take up to 24 hours.
2. In Live Control Room, use **Stream** for an immediate broadcast, or **Manage → Schedule stream**
   for a scheduled event. Set the title, audience, and visibility. Use **Unlisted** or **Private**
   for a test. Open the intended event before copying its connection settings.
3. Copy that event's RTMPS server URL into Elsewhere's **Ingest URL**, and its stream key into
   **Stream key**. In **Stream settings → Stream URL**, click the lock icon to display the RTMPS
   URL; the default displayed URL may be RTMP.
   Keep the key separate from the URL. YouTube describes this in its
   [RTMPS setup guide](https://support.google.com/youtube/answer/10364924?hl=en).
4. Choose a YouTube row from the settings table below, then **Save preset → Start** in Elsewhere.
   Check the preview and stream health in Live Control Room. Immediate streams can publish when
   the encoder starts; for a scheduled event, click **Go live** when the preview is ready, unless
   auto-start is enabled. Elsewhere's `sending` status alone does not confirm publication.
5. To finish a scheduled event, click **End Stream** in YouTube and **Stop** on its Elsewhere output.
   For an immediate stream, **Stop** in Elsewhere ends the encoder feed. Confirm the event has ended
   in YouTube before leaving it. Closing the Elsewhere tab does not stop the feed.

The [YouTube encoder walkthrough](https://support.google.com/youtube/answer/2907883?hl=en) covers
immediate and scheduled events. For scheduled automation, check the event's auto-start and auto-stop
options in [Live Control Room settings](https://support.google.com/youtube/answer/9854503?hl=en).

### Twitch

1. Open the [Twitch Creator Dashboard](https://dashboard.twitch.tv/). Under **Settings → Stream**,
   copy your primary stream key into Elsewhere's **Stream key**. Complete any account setup Twitch
   requests before the key is available. See the
   [stream key FAQ](https://help.twitch.tv/s/article/twitch-stream-key-faq?language=en_US).
2. Choose an endpoint from [Twitch's ingest recommendations](https://help.twitch.tv/s/twitch-ingest-recommendation?language=en_US).
   Paste the server URL through `/app` into **Ingest URL**. Remove the trailing `/{stream_key}`
   placeholder from the recommended endpoint; Elsewhere appends the separately entered key.
   Use the scheme Twitch supplies. The connection originates on the Elsewhere host, so a regional
   endpoint should suit that host's network, which may differ from your browser's location.
3. Choose a Twitch row from the table below and **Save preset**. In Twitch's **Stream Manager →
   Edit Stream Info**, set the public title and category before starting. See
   [Twitch's category instructions](https://help.twitch.tv/s/article/about-twitch-categories).
4. Press **Start** in Elsewhere. A normal Twitch ingest publishes to your channel as it receives
   the stream; there is no separate YouTube-style preview approval step. Check Stream Manager
   and your channel player for picture and sound. Press **Stop** in Elsewhere to end that feed.

To test the connection without publishing, append `?bandwidthtest=true` to the **Stream key**,
start the output, and inspect it in [Twitch Inspector](https://inspector.twitch.tv/). Stop the output,
remove the suffix, save, and start again to go live. Editing a preset does not change a running
output. Twitch documents the test parameter in its
[broadcast URL guide](https://dev.twitch.tv/docs/video-broadcast/).

### Encoding settings

These video bitrates follow the services' H.264 recommendations. Start with 720p at 30 fps if you
have not measured the host's encoding capacity and upload bandwidth.

| Service | Width × height | Frame rate | Video bitrate, kbps |
| --- | --- | --- | --- |
| YouTube | 1280 × 720 | 30 | 4000 |
| YouTube | 1280 × 720 | 60 | 6000 |
| YouTube | 1920 × 1080 | 30 | 10000 |
| YouTube | 1920 × 1080 | 60 | 12000 |
| Twitch | 1280 × 720 | 30 | 3000 |
| Twitch | 1280 × 720 | 60 | 4500 |
| Twitch | 1920 × 1080 | 30 | 4500 |
| Twitch | 1920 × 1080 | 60 | 6000 |

Sources: [YouTube encoder settings](https://support.google.com/youtube/answer/2853702?hl=en) and
[Twitch broadcasting guidelines](https://help.twitch.tv/s/article/broadcasting-guidelines?language=en_US).
Elsewhere supplies H.264 CBR, two-second keyframes, and 128 kbps stereo AAC at 44.1 kHz automatically.
The browser's viewing codec and quality controls do not configure these outputs. The desktop's
refresh rate still limits unique pictures, as described below. These Twitch settings use a single
video rendition; Elsewhere does not implement Twitch Enhanced Broadcasting.

To broadcast to both services, save one preset for each and start both. Each output uses its own
encoder and upload bandwidth. Allow upload capacity for the sum of the video bitrates, both audio
tracks, and transport overhead. Stop each output separately. If an output keeps reconnecting,
check the event or channel's current key and the URL/key split, then inspect service-side stream
health. Copy a replacement key into the preset and stop/start the output to apply it.

## API and MCP

HTTP and MCP call the same backend. Start takes all settings in one request and returns a runtime
ID. There are no server-side preset objects or create/save/update APIs. The HTTP routes are
`POST /api/broadcasts/start`, `POST /api/broadcasts/{id}/stop`, `GET /api/broadcasts`,
`GET /api/broadcasts/{id}`, and `GET /api/broadcasts/capabilities`. The MCP tools are
`broadcast_start`, `broadcast_stop`, `broadcast_list`, `broadcast_get`, and `broadcast_capabilities`.
The generated reference defines the Start fields.

Use a fresh `request_id` for each intended run. Identical retries return the same runtime ID for
at least ten minutes after admission, including after stopping. Different settings with the same
retained ID return a conflict. Active records remain until terminal; terminal records expire once
the admission is ten minutes old. An expired request ID is treated as new. At most 256 runtime
records are retained; new requests are rejected when that limit is reached.

Connection credentials are held only during startup, streaming, and reconnect attempts. Public
status includes labels, encoding settings, frame submissions, transmitted bytes, retry count, and
sanitized errors. URLs and keys are never returned. Stop cancels retries, detaches frame input, and
releases the media worker. A fresh start requires complete settings. Closing browser or MCP connections
does not stop a broadcast; stopping Elsewhere does. No broadcast starts automatically on startup.

## Media and limits

Each output uses its own H.264 software encoder with CBR and filler data, AAC encoder, FLV muxer, and RTMP/RTMPS connection.
The runtime image needs FFmpeg with libx264, AAC, FLV, and RTMP/RTMPS support. Capabilities report
missing components. Up to four outputs can run, with even dimensions from 64 pixels to 3840×2160,
24/25/30/50/60 fps, and 100–50000 kbps video. These are accepted settings, not a guarantee that
hardware or upload bandwidth can sustain every combination.

The compositor reads its rendered pixels once for CPU consumers. Broadcasts own those pixels and
retain no compositor DMA buffer leases. Browser encoders keep their existing frame path. A worker
repeats the latest picture at the requested rate (unique pictures remain limited by the desktop
refresh rate, normally 30 Hz with software rendering and 60 Hz with GPU rendering), uses regular
two-second keyframes, and scales
with letterboxing to a fixed output size when the desktop resizes. Pointer blending affects only
the broadcast output. The browser controls are outside the generated desktop image.

Video and audio timestamps share a monotonic connection clock. Native PipeWire captures the private
output monitor and FFmpeg converts its stereo PCM to AAC. Selecting desktop audio requires that
source to be available; capture failure fails that output. Reconnection starts fresh encoders and
clears captured audio from the previous connection.
Silence generates an AAC track independently of desktop audio. There is no separate microphone mix.

Raw input holds only the latest picture. Converted audio holds at most 100 ms, and muxing interleave
delay is bounded. A supervised helper sends encoded FLV through FFmpeg's native RTMP I/O. Its bounded
pipe carries no raw frames, and byte acknowledgements determine transport progress. Stop kills and
reaps the helper even if the system DNS resolver blocks. Late input after a network stall is
discarded. Network errors retry with
backoff up to 32 seconds until stopped; ten seconds of healthy sending resets the delay. Connections
use five-second I/O deadlines and a 15-second output watchdog. RTMPS verifies the destination
certificate and hostname using the runtime CA trust store. `sending` means
media transport is active; service publication also depends on its own live-event settings.
Encoding and readback consume CPU resources, and each output adds upload bandwidth.

## Verification

Build the `broadcast-source` example and run `python3 web/checks/broadcast-native.py` as root in Docker
with a C compiler, FFmpeg, OpenSSL and the `trust`/`update-ca-trust` utilities.
It checks idle CBR, cadence, aspect fit, color, A/V timestamps, cancellation during connection and
write stalls, trusted RTMPS, and certificate and hostname rejection. The TLS tests temporarily
add generated certificates to the container's CA trust store and remove them afterward.
Set `BROADCAST_DURATION=600` for a ten-minute A/V clock and idle bitrate check.

Run `web/checks/broadcasts.mjs` in the Docker desktop rig with the current binary, FFmpeg and Node.
It checks four simultaneous outputs, idle cadence, codecs, sizes, keyframe intervals, audio timing,
network reconnection, independent stop, request retries, API/MCP parity, and viewer-token rejection.
`web/checks/url-prefix.mjs` checks browser presets across instance paths and control-token actions
from a participant. Set `ELSEWHERE_BINARY` to a mounted or copied build for quick iteration. Run the broadcast check
again with `BROADCAST_AUDIO=1` to verify desktop sound, resizing, cursor inclusion, idle browser
behavior, varying capture quanta, a brief capture pause, and private-audio failure while a silent
output continues.
Set `BROADCAST_DURATION=600 BROADCAST_AUDIO=1` to keep both desktop-audio outputs running for
ten minutes before checking their A/V timestamp alignment and reconnect behavior.

Live YouTube/Twitch account acceptance requires service credentials and a separately arranged
ingest test. Local RTMP verification does not establish account publication or service health.
