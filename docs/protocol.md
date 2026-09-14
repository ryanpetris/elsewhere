# Protocol and HTTP API

The server speaks two things: a binary WebSocket protocol for the viewer page and a JSON/PNG HTTP API
for scripts. Both require a live bearer token with explicit permissions.
See [tokens](tokens.md) for setup, the management API and the operation-to-permission mapping.

Routes below are relative to the public URL prefix, if configured. For example, with
`--url-prefix /elsewhere/alice`, the viewer connects to `/elsewhere/alice/ws` and API clients use
`/elsewhere/alice/api/...`. See [reverse proxy setup](reverse-proxy.md) for forwarding modes.

## Authentication

- **Viewer page** (`/`, `/app.js`, `/app.css`): public. The token arrives once in the
  URL fragment (`/#token=…`, supplied by the user), is moved into
  `sessionStorage` and stripped from the address bar; a page with no token shows a dialog asking for one.
- **WebSocket** (`/ws`): the first message must be `AUTH` with a token. Until then the socket is
  nobody: nothing is processed. A wrong token, or five seconds of silence, closes it with code **4001**
  `Invalid or expired token`. Socket messages are bounded to 16 MiB plus the paste header, including during authentication; all non-paste payloads remain limited to 1 MiB. A live token without desktop.view closes with `4004`, preserving its identity.
  The authenticated socket sends the full Permissions grant list before session replay; the viewer uses
  it for feature access. Role tracks participant ownership and active desktop input eligibility.
- **Window streams** (`/ws/window/{id}`): authenticated like `/ws`; see below.
- **HTTP API** (`/api/...`): `Authorization: Bearer <token>`. Nothing else is accepted, so the token
  never appears in a URL the server or a proxy logs. Operations without their required grants return `403`.
- `DELETE /api/tokens/{id}` revokes that token and closes its active sessions.

No cookies are used anywhere.

## WebSocket messages

Binary frames, little-endian, byte 0 is the type. Mirrored in `crates/elsewhere-server/src/protocol.rs` and
`web/src/viewer.js` (with the constants in `web/src/protocol.js`).

### Server → client

Config `width` and `height` describe the intended physical video image. Decoded storage may include
alignment padding beyond its right/bottom edges; the viewer crops to the configured extent while
respecting the decoder's existing visible origin. `scale` converts those dimensions to logical pixels.

