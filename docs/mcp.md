# MCP, input and the skill documents

Coding agents drive the desktop through the same operations as the HTTP API, so an agent can find a
button by name, click it, type, and check the result without interpreting pixels. This document covers
the design; [protocol.md](protocol.md) has the wire shapes and `skills/elsewhere/reference.md` the
generated schemas.

With `--url-prefix`, external clients prepend the public prefix to `/mcp` and HTTP routes.
See [reverse proxy setup](reverse-proxy.md) for both path-forwarding modes.

Sessions expire after 15 minutes without an open HTTP request or response stream. Each authenticated
request keeps its session active until its response finishes or disconnects, including cached replies
and resumed SSE streams. The idle clock starts when the last request or stream closes. Clients must
initialize a new session after expiry, indicated by `404`. Using another token's live session returns `403`.

Cleanup runs every 30 seconds. After the request body is received, initialization has a 30-second
deadline. Other session-less requests do not take the initialization gate. Cleanup waits for
in-progress initialization before discarding sessions without owners. A cancelled initialization
therefore leaves no permanent session. Token revocation and expiry also discard owned sessions.

## Decisions

| Question | Decision |
|---|---|
| Protocol | MCP over Streamable HTTP at `/mcp` on the existing server, with the `rmcp` SDK. No second port or process; works remotely and from the container. Agents that only speak stdio use the standard `mcp-remote` bridge. |
| Auth | Bearer authentication shares the HTTP middleware. Each tool enforces its operation permissions and reports denied grants as tool errors. Revocation and expiry cancel the affected token’s requests and streams. No OAuth. |
| Shape of the tools | One tool per operation, each a few lines calling an `App` method. The generated [tool reference](../skills/elsewhere/reference.md#mcp-tools) lists every tool from the router. Arguments use the API's own types where they exist (`Button`, the control ops) so the vocabulary is shared. |
| Results | JSON as text content for lists and elements, `image/png` content for snapshots, `ok` for fire-and-forget actions, and `isError` results carrying the API's error text so the model can react. |
| Documentation | The manual is the server's `instructions` at `initialize` and both skill files are MCP resources, so a client gets the documentation with the connection. |
| Screenshots for models | `snapshot` and `screenshot` default to native dimensions. Supply one of `width`, `height`, or `percentage` for previews; [sizing limits](desktop-api.md#screenshot-sizing). |

## Input

The compositor could always move the pointer, click and press keys: that is how the viewer works. What
was missing was a way in other than the viewer's binary WebSocket. `InputMsg` in `elsewhere-core` is that way:
`move`, `click`, `button`, `scroll`, `key`, `text`, served as `POST /api/input` and as tools.

- The server rejects missing windows with 404, then forwards
  one `Command::Input`. The compositor resolves window-relative coordinates against the geometry it has at
  that moment and emits a click's motion and button events in one go, so neither a moving window nor a
  human's pointer motion arriving in between can redirect it. Coordinates are output logical pixels or,
  with a window id, relative to that window's geometry, the origin element rectangles use.
- Keys are resolved where the keymap is. `key_for` in `input.rs` scans the active layout for the
  keycode producing a keysym at levels 0 to 3 and `level_mods` adds Shift, AltGr or both for the level,
  the convention of four-level layouts, so `text` types any character the layout has (`@` on a German
  layout is AltGr+q) and `key` accepts every xkb keysym name plus friendly modifier names. A lone letter
  in a chord is lowercased first, so `ctrl+T` is Ctrl+T, not Ctrl+Shift+T.
- A chord aborts as a whole when a keysym has no key in the layout, rather than pressing the modifiers
  alone; a character `text` can't produce is skipped with a warning. Press and release go out back to
  back; GTK, Firefox and Chromium process them in order, so no pacing was needed.
- `tap` releases only the keys it pressed itself: the `key()` guard drops a press for a key a viewer is
  already holding, and that key stays held for the viewer afterwards.

## Skill documents

Two files, both compiled in with `include_str!` and served at `/skill/`:

- `SKILL.md`, written by hand for an agent: the loop (windows, elements, act, read again, snapshot to
  confirm), input details, what the status codes mean, and the things that surprise people.
- `reference.md`, generated: the route table, the JSON schemas of `WindowInfo`, `ControlMsg`,
  `InputMsg` and the elements page (from `schemars`, the same derive rmcp uses for tool arguments),
  and every MCP tool with its description and input schema (from the tool router). The
  `reference_is_current` test compares the checked-in file with what the code generates, so it is
  regenerated with `UPDATE_REFERENCE=1 cargo test -p elsewhere-server reference` (after `make web`, which
the embedded viewer needs) and cannot silently drift.

## Verification

- In the Docker rig, `cargo test -p elsewhere-server mcp::sessions` checks repeated disconnects,
  cancellation between rmcp initialization and owner registration, handler destruction, idle expiry,
  active and resumed streams, cached notifications, ownership, deletion and revocation. Tokio's test
  clock advances the idle deadline. `python3 scripts/check-token.py` also exercises MCP disconnects
  and revocation of an open stream against the running compositor.
- A scripted MCP handshake with curl against a test compositor: `initialize` (server info,
  capabilities, instructions), `tools/list` matching the generated tool reference, `resources/list`
  and `resources/read`, and `tools/call` for `windows`, `elements`, `click`, `type` (text appeared in the editor) and `snapshot`
  (a PNG of the window's size), plus a tool error for an unknown window and `401` without the token.
- The input route through curl: click into an editor, type text with punctuation and capitals, `Return`,
  `ctrl+a`; the snapshot showed the typed lines selected.
- Key resolution has a unit test on the `us` keymap (letters, Shift for capitals and `plus`, `ctrl`,
  `Return`, `F5`).

## Semantic UI operations

`elements`, `element_action`, `element_text`, and `element_wait` share their implementation
with the HTTP routes in `api.rs`. All require `--elements`. Reads and waits use
`desktop.view`; actions and text replacement use `desktop.control`, independently of
viewer control ownership. The generated reference documents input and result schemas.

An exact role/name selector must match one element in a complete, unambiguous window tree.
References expire five minutes after their last issuance and retain the window ID, process ID, accessibility bus
identity, frame and object. The cache holds at most 4096 entries. Dispatch checks live
ownership and capabilities again. Compositor buttons use existing window control commands.
There is no coordinate fallback.

Pending accessibility requests have no fixed count limit. The scheduler batches tree reads by
window, with at most eight scans active and one per window. Each application has at most two active scans, one
reference revalidation and one mutation. Revalidation and mutations each have four active slots.
Admission rotates between competing tokens, including every token waiting for a shared reference
check. Windows belonging to an application without a process ID are scheduled separately.

Ready work starts on arrival, completion or permit release. A 100 ms sweep prunes abandoned work
while requests are pending. New reads and waits use scans started after their arrival. Mutations
obtain admission before scanning, so queued mutations retain neither old trees nor bus connections.
Completed observations are not cached for later requests. Reference waits share revalidation
results within an observation; queued reference checks retain target metadata and open their bus
connection only when admitted.

Tree walks visit at most 3000 objects and return at most 500 application elements; reaching a
bound marks the tree incomplete. Once admitted, a scan has a five-second deadline. A traversal
bound returns a marked partial tree. Connection or window-matching failure can return an error
because application ownership has not been established. Mutation revalidation has a five-second
deadline; dispatch and acknowledgement have ten seconds. Waits default to 30 seconds and allow
up to five minutes. Repeat observations use a shared 100 ms schedule. Their deadlines and cancellation
remain independent of admission and scan completion. Polling intervals may stretch under load.
MCP cancellation drops the operation; token expiry and revocation stop reads and waits.
An already dispatched mutation may finish after cancellation or a transport error. Its
outcome is uncertain, so callers must inspect state and must not retry automatically.
Mutation results describe the target before dispatch, not confirmation of a resulting UI state.

Text replacement reads back at most the requested UTF-16 length plus one within the dispatch
deadline. An acknowledgement without matching text returns `uncertain`. Password fields return toolkit acknowledgement without reading masked text back. Native Docker checks
cover GTK 3, Qt 6, Firefox and Chromium with accessibility enabled. Chromium may expose actions
without EditableText; such edits return `unsupported`. Firefox may acknowledge an edit without
applying it; readback detects that case. Toolkit acknowledgement alone is not UI confirmation.

Exact role/name selectors require a complete tree. References can resolve an object beyond the
truncated prefix by revalidating its live bus, frame, ancestry and capabilities; its bounds are
then unavailable. Repeated reads reuse references to the same live target. The capacity limit
can evict references to distinct targets, so clients must handle `stale` by reading again.
Waits retry unavailable application/state, bus, mapping and incomplete-tree errors within their deadline and report
the last such error in `last_error`. Zero timeout performs no read and returns unmatched.

Action success means toolkit acknowledgement. Some bridges acknowledge before running the
application callback, and others wait for it to finish. `rejected` is available only when the
toolkit reports rejection. Inspect the application after an action, including after a timeout.

A timeout during validation before a mutation is dispatched returns `tree_timeout` and can be
retried. After dispatch it returns `uncertain`; inspect the application before deciding whether
another action is needed.

## Workspaces

`workspaces` returns the shared active workspace ID and the workspace IDs and names. `windows`
reports each window's `workspace`. Reads require `desktop.view`. `create_workspace` adds a workspace
with an optional `name`; `rename_workspace` takes `workspace` and `name`. Names allow at most
256 UTF-8 bytes and no control characters. Creation uses the ID for a missing or blank name;
renaming requires a nonblank name and preserves ID, membership and active workspace.
Sessions start with one workspace.
`delete_workspace` takes `workspace` and moves its windows to the first remaining workspace. The
last workspace cannot be deleted. IDs remain stable and there is no configured count limit.

`switch_workspace` takes `workspace`. `move_to_workspace` takes `window` and `workspace`, moving the
transient family while retaining geometry and minimized state. Mutations require `desktop.control`
independently of viewer roles. They queue operations; read state to confirm completion.
Explicit `window_control` activation switches to the target workspace. Window-relative coordinate
input routes to its workspace without changing the displayed workspace. Untargeted keys follow the
shared keyboard focus. Snapshots and window streams remain available across workspace switches.
