---
name: elsewhere
description: Drive an Elsewhere desktop (Wayland compositor streamed to a browser) through its HTTP API or MCP tools: list windows, read a window's UI elements, click and type, take snapshots, start programs.
---

# Working an Elsewhere desktop

Elsewhere is a Wayland compositor whose screen is a browser tab. It is also the window manager,
so it can tell you what is on the screen and act on it. You talk to it over HTTP with a bearer token
(create an admin token on the server with `elsewhere token create --admin`), or through its MCP tools, which are the same
operations under the same names. `reference.md` next to this file lists every route, tool and field.

```sh
T=...                                   # the token; supplied by the user, often in $ELSEWHERE_TOKEN
H="Authorization: Bearer $T"
curl -s -H "$H" https://host:8443/api/windows | jq
```

If the deployment uses a URL prefix, prepend it to every HTTP route in this skill and the reference.
For example, `/elsewhere/alice/api/windows` and `/elsewhere/alice/mcp` address that instance.

## The loop that works

1. **Look at the window list first** (`GET /api/windows`, tool `windows`). Each window has an `id`, a
   `title`, an `app_id`, `focused`, `minimized`, and its geometry `x y w h` in logical pixels. Ids are
   stable for the window's life. Menus and tooltips are not windows; they show up as `popups` on the
   window that owns them.
2. **Read the window's elements** (`GET /api/windows/{id}/elements`, tool `elements`).
   Each element has an exact `role` and `name`, window-relative bounds, nullable
   `enabled`, `focused`, `checked`, and `editable` states, and advertised `actions`.
   Null means unavailable or inapplicable, not false. Check `bounds_available` before using
   the rectangle. `level` describes application coverage: `none`, `app`, `frame`, `full`,
   or `ambiguous`. A `truncated` tree cannot prove exact-selector uniqueness; references still identify objects. `unavailable` reports a bus
   failure even when compositor decorations remain readable.
3. **Use semantic actions** (`POST /api/windows/{id}/elements/action`, tool `element_action`)
   with `{ "target": { "reference": "..." }, "action": "<advertised name>" }`.
   References expire five minutes after their last issuance and belong to the returned window and live application.
   Alternatively use `target: { "role": "button", "name": "Save" }`, which must match
   exactly one element in a complete tree. Text replacement uses `/elements/text` or
   `element_text` with `target` and `text`. MCP also takes `window`.
   These operations require `desktop.control`, independently of the viewer's controller role,
   and never fall back to coordinates or keyboard input. They return the target state validated
   before dispatch. Success means toolkit acknowledgement, not that the UI finished changing.
   Text edits also read back the value unless it is a masked password field. Read again to confirm
   action results. A reference can be evicted by the bounded cache; handle `stale` by reading again.
4. **Wait for a state** (`POST /api/windows/{id}/elements/wait`, tool `element_wait`) with
   `target`, `condition`, and optional `timeout_ms`, default 30000, maximum 300000.
   Conditions are `present`, `enabled`, `disabled`, `checked`, `unchecked`, `focused`, and
   `unfocused`. Reads and waits require `desktop.view`. A timeout returns `matched: false`,
   elapsed time, read attempts, and the last observed element. Missing exact selectors can
   appear later; stale references and ambiguity fail explicitly. Unavailable application/state, bus, mapping
   and incomplete-tree failures are retried within the deadline and reported in `last_error`. Repeat checks use a shared 100 ms schedule and stop on cancellation or token expiry/revocation.
   For applications without semantic support, choose input operations explicitly and confirm
   with a snapshot. Window-relative coordinates still work with `/api/input` and `click`.
5. **Take a snapshot when you need to see** (`GET /api/windows/{id}/snapshot.png`, tool `snapshot`;
   `/api/screenshot.png`, tool `screenshot`). Window snapshots are lossless PNGs of the window's own
   buffers, so they work for covered and minimized windows; `percentage=50` halves either kind; `width` or `height` requests image pixels.
   Omitted sizing returns native dimensions. Request a preview such as `percentage=25`
   when full detail is unnecessary. Supply only one sizing parameter. Prefer elements for finding things and snapshots for confirming.

## Input details

- `click` moves the pointer there first. `button` is `left` (default), `right` or `middle`; `count`
  2 double-clicks. For a drag use `button` (press), `move`, `button` (release).
- `text` types a string through the keyboard layout, including punctuation and capitals; `\n` is
  Return. Click into the field first so it has focus. For longer text, put it on the clipboard
  (`PUT /api/clipboard`, tool `clipboard_write`) and press `ctrl+v` in the field; `GET /api/clipboard`
  (tool `clipboard_read`) returns what an application last copied, text or a PNG (its Content-Type says
  which), and a PNG body with `Content-Type: image/png` on the PUT puts an image on the clipboard.
- Files require their operation’s `files.*` grant and an explicit directory: `GET /api/files?path=@transfer` lists
  Downloads. Use `@home` or an absolute path for another directory. MCP `files` takes `path` and
  optional `hidden`, `sort`, `desc`, `offset`, and `limit`, returning the same paginated listing.
  `GET` and `PUT /api/files/{name}?path=…` download or upload an entry in that directory.
- `key` presses a chord and releases it: `ctrl+s`, `ctrl+shift+t`, `alt+F4`, `Return`, `Escape`,
  `Tab`, `Down`, `Prior` (Page Up), `F5`. Modifier names: `ctrl`, `shift`, `alt`, `super`. Anything
  else is an X keysym name or a single character; `ctrl+T` is the same as `ctrl+t` (write `shift` when
  you mean it). A chord with a key the layout doesn't have does nothing.