| Type | Name | Payload |
|---|---|---|
| `0x01` | Config | JSON `{streamId, attempt, codec, width, height, scale}`. Sent on the video transport before its first frame of a stream and before RTC recovery keys. The viewer resets its decoder on a new `streamId` and ignores repeated configurations for the same stream on that connection. `codec` is a WebCodecs string (`avc1…`, `hev1…`, `vp09…`). |
| `0x02` | Video | `u8 flags` (bit 0 keyframe) `u16 seq` `u64 pts_us` then one encoded frame. `seq` numbers the frames of a stream from 0 in the order they are sent, restarting with each new stream; the page treats a gap as a lost frame and waits for the next keyframe. |
| `0x03` | Cursor | `u16 w` `u16 h` `i16 hot_x` `i16 hot_y` `u16 logical_w` `u16 logical_h` then straight-alpha RGBA; `w == 0` hides the pointer. The bitmap is `w × h`; it is shown at `logical_w × logical_h` logical pixels (larger for a client's HiDPI cursor, by buffer scale or viewport), the hotspot is logical, so the page uses `image-set(… (w/logical_w)x)`. |
| `0x04` | PointerLock | `u8 locked`: a client locked or released the pointer; the page mirrors it with the Pointer Lock API. |
| `0x05` | Audio | `u8 0` `u16 seq` `u64 pts_us` then one 20 ms Opus packet. `seq` counts every packet, sent or not. |
| `0x06` | Windows | JSON array of window objects (see below), the whole list, whenever anything in it changed. Replayed to a new viewer. |
| `0x07` | Clipboard | JSON clipboard metadata (`observation`, `operation`, `source`, `present`, `mime`, `size`, `preview`), as in `/api/clipboard/state`, with `text` for an observed text selection (at most 1 MiB). `source`, when present, identifies the originating authenticated socket by string `session` and its `u32 request`; it confirms an installed compound paste. Other binary bodies use conditional `GET /api/clipboard`. Not replayed: reconnecting retains the browser clipboard. |
| `0x08` | Role | `u8 role` `u8 features` `u64 control_epoch`: participant ownership and desktop input eligibility. The epoch changes on every participant control handoff (zero for window streams). 0 watch only (the token without `desktop.control`); 1 act but not drive (a token with `desktop.control` while another participant controls); 2 control: its participant owns the desktop; bit 3 identifies which connection supplies input and size. `features` reflects both token permissions and server availability: bit 0 its microphone (`Mic`), bit 1 its webcam (`Cam`), bit 2 session playback is available, bit 3 this connection supplies desktop input. Microphone and camera bits also identify the permitted capture source. Sent with the replay after `Hello` and whenever it changes. |
| `0x09` | Notice | `u8 kind` (0 a warning, 1 good news) then UTF-8 text about the session's last action, for the page to show briefly. Sent to the controller when its drag (`Drag`) was dropped: good news naming the application that took the files, a warning when none did. Sent to a window stream whose press aims past the desktop's edge at an X11 window: Xwayland's screen is the desktop, and the X server pins the pointer to it, so that click cannot arrive. |
| `0x0B` | Notifications | JSON array of the open desktop notifications, oldest first, whenever they change and in the replay: each has `id`, `rev` (counts up when the application replaces it), `app`, `summary`, `body`, `icon` (whether `GET /api/notifications/{id}/icon` has a picture), `actions` as `[key, label]` pairs, and `timeout_ms` (0: until closed). |
| `0x0C` | StreamState | JSON `{"codec", "codecs", "status", "attempt", "preset", "ceiling_kbps", "medium_kbps", "bitrate_kbps", "max_fps", "effort"}`: `codec` is the selected family or null when exhausted. `codecs` is the full server list of `{"codec","hardware"}` entries. `status` is `starting`, `streaming`, `retrying`, `switching`, or `failed`; `attempt` identifies the current encoder attempt. Sent before video starts and when recovery changes state. Also contains selected preset and ceiling, configured Medium ceiling, and current stream target (`max_fps` 0: the compositor's rate), when an encoder reports a new stream and whenever the rate controller steps the quality; the page separates ceiling, stream target, and measured throughput. `effort` contains `requested`, nullable `applied`, nullable `encoder` and `setting`, and `pending`. Effort values are `fast`, `balanced`, or `high`; unavailable controls have null `applied` and `setting` with `pending: false`. |
| `0x0D` | Rtc | JSON, WebRTC signalling: `{"ice_servers": [...], "port": 8443}` with an optional `"host"` address override right after the replay when the server does WebRTC (the page may then offer); `{"answer": "<sdp>", "g": 1}` to the page's offer, containing local ICE candidates; the UI keeps the first candidate, sets its address and port from the RTC configuration and page hostname, and drops the other candidates; `{"close": true, "g": 1}` when the server gives the channel up (pending video without SCTP acknowledgements for three seconds, or a message waiting three seconds at the application queue front): the video is already back on the socket, the page closes its side and retries while keeping WebRTC selected. A rejected offer returns the same close envelope with `"reason": "Offer rejected"`. `{"keyframe": true, "g": 1}` acknowledges a matching close that released a video claim and precedes a server-requested refresh; the page expects a keyframe even if its channel-open callback never ran. |
| `0x0E` | Fragment | On the data channel only: `u32 id` `u16 index` `u16 count` then up to 16 KiB of a Config or Video message, reassembled by id. The channel is ordered and reliable, so a piece is delayed rather than lost and nothing overtakes it. A frame dropped by the server because its queue is full or a keyframe replaces queued video can leave a sequence gap. A delta after a gap requests a keyframe; a keyframe recovers decoding directly. |
| `0x0F` | MixerState | JSON `{generation, available, error, routing, nodes}`: initial desktop audio snapshot and authoritative updates. Each node has an opaque `id`, `name`, nullable `application`, `kind` (`output`, `input`, `playback`, `recording`), `state`, nullable `volume` and `mute`, `volume_writable`, `mute_writable`, `routing_writable`, `targets` (IDs), `is_default`, `meter_before_volume`, `meter_active`, and nullable `meter_error`. Unavailable state invalidates rows; an error with `available: true` describes degraded service. |
| `0x10` | MixerLevels | JSON array of `{id, peak}`, at about 10 Hz to subscribed desktop viewers. Peaks are linear amplitudes measured from audio, shared across subscribers. |
| `0x11` | MixerError | UTF-8 error for the viewer's mixer command. |
| `0x12` | Session | `u64 id`: this socket connection, used for clipboard origin correlation. Window sockets have the high bit set. |
| `0x14` | Display | JSON `{kiosk, resolution}`: shared display settings on connection and when changed. The latest snapshot is retained for slow readers. See [display settings](#display-settings). |
| `0x15` | Permissions | JSON array of permission names from the authenticated token, sent before session initialization on desktop and window sockets. |
| `0x19` | Participant | Desktop-only JSON `{id, secret}` for the shared participant and its authenticated opener association. See Viewers below. |

Config and Video share the active transport's ordering. RTC queue replacement retains a Config
before the recovery key. While RTC owns video, the viewer ignores delayed WebSocket Video messages.
A new Config arriving over WebSocket closes the current RTC attempt before changing the decoder;
late RTC callbacks from that attempt are then ignored. Repeated Config messages for the current
stream on the same WebSocket session leave the decoder and sequence tracking intact. A reconnect
applies its configuration even if the stream ID repeats. On fallback, the server supplies the current
Config on WebSocket before video if that stream has not been configured on the socket.

### Client → server

| Type | Name | Payload |
|---|---|---|
| `0x80` | Auth | the token as UTF-8. First message. |
| `0x81` | Hello | JSON `{"codecs":["h264","hevc","av1","vp9","vp8"],"quality":"medium","effort":"fast"}`. `codecs` is required and ordered by browser preference; duplicate names are ignored, unknown names reject the message, and an empty list has no shared codec. Quality defaults to Medium when missing or unknown; effort defaults to Fast when missing. The server starts the first supported codec in this list. Desktop connections may also include `participant: {secret, pip, resume}` as described below. |
| `0x82` | Resize | `u16 css_w` `u16 css_h` `f32 dpr`. Output = CSS size × dpr, rounded down to even, capped at 8K. |
| `0x83` | MotionAbs | `f32 x` `f32 y` in logical (CSS) pixels. |
| `0x84` | MotionRel | `f32 dx` `f32 dy` while pointer-locked. |
| `0x85` | Button | `u16 button` (Linux `BTN_*`: 0x110 left, 0x111 right, 0x112 middle, 0x113 side, 0x114 extra) `u8 pressed`. |
| `0x86` | Axis | `u8 deltaMode` (0 pixels, 1 lines, 2 pages) `f32 dx` `f32 dy`. Lines become wheel clicks (v120 = 120 per line); pixels become finger scrolling. |
| `0x87` | Key | `u16 evdev` `u8 pressed`. From `KeyboardEvent.code`; repeats are never sent. |
| `0x88` | RequestKeyframe | none. |
| `0x89` | Blur | none. Window blur, page hidden: releases every held key and button. |
| `0x8A` | PointerLockLost | none. The browser lost its lock (Escape): the client's lock is released and not re-taken until the next click or successful browser capture. |
| `0x8B` | Control | JSON control message (below). |
| `0x8C` | SetClipboard | UTF-8 text the browser pasted; it becomes the desktop clipboard, offered to Wayland and X11 clients. `clipboard.write` required. Images and staged file selections use `PasteClipboard`. |
| `0x8D` | TakeControl | none. A desktop.control session claims an unowned desktop, or takes over immediately with desktop.take_control; the desktop takes its size. |
| `0x8E` | Notify | JSON `{"id": N, "action": "default" \| "<key>"}`: the viewer clicked a notification or one of its actions; without `action` it dismissed it. `desktop.control` required. |
| `0x8F` | Stream | JSON `{"codecs":["hevc","h264"],"quality":"medium","effort":"fast"}`, all fields optional. A codec list starts selection over in its given order, including failure counts. Quality or effort alone preserves codec failure history. Any session, its own stream only. |
| `0x90` | Drag | JSON `{"op": "start"}`, `{"op": "drop", "batch": "…", "names": ["a.txt", …]}` or `{"op": "cancel"}` (with `"batch"` when files were staged for it): the browser drags local files over the desktop. `start` begins a drag on the desktop where the pointer is (offering `text/uri-list`, to copy or to move); the pointer messages move it; `drop` names the batch the files were staged in (`PUT /api/drop/{batch}/{name}` first, not the transfer folder) and their names, and drops their `file://` URIs on the application under the pointer; a drop nothing took, or a cancel naming a batch, sends the files to the transfer folder; `cancel` lets go over nothing. Controlling session only. |
| `0x91` | Input | JSON: one input action as `POST /api/input` takes it (`{"type": "text", "text": "…"}`, `{"type": "key", "keys": "ctrl+c"}`, `move`, `click`, …), resolved on the compositor thread, in order with the session's other input; the on-screen keyboard types with it. Controlling session only. |
| `0x92` | Touch | `u8 kind` (0 down, 1 motion, 2 up) `u8 id` `f32 x` `f32 y`: a finger on the browser's touchscreen, passed on as a `wl_touch` point (`id` tells the fingers down at once apart; logical px); each message is its own frame; a finger the browser takes for a gesture of its own is lifted. Controlling session only. |
| `0x93` | Mic | One Opus packet (20 ms, 48 kHz, mono) of the browser's microphone, played into the desktop's virtual source as it arrives. Owning participant's media connection only; dropped when the desktop has no audio. |
| `0x94` | Cam | One VP8 frame of the browser's webcam (720p at 30 fps asked of the camera, whatever it gives encoded at 2 Mbit/s with a keyframe every two seconds), played into the loopback camera as it arrives, scaled to 720p; when the desktop is behind, frames are dropped there until the next keyframe. Owning participant's media connection only; dropped without `--webcam`. |
| `0x95` | Rtc | JSON: `{"offer": "<sdp>", "g": 1}` from the page to open its `video` data channel (ordered, reliable; the page sends the offer once its candidates are gathered, and the server answers as an ICE-lite peer. The UI keeps the first answer candidate, sets its host to the configured host or page hostname and its port to the server-supplied UDP port, and drops the other candidates before applying the answer. The browser resolves hostnames, which should be fully qualified because ICE resolution does not use DNS search suffixes); `{"close": true, "g": 1}` to go back to the socket. `g` is a required unsigned integer on offers and closes, numbering the attempt; it comes back with answers and server close notifications. A client close must carry the matching generation; it cannot close a newer attempt. While a session's channel is open its video frames and decoder configuration go there with the same message formats; other messages stay on the socket. Desktop and window sessions alike; the page offers while WebRTC is selected, initially and on recovery. Each attempt belongs to one WebSocket session. |
| `0x96` | Report | `u16 delay_ms` `u16 dropped`: the page's last second of video, once a second while frames come: how much later they arrived than at their best over the last ten seconds (the link queueing, which comes before it loses) and how many its decoder dropped. Either feeds the server's rate controller, which halves the bitrate under the viewer's quality ceiling and holds two seconds; five clean seconds raise it a quarter. |
| `0x97` | Mixer | JSON, at most 4096 bytes: `{op: "subscribe", enabled: bool}`, `{op: "volume", id, value}`, `{op: "mute", id, value}`, `{op: "target", id, target}`, or `{op: "default", id}`. Subscriptions are available to every authenticated desktop viewer; mutations require the current controller. Volume is finite 0–100 percent with cubic gain; mute is boolean; target is a compatible endpoint ID or null to follow the session default. Unknown fields, stale IDs and unsupported operations are rejected. Commands never accept a server address or native operation. |
| `0x98` | Handoff | `u64 target`: the owning participant transfers to a live participant with desktop.control. Other senders, missing targets and desktop-view-only targets are ignored. |
| `0x99` | PointerLockGained | none. The browser acquired pointer lock; allow a pending application lock to resume without sending a button event. Capture-on-click sends MotionAbs at the clicked position before this message so locks resume at that target; application-requested capture preserves the current pointer position. Driving sessions only. |
| `0x9A` | PasteClipboard | `u8 flags` `u64 control_epoch` `u32 request`, then a PNG (up to 16 MiB) or UTF-8 JSON `{ "names": [...], "batch": "…" }` (up to 1 MiB). Flag bit 0 requests a paste chord, bit 1 selects Shift+Insert instead of Ctrl+V, bit 2 selects staged files instead of PNG. Other bits are invalid. The socket identifies the viewer; capture its Role epoch before staging. Clipboard installation requires a live session with `clipboard.write` (and `files.upload` for files). On the compositor thread, install first, then tap only if `desktop.control` and current session eligibility still hold: active desktop input connection and matching epoch, or a live window stream whose window still has focus. Otherwise install without input. Revoked/disconnected sessions do neither. All selected files must validate under the token’s batch ownership; execution failures notify the originating session. A skipped requested chord sends a notice and refreshes a desktop viewer’s Role. |

### Close codes

| Code | Meaning |
|---|---|
| 4001 | unauthorized: no or wrong token within five seconds, or its token was revoked or expired |
| 4003 | a stream that can't run: no such window, the window closed, or no encoder could be made |
| 4004 | authenticated token lacks desktop.view or participant association was rejected; the token remains valid for its other permissions |

The page shows these (a token dialog for 4001 or 4004, a card for 4003) and stops retrying. Desktop PiP
retries 4004 with reason `The opener's participant is no longer connected.`, waiting for its opener's
current association before rejoining. On any other close it reconnects after a second.

### Viewers

Any number of connections may watch the desktop; each has its own encoder and viewport. One
participant owns control. Its active connection supplies desktop pointer, keyboard and sizing.
Other connections' input is ignored and their resize requests fit their own streams. Both
connections of an owning participant may use controller-only workspace and mixer controls.
Other `Control` operations, clipboard writes and HTTP/MCP actions retain their independent grants.

`Session` identifies the connection. Desktop connections also receive `Participant` (`0x19`),
UTF-8 JSON with decimal-string `id` and a 64-character hexadecimal `secret`. The secret remains
in browser memory and authorizes the opener's desktop PiP and connection resume; it is not in the
roster or URL. `Hello` can include `participant: {secret, pip, resume}`. A matching secret and the
same authenticated token join the existing participant. `pip: true` selects that connection as
the participant's desktop input source. Invalid associations close with 4004. A resume whose
secret no longer exists creates an independent participant under normal election rules, without
reclaiming control from another participant. Sharing a token alone never joins participants.

The first eligible participant controls initially. After its final connection leaves, the oldest
remaining eligible participant controls. `TakeControl` requires `desktop.take_control` while
someone owns control; `Handoff` checks the owning participant and target participant under the
viewers lock. Same-participant connection changes release old input and update sizing without
changing the ownership epoch or pending requests.

`Roster` (`0x16`, UTF-8 JSON) contains participant `controller` and `epoch` as decimal strings,
and sorted `sessions` entries with participant `id`, `label`, `can_control`, `request` and `result`.
Labels such as "Session 3" identify participants, not verified people. Token IDs, secrets and
permission lists are absent. A request contains decimal-string `id` and `epoch` plus Unix
`expires_at_ms`. Results are `approved`, `declined`, `cancelled`, `expired` or
`controller_changed`, otherwise null.

`RequestControl` (`0x9B`, no payload) creates a participant's shared five-minute request.
Repeating it from either connection preserves the deadline. With no controller it claims control.
`CancelControl` (`0x9C`) carries request ID and epoch as two little-endian u64 values.
`ApproveControl` (`0x9D`) and `DeclineControl` (`0x9E`) carry target participant ID, request ID
and epoch. Either connection of the owner may decide a live matching request. Concurrent decisions
are serialized. Losing the final connection, revocation and ownership changes invalidate requests;
PiP opening, closing and a surviving sibling's disconnect do not. Approval never grants permissions.

`PointerPosition` (`0x17`) carries four little-endian f64 values: compositor logical x, y,
output width and output height. Changed positions are sampled every 34 ms independently of video,
including moves caused by API input. Observers combine this with `Cursor` shape, hotspot and
visibility, scaled into the letterboxed desktop. Controllers keep browser-local cursor feedback.
Roster, pointer and desktop cursor updates retain only the latest value per connection and replay
on connection. Control changes also refresh `Role`, release held input and pointer lock, and stop
the old controller's microphone and camera capture. Playback can continue.

### Window streams (`/ws/window/{id}`)

One application window as its own video, for a tab or popup that shows just that window (the ↗ button in
the viewer's panel opens one, sized to the window). The same messages as `/ws`, with these differences:

- No `Resize` is needed: the stream is the window's geometry at the output's scale (even-rounded), and
  follows it. A `Resize` the page sends resizes the *window* to the given CSS size, clearing maximized
  or fullscreen state while kiosk is off, including after kiosk exit. Kiosk-on resize is ignored.
  The desktop output size stays unchanged in both fixed and automatic resolution modes.
- Pointer positions are relative to the window's geometry, as in the input message (they are forwarded
  as one, resolved against the live geometry). Keys and buttons go where they always go (the focused
  window, the pointer). Any desktop.control session drives its popup, whoever controls the desktop; a
  desktop-view-only session only watches. Focusing the tab focuses the window only if it is already mapped on the active workspace.
- `Cursor`, `PointerLock`, `Windows` and `Clipboard` arrive as on `/ws`; there is no audio. The page
  uses the window list only for the tab title. `Notice` arrives only here: a press on the part of an
  X11 window that hangs past the desktop's edge, which Xwayland pins to the edge.
- Any number can run beside the viewer, each with its own encoder (one `--bitrate` each). The
  compositor renders a window stream only when that window changed; it drops the stream when the
  window closes (close code 4003) or the socket ends. `Hello` still picks the codec. Token revocation
  ends only that token’s sessions with 4001. A tab that stops reading for ten seconds is dropped, as is a viewer.

## HTTP API

```sh
T=$(elsewhere token create --admin)
curl -s -H "Authorization: Bearer $T" https://host:8443/api/windows
curl -X POST -H "Authorization: Bearer $T" -H 'Content-Type: application/json' \
     https://host:8443/api/control -d '{"id":3,"op":"minimize"}'
curl -X POST -H "Authorization: Bearer $T" -H 'Content-Type: application/json' \
     https://host:8443/api/control -d '{"op":"spawn","cmd":"firefox"}'
curl -o w.png -H "Authorization: Bearer $T" 'https://host:8443/api/windows/3/snapshot.png?percentage=50'
curl -o screen.png -H "Authorization: Bearer $T" https://host:8443/api/screenshot.png
curl -s -H "Authorization: Bearer $T" https://host:8443/api/windows/3/elements      # needs --elements
```

| Route | Result |
|---|---|
| `GET /api/windows` | JSON array of window objects (the list the viewer was last sent; `[]` before any). |
| `GET /api/codecs` | JSON array of `{"codec", "hardware"}`: what this server encodes, after the configured allowlist and startup probe. |
| `POST /api/control` | Body: a control message. `202 Accepted`; fire-and-forget. |
| `GET /api/windows/{id}/snapshot.png` | PNG of that window. Optional `width`, `height`, or `percentage`, default native dimensions; [sizing limits](desktop-api.md#screenshot-sizing). `400` invalid sizing. `404` unknown id, `429` another snapshot is in flight, `500` the render failed (logged), `503` the compositor didn't answer within 2 s. |
| `GET /api/screenshot.png` | PNG of the whole output (layers included, cursor excluded); sizing as for a window; `400`, `429`, `500`, `503` as for a window. |
| `POST /api/input` | Body: an input message (below). `202`, with `{"warning": …}` when a click aims past the desktop's edge at an X11 window; `404` unknown window; `503` compositor gone. |
| `GET /api/files?path=…` | `files.browse` required. Paginated `FileListing`; required absolute directory path, `@home`, or `@transfer`. Optional `hidden`, `sort`, `desc`, `offset`, `limit`; [file operations](desktop-api.md#files). |
| `PUT /api/files/{name}?path=…` | `files.upload` required. Streamed upload to the required directory; collisions add ` (2)` before the extension. `201` with `name`, `path`, and `directory`. |
| `GET /api/files/{name}?path=…` | `files.download` required. Download from the required directory, as an attachment. `404` missing. |
| `DELETE /api/files/{name}?path=…` | `files.manage` required. Nonrecursive unlink from the required directory. `204`; `404` missing. |
| `PUT /api/drop/{batch}/{name}` | Like `PUT /api/files/{name}`, but into batch `batch`, a directory under the cache directory named by a random id of the page's, for the application that will take the files in a drag or a paste (the `Drag` `drop` or `POST /api/clipboard/files` name the batch); batches are swept after a day. `201` with `{"name": "…"}`. |
| `GET /api/notifications` | The open notifications, oldest first, as the `Notifications` message carries them. |
| `POST /api/notifications/{id}` | Body `{"action": "default" \| "<key>"}`, or `{}` to dismiss. `202`; `404` unknown id. |
| `GET /api/notifications/{id}/icon` | The notification's picture: what the application named or sent, else its launcher's icon. `404` none. |
| `GET /api/clipboard/state` | Observed metadata: `observation`, `operation`, `source`, `present`, `mime`, `size`, and `preview` (`empty`, `available`, `loading`, `unavailable`, or `restricted`). `clipboard.read` required; URI-list size and content require `files.download`. |
| `GET /api/clipboard` | What a desktop application last copied: `text/plain`, `image/png`, or `text/uri-list` (files copied in a file manager, one `file://` URI per line; the Content-Type says which); `204` before any. `If-Match` with a quoted observation rejects a replaced selection with `412`. |
| `PUT /api/clipboard` | Body: UTF-8 text, a PNG with `Content-Type: image/png`, or `file://` URIs with `Content-Type: text/uri-list`; it is queued for the desktop clipboard. `202` with `{ "operation": "…" }`; the operation appears in observed metadata only after installation. `413` over 1 MiB of text or 16 MiB of image. |
| `POST /api/clipboard/files` | Body `{"names": [...]}`, files of the transfer folder, or with `"batch"` of that staged batch: they become the desktop clipboard as a file manager's copy (`text/uri-list` and `x-special/gnome-copied-files`). `202`. |
| `GET /api/clipboard/files/{index}` | The `index`th file of the URI list on the desktop clipboard, as an attachment. `404` when the clipboard holds no such list or entry. |
| `GET /api/windows/{id}/elements` | The window's UI elements (below). `501` the server runs without `--elements`, `503` the tree couldn't be read: no D-Bus session or accessibility bus, the application went away, or 2 s passed (body: `{"error": …}`), `404` unknown id. |

Status codes: `401` invalid or expired token; `403` permission denied. Errors use
`{"error": "..."}`. A body axum can't read is rejected with a plain-text message: `400` invalid JSON,
`415` missing `Content-Type: application/json`, `422` wrong shape; JSON bodies are limited to 2 MiB (the
clipboard and file uploads have their own limits, or none).

Also on the server: `POST /mcp` (MCP over Streamable HTTP, same bearer token; see [mcp.md](mcp.md)) and
`GET /skill/SKILL.md`, `GET /skill/reference.md` (the agent documentation, no token). The generated
`skills/elsewhere/reference.md` holds the JSON schemas of every body and tool.

### Window object

```json
{"id": 3, "title": "…", "app_id": "org.gnome.Calculator", "icon": "org.gnome.Calculator", "content": null, "x11": false, "pid": 4242,
 "x": 70, "y": 70, "w": 360, "h": 616, "geo_x": 26, "geo_y": 23, "popups": [[12, 40, 200, 310]], "decoration": 0, "z": 1,
 "maximized": false, "fullscreen": false, "minimized": false, "focused": true,
 "updated_ms": 34044000, "content_revision": 42}
```

- `id` is stable for the window's life and never reused.
- `app_id` is the X11 `WM_CLASS` for X11 windows; `pid` comes from the socket credentials (Wayland) or `_NET_WM_PID` (X11), when known.
- `x y w h` is the xdg geometry in logical pixels. For a minimized window it is where the window will come back.
- `geo_x geo_y` is where that geometry sits inside the client's own surface (the width of its client-side shadow), 0 for X11 windows.
- `popups` lists the window's open popups (menus, combo box lists, tooltips) as `[x, y, w, h]` relative to `x y`; always empty for X11 windows.
- `decoration` is the height of the title bar the compositor draws above `x y w h` (32), or 0 when the
  application draws its own. That bar and its buttons are part of the window's elements (below).
- `z` is the stacking index, 0 = bottom, over the listed windows; `null` while minimized. Menus and tooltips (X11 override-redirect) are not listed.
- `focused` is the compositor's intent: the window last activated by a click, the taskbar or the API.
- `updated_ms` is the time of the window's last applied commit on the compositor's monotonic clock, in milliseconds. `content_revision` increases for applied content commits and changes to captured geometry or surface membership. It is an invalidation signal, not a pixel comparison. Content-only lists are coalesced to at most four per second, with the final revision published even after drawing stops. Structural list changes publish immediately.

### Input message

```json
{"type": "click", "window": 3, "x": 549, "y": 47}          {"type": "click", "x": 700, "y": 400, "button": "right", "count": 2}
{"type": "move", "x": 10, "y": 10}                          {"type": "button", "button": "left", "pressed": true}
{"type": "scroll", "dy": 3}                                 {"type": "key", "keys": "ctrl+shift+t"}
{"type": "text", "text": "hello\n"}
```

- Coordinates are output logical pixels, or relative to the window's geometry when `window` is given
  (the same origin as element rectangles). `click` moves the pointer first; `count` is 1 to 3.
- `key` is a `+`-separated chord: `ctrl`, `shift`, `alt`, `super`, then any xkb keysym name (`Return`,
  `Escape`, `F5`, `Prior`) or a single character (letters are case-insensitive). Pressed in order,
  released in reverse; keys a viewer already holds stay held; a chord with a key the layout lacks does nothing.
- `text` is typed through the compositor's keyboard layout, Shift or AltGr where the layout needs it;
  `\n` is Return; characters the layout can't produce are skipped with a warning in the log.
- `scroll` is in wheel lines (positive `dy` down), sent like the viewer's wheel.

`node web/checks/structured-input.mjs` checks text and key chords against a real
terminal in the Docker rig, through desktop and window WebSockets. Both desktop-view-only
paths reject input. Keys follow the compositor's current keyboard focus in both streams.

### Elements object

`GET /api/windows/{id}/elements` returns `level`, nullable `toolkit`, `truncated`, nullable
`unavailable`, and `elements`. Each element includes `role`, `name`, nullable `reference`,
nullable `enabled`, `focused`, `checked`, `editable`, advertised canonical `actions`,
`bounds_available`, and window-relative `x y w h`. Null distinguishes unavailable or
inapplicable state from false. Null actions mean discovery failed; an empty list means
no Action interface or no advertised actions.

`level` is `none` when the application publishes no tree, `app` when no toplevel matches,
`frame` when the matching toplevel is empty, `full`, or `ambiguous`. Compositor decorations
can be listed at any level. A truncated tree cannot prove exact role/name uniqueness.
The walk visits at most 3000 nodes and lists at most 500 application elements. After window
matching, traversal stops at its 4.5-second deadline and returns a marked partial tree.
The enclosing five-second scan deadline covers connection and window matching as well.

Application roles include `button`, `toggle`, `switch`, `checkbox`, `radio`, `link`, `entry`,
`text`, `password`, `combobox`, `menu`, `menuitem`, `tab`, `slider`, `spinbutton`, `listitem`,
`treeitem`, `scrollbar`, and `heading`. Recognized showing elements can be listed without
geometry; use rectangles only when `bounds_available` is true. Open menu rectangles include
popup placement. Compositor decorations use `title bar` and `push button`, with `Minimize`,
`Maximize` or `Restore`, and `Close`, at negative `y` above the window geometry.

With `--elements`, POST `/api/windows/{id}/elements/action`, `/text`, or `/wait` takes a
`target` that is either `{reference}` or exact `{role, name}`. Action adds an advertised
`action`; text adds UTF-8 `text`; wait adds `condition` and optional `timeout_ms`, default 30000 and maximum 300000.
Reads and waits require `desktop.view`; mutations require `desktop.control`, independently
of viewer control ownership. References expire five minutes after their last issuance, are
window/application-bound, and remain usable beyond a truncated prefix after live revalidation.
There is no coordinate or keyboard fallback and no automatic retry of uncertain mutations.
Wait results include `matched`, `elapsed_ms`, `attempts`, the last observed `element` and
`last_error`. See the [generated schemas](../skills/elsewhere/reference.md) and
[semantic operation details](mcp.md#semantic-ui-operations).

### Control message

`{"id": <window id>, "op": "<op>", ...}`; `id` is omitted for workspace creation, renaming, deletion and switching, and for `spawn`, `launch` and `quit`.

| `op` | Effect |
|---|---|
| `activate` | switch to the window’s workspace, unminimize if needed, raise, focus |
| `focus` | focus only if mapped on the active workspace; never switch or restore |
| `createworkspace` (`name`, optional) | create a named workspace, using its ID when the name is missing or blank |
| `renameworkspace` (`workspace`, `name`) | rename an existing workspace without changing its ID, windows or active state |
| `deleteworkspace` (`workspace`) | delete a workspace and move its windows to the first remaining workspace; retain the last workspace |
| `switchworkspace` (`workspace`) | switch the shared desktop to an existing workspace |
| `movetoworkspace` (`workspace`) | move the window’s parent/transient family to an existing workspace without switching |
| `close` | ask the client to close (`xdg_toplevel.close` / `WM_DELETE_WINDOW`) |
| `minimize`, `unminimize` | |
| `maximize`, `unmaximize`, `fullscreen`, `unfullscreen` | through the same paths as the client's own requests; a minimized window is restored first |
| `move` (`x`, `y`) | floating windows only (mapped, not maximized or fullscreen) |
| `resize` (`w`, `h`) | mapped windows while kiosk is off; clears maximized/fullscreen state and clamps the size to the client's advertised minimum and maximum, then sends a size hint to Wayland clients or a configure to X11. Keeps the window and its compositor title bar within the work area when that size fits; larger sizes are anchored at the work area's top-left. |
| `spawn` (`cmd`) | `sh -c cmd` with the `--exec` environment: `WAYLAND_DISPLAY`, `DISPLAY`, `PULSE_SINK`, `XDG_SESSION_TYPE` and the toolkits' backend switches |
| `launch` (`app`) | start an installed application: `app` is an `id` from `GET /api/applications`, its `Exec` line runs like `spawn`; `404` over HTTP for an unknown id |
| `quit` | Elsewhere exits, every window with it |

Unknown ids and impossible requests are ignored. `spawn` is remote code execution by design; the token
is the boundary.

### Applications

`GET /api/applications` lists the launchers of the `.desktop` files in the XDG data directories
(`$XDG_DATA_HOME`, `$XDG_DATA_DIRS`; the first directory that has a file wins, so a user's copy hides a
system entry): `id` (the file name without `.desktop`), `name`, `comment`, `categories`. Entries that a
menu would not show are left out: `NoDisplay`, `Hidden`, `OnlyShowIn` (meant for one desktop), `Terminal`
(nothing to run them in), and `TryExec` binaries that aren't installed. `GET /api/applications/{id}/icon`
is the entry's icon as SVG or PNG, from the icon themes (hicolor first) or `pixmaps`; `404` without one.

## Browser console

`window.elsewhere()` returns viewer statistics. `elsewhere.windows()`, `elsewhere.activate(id)`, `elsewhere.control({...})`,
`elsewhere.spawn(cmd)`, `elsewhere.launch(app)`, `elsewhere.quit()`, `elsewhere.snapshot(id, sizing)` (a `Blob`) and `elsewhere.elements(id)` wrap the
same messages and routes.

The Docker rig can run `node web/checks/rtc-peer.mjs` for peer disposal and signaling callbacks,
`node web/checks/rtc-endpoint.mjs` for page hostname/IP selection and explicit port and address overrides, and
`node web/checks/quality.mjs` for live desktop/window transport and quality.
`node web/checks/rtc-recovery.mjs` exercises real channels, fallback, retry and cancellation;
run that check with NET_ADMIN inside Docker so it can temporarily block its test server's UDP port.
It removes its dedicated firewall chain on exit.

`FILE_RESULT` (`0x13`) carries UTF-8 JSON `{batch, saved, failed, error}` after an unclaimed or
cancelled desktop drop is rescued. `saved` contains `{name,path,directory}` objects. Sessions belonging to the token that staged the batch receive it; the originating client matches its batch ID and offers navigation explicitly.
It carries an operation result, not a directory subscription.


## Display settings

`GET /api/display` requires `desktop.view` and returns the shared settings:

```json
{"kiosk":false,"resolution":{"mode":"auto"}}
```

`PATCH /api/display` requires `desktop.control`. Either field can be supplied independently.
For a fixed resolution use `{"resolution":{"mode":"fixed","width":1920,"height":1080}}`.
Dimensions are physical pixels at scale 1, must be even, and must be between 2 and 8192.
Invalid dimensions return `400`; malformed JSON or unknown fields are rejected. A successful request
returns `200` with the resulting settings. Like window control, compositor application is asynchronous.

The server serializes policy changes with browser resizes and controller handoffs. Auto uses the
current controller's latest viewport and device scale immediately, or keeps the output until a size
is available. Fixed resolution survives browser resizes and handoffs. Startup flags supply initial
values; runtime changes are not written to disk.

`DISPLAY` (`0x14`) carries the same UTF-8 JSON snapshot to desktop and window viewers on connection
and when these settings change. This is shared desktop state, independent of per-viewer stream quality
and controls visibility. Kiosk fullscreens existing and newly mapped application windows. Turning it
off restores saved window state and geometry; windows first opened in kiosk become maximized in the
work area. Application fullscreen requests remain available in either mode.

## Workspace state

`Workspaces` (`0x18`) carries UTF-8 JSON with an `active` workspace ID and a `workspaces` array
of `{id, name}` entries. It is replayed to desktop and window sessions. Every `WindowInfo` has a
`workspace` ID; the full window list includes inactive and minimized windows.

`Control` accepts `createworkspace` with an optional `name`, `renameworkspace` with `workspace`
and `name`, `deleteworkspace` with `workspace`,
`switchworkspace` with `workspace`, and `movetoworkspace` with `id` and `workspace`.
All require `desktop.control`; desktop WebSocket switching also requires controller status.
Deleting a populated workspace moves its windows to the first remaining workspace. The last
workspace is retained. Native ext-workspace clients can create, remove, and activate on commit.

Window viewers and window-relative input route the shared seat to the target workspace without
changing the displayed workspace. Desktop viewer input restores displayed-workspace routing.
Changing the input workspace releases held input and grabs. Streams continue on all workspaces.
The `focus` operation focuses a mapped window without switching or restoring it; explicit `activate`
switches to its workspace and restores it if minimized.
