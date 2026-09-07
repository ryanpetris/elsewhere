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
releases the pipeline. A fresh start requires complete settings. Closing browser or MCP connections
does not stop a broadcast; stopping Elsewhere does. No broadcast starts automatically on startup.

## Media and limits

Each output uses its own H.264 software encoder with CBR and filler data, AAC encoder, FLV muxer, and RTMP/RTMPS connection.
The runtime image needs x264, an AAC encoder, FLV, and RTMP GStreamer plugins. Capabilities report
missing plugins. Up to four outputs can run, with even dimensions from 64 pixels to 3840×2160,
24/25/30/50/60 fps, and 100–50000 kbps video. These are accepted settings, not a guarantee that
hardware or upload bandwidth can sustain every combination.

The compositor reads its rendered pixels once for CPU consumers. Broadcasts own those pixels and
retain no compositor DMA buffer leases. Browser encoders keep their existing frame path. A worker
repeats the latest picture at the requested rate (unique pictures remain limited by the desktop
refresh rate, normally 30 Hz with software rendering and 60 Hz with GPU rendering), uses regular two-second keyframes, and scales
with letterboxing to a fixed output size when the desktop resizes. Pointer blending affects only
the broadcast output. The browser controls are outside the generated desktop image.

Video and audio use one GStreamer pipeline clock. Desktop audio captures the private output source;
selecting it requires that source to be available. An audio failure fails the affected broadcast.
Silence generates an AAC track independently of desktop audio. There is no separate microphone mix.

Raw input holds only the latest picture. Pipeline queues are bounded. Network errors retry with
backoff up to 32 seconds until stopped; ten seconds of healthy sending resets the delay. Connections
use connection timeouts and a 15-second output watchdog. `sending` means
media transport is active; service publication also depends on its own live-event settings.
Encoding and readback consume CPU resources, and each output adds upload bandwidth.

## Verification

Run `web/checks/broadcasts.mjs` in the Docker desktop rig with the current binary, FFmpeg and Node.
It checks two different outputs, idle cadence, codecs, sizes, keyframe intervals, audio timing,
network reconnection, independent stop, request retries, API/MCP parity, and viewer-token rejection.
`web/checks/url-prefix.mjs` checks browser presets across instance paths and control-token actions
from a participant. Set `ELSEWHERE_BINARY` to a mounted or copied build for quick iteration. Run the broadcast check
again with `BROADCAST_AUDIO=1` to verify desktop sound, resizing, cursor inclusion, idle browser
behavior, and private-audio failure while a silent output continues.

Live YouTube/Twitch account acceptance requires service credentials and a separately arranged
ingest test. Local RTMP verification does not establish account publication or service health.