- `scroll` takes wheel lines; positive `dy` scrolls down.
- Input goes to whatever is under the pointer or has keyboard focus, exactly as a user's would. Click a
  window (or `activate` it) before typing into it. A human viewer may be connected at the same time;
  you share one pointer and keyboard with them.

## Windows and programs

- `activate` switches to the window’s workspace, raises and focuses it (and restores it if minimized); `close`, `minimize`,
  `unminimize`, `maximize`, `unmaximize`, `fullscreen`, `unfullscreen` do what they say; `move` and
  `resize` work on floating windows. These requests are fire-and-forget: check the window list
  afterwards.
- A `click` that aims past the desktop's edge at an X11 window (one that hangs past the edge) answers
  "ok" with a warning: Xwayland pins such a click to the edge. Move or resize the window first, or make
  the desktop larger. Wayland windows take clicks anywhere.
- `applications` lists what is installed (the desktop's `.desktop` launchers) and `launch` starts one by
  its `id`; `spawn` runs any shell command as a client of this desktop (`sh -c`), with the display
  variables set. Programs take a moment to map their window; poll the window list. A program that is
  already running elsewhere may just open a new window in that instance.
- `updated_ms` on a window is the time of its last redraw to the second. If it stops changing, the
  application is idle.

## What the answers mean when they fail

| Status | Meaning | What to do |
|---|---|---|
| 400 | invalid screenshot sizing | supply one positive width, height or percentage within the documented limits |
| 401 | missing or wrong bearer token | check `Authorization: Bearer` |
| 403 | permission denied | obtain a token with the grants required by this operation |
| 404 | no such window | the window closed; list again |
| 429 | another snapshot is in flight | one at a time; retry after it returns |
| 500 | the snapshot render failed | retry after checking the error |
| 501 | the server runs without `--elements` | use snapshots instead |
| 503 | the compositor or accessibility bus did not answer | reads may be retried; never automatically retry a semantic mutation with an uncertain outcome |
| 400, 415, 422 | the body wasn't JSON, lacked `Content-Type: application/json`, or had the wrong shape (plain-text message) | see `reference.md` for the shape |

Semantic errors include a `code`: `missing`, `stale`, `ambiguous`, `ambiguous_window`,
`disabled`, `unsupported`, `incomplete_tree`, `state_unavailable`, `bus_unavailable`,
`window_missing`, `window_unavailable`, `window_changed`, `tree_timeout`, `rejected`,
`invalid`, `cancelled`, or `uncertain`. A dispatched action cannot be undone by cancelling or timing out its response.
Never automatically retry an uncertain mutation; inspect the application first.
MCP tools return failures as tool errors.

## Things that surprise people

- Coordinates from `elements` are relative to the window; the window's own `x y` are output
  coordinates. Pass the window id to the input operations and you never have to add them.
- A window with `decoration: 32` has a title bar drawn by the compositor above it. Its elements list
  ends with that bar (`title bar`) and its `Close`, `Maximize`/`Restore` and `Minimize` buttons at
  `y: -32`: click those like any element (negative `y` is fine), or use the `window_control` tool.
- Two windows of the same application look alike in the list; use `title` and `focused`.
- A dialog is a new window with its own id. A file chooser is often a separate window too.
- Chromium and Electron applications need `--force-renderer-accessibility` on their command line to
  expose their content; without it you get `level: frame`. Firefox and GTK and Qt applications work as
  started by `spawn`.
- The screen is whatever size the connected viewer is; with no viewer it is 1920×1080.

## Desktop broadcasts

Broadcast workers repeat the newest picture at the requested frame rate. Unique pictures remain
limited by desktop refresh, normally 30 Hz with software rendering and 60 Hz with GPU rendering.
Destination failures retry until stopped, with backoff up to 32 seconds. Coincident audio and
network errors retry; an audio failure without a destination failure ends that output.


`broadcast_capabilities` reports encoder availability and limits. `broadcast_start` takes complete
settings: `request_id`, `label`, `url`, `stream_key`, `width`, `height`, `fps`, `bitrate_kbps`,
`audio` (`desktop` or `silence`), and `cursor` (boolean). Use a fresh request ID for each intended run.
Retry the identical request with the same ID for ten minutes to recover an uncertain response;
changing its settings conflicts. A retry never restarts a retained stopped run.

`broadcast_list` and `broadcast_get` return runtime IDs and status, never destination credentials.
`broadcast_stop` takes an `id` and is idempotent while that record is retained. All broadcast operations require `broadcasts.manage`. Starting also requires `desktop.view`,
and `audio.listen` when using desktop audio. `sending` means media transport is active, not that the service has made it public.

Broadcasts continue without browser viewers. Up to four independent H.264/AAC outputs can run.
Silent audio does not require the private audio service. Settings are not saved on the host;
browser presets belong to that browser and cannot be retrieved through MCP. Supply connection
settings yourself when using MCP. See the generated reference for the matching HTTP routes.

## Workspaces

Read `GET /api/workspaces` (MCP `workspaces`) for the shared active ID and workspace IDs/names.
Each window reports `workspace`, separate from `minimized`. `POST /api/control` accepts
`createworkspace`, `deleteworkspace` with `workspace`, `switchworkspace` with `workspace`, and
`movetoworkspace` with `id` and `workspace`. MCP provides `create_workspace`, `delete_workspace`,
`switch_workspace`, and `move_to_workspace`. Reads require `desktop.view`, mutations
`desktop.control`. IDs remain stable; workspace count has no configured limit. Deleting a populated
workspace moves its windows to the first remaining workspace. The last workspace cannot be deleted.
Moving a dialog moves its parent/transient family without switching desktops. Explicit activation
switches to the window's workspace and focuses it. Window-relative input can reach inactive
workspaces without switching the displayed workspace. Untargeted keys follow the shared keyboard
focus. Snapshots remain available. Workspaces share access and state across viewers.
