# Tokens and permissions

Elsewhere starts with an empty token registry. Create an admin token under the same OS user,
configuration and execution environment as the server:

```sh
elsewhere token create --admin
# For a container:
docker exec <container> elsewhere token create --admin
```

This command works before startup and while the server runs. It creates a distinct token labelled
`Admin`, with every currently implemented permission and no expiry. It writes directly to SQLite,
without an API call or existing credential. Successful stdout is only the secret and a newline;
errors go to stderr with a nonzero exit status. Paste the secret into the browser connection dialog
or use it as `Authorization: Bearer <token>`. The bundled browser is a desktop viewer and requires
`desktop.view` in addition to the grants for its optional controls. API and terminal WebSocket clients
can use their operation grants independently.

Secrets are disclosed once at creation. SQLite contains their hashes, so an existing secret cannot
be retrieved. To recover access, run the command again and revoke any unwanted tokens through the
API. Startup prints setup instructions and never generates a token.

## Management API

`tokens.manage` permits creating, listing and revoking any token, including the caller. It is full
management authority: a holder can grant any implemented permission, including `tokens.manage`.
Innkeeper owns user assignments and convenience presets. Presets expand to explicit permission
lists in Innkeeper; Elsewhere's API accepts no presets. Elsewhere has no token-management UI.

| Request | Result |
| --- | --- |
| `POST /api/tokens` | `201` with `{ "token": "<secret>", "metadata": {...} }` |
| `GET /api/tokens` | `{ "tokens": [<metadata>, ...] }`, including expired tokens |
| `DELETE /api/tokens/{id}` | `204` after revocation, or `404` if absent |
| `GET /api/me` | `metadata`, `permissions`, `available_permissions`, `features`; available to any live token |

Creation accepts only `label`, `permissions` and optional `expires_at_ms`:

```json
{"label":"Support session","permissions":["desktop.view","audio.listen"],"expires_at_ms":null}
```

Metadata contains a canonical lowercase UUIDv4 `id`, `label`, integer `created_at_ms`, nullable
`expires_at_ms`, and sorted `permissions`. Times are milliseconds since the Unix epoch. Labels are
trimmed, contain 1–120 Unicode scalar values and no control characters, and need not be unique.
Expiry must be in the future and fit a signed 64-bit integer. Duplicate permissions are deduplicated;
an empty set is valid. Unknown names and extra creation fields are rejected.

Grants are immutable. Change access by creating a replacement and revoking its predecessor. No
wildcards, role inheritance or future grants are implied by an admin token.

## Permission mapping

The same grants govern HTTP, MCP, WebSockets and outgoing events. A valid token without a required
grant receives `403` over HTTP or an MCP tool error; invalid, revoked and expired credentials receive
`401`. Unauthorized WebSocket actions have no effect. Server feature availability is separate from
permission: a camera grant does not enable a server started without webcam support.

| Permission | Operations |
| --- | --- |
| `desktop.view` | Desktop/window streams, windows, screenshots, elements, installed application metadata/icons, notifications, codec discovery, shared display settings |
| `desktop.control` | Pointer, keyboard, touch, window actions, taking/handing off control, notification actions, kiosk and resolution settings |
| `apps.launch` | Launch an installed application |
| `commands.execute` | Execute a command or open an interactive terminal |
| `server.manage` | Quit the server |
| `audio.listen` | Desktop playback, mixer state/levels and mixer controls |
| `microphone.send` | Send microphone audio while controlling the desktop |
| `camera.send` | Send camera video while controlling the desktop |
| `clipboard.read` | Clipboard contents, state, previews and live clipboard events |
| `clipboard.write` | Write or clear the clipboard |
| `files.browse` | Directory listings |
| `files.upload` | Upload file contents |
| `files.download` | Download a named file |
| `files.manage` | Create directories, rename entries and delete files |
| `dragdrop.upload` | Drag files into the desktop |
| `broadcasts.manage` | Broadcast capabilities, status, start and stop |
| `tokens.manage` | Create, list and revoke tokens |

Desktop input additionally follows controller ownership; window sessions can control their own
window. Mixer changes, microphone and camera require the current desktop controller. Stream codec,
quality, speed target and encoding effort need no extra permissions.

A desktop file drop requires `dragdrop.upload`, `files.upload`, and desktop control. File paste
requires `clipboard.write` plus `files.upload`, including direct URI-list writes. Clipboard file
lists and downloads require `clipboard.read` plus `files.download`. Neither file drops nor file
pastes require `files.browse`. Staged batches and their results belong to the token that uploaded
them. Physical staging paths include its token ID. URI-list writes accept only files from the
transfer folder or the caller’s owned staging batches.

Broadcast start also requires `desktop.view`, plus `audio.listen` for desktop audio. A broadcast
belongs to its creating token even when no browser remains connected.

## Revocation and expiry

Revocation deletes a token and its grants transactionally. Once committed, its authorization is
cancelled and its desktop/window connections, terminals, transfers, RTC connections and broadcasts
are stopped. Cleanup continues if the management request disconnects. Input is released only when
owned by the affected session/token. Other tokens remain usable. Expiry invokes the same cleanup,
including idle connections, while retaining the record for listing and explicit deletion.

MCP session IDs, cached results and resumed event streams are bound to their creating token.
Revocation also closes those sessions.

Completed actions are not reversed. An already launched application or published file remains.
Work admitted before revocation may finish its current synchronous operation; subsequent work is
denied. The HTTP response and WebSocket transports observe cancellation even under backpressure.

## Storage and backups

Structured persistent state lives in `state.sqlite3` under `$XDG_CONFIG_HOME/elsewhere`, or
`~/.config/elsewhere`. Tokens are the current structured persistent records. TLS keys/certificates
and transferred file contents remain files; desktop connections and media state stay in memory.

SQLite uses bundled `rusqlite`, embedded `rusqlite_migration` SQL, WAL, full synchronization,
foreign keys and a busy timeout. Initialization validates schema and stored records before serving;
errors fail startup without resetting state. The CLI shares the store, so committed CLI tokens
work immediately in the running server. Database and journal files have private permissions.

```sql
CREATE TABLE tokens (
    id TEXT PRIMARY KEY NOT NULL,
    secret_hash BLOB NOT NULL UNIQUE CHECK (length(secret_hash) = 32),
    label TEXT NOT NULL CHECK (length(label) BETWEEN 1 AND 120),
    created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
    expires_at_ms INTEGER CHECK (expires_at_ms IS NULL OR expires_at_ms > created_at_ms)
) STRICT;
CREATE TABLE token_permissions (
    token_id TEXT NOT NULL REFERENCES tokens(id) ON DELETE CASCADE,
    permission TEXT NOT NULL CHECK (length(permission) > 0),
    PRIMARY KEY (token_id, permission)
) STRICT;
```

A secret is 32 random bytes encoded as 64 lowercase hexadecimal characters. Store SHA-256 of those
exact 64 ASCII bytes as a 32-byte BLOB. Public UUIDv4 IDs are separate from credentials. High-entropy
random secrets do not need password-style salting. Metadata, lists, logs and session records contain
no plaintext secret or digest.

For a filesystem backup, stop the server and finish all CLI commands first. Copy `state.sqlite3`
together with any `state.sqlite3-wal` and `state.sqlite3-shm` files still present. Restore that set
while all processes are stopped, preserve private permissions, then start the server. Do not mix a
database with journal files from a different backup. TLS files and transferred files need their own
backup if they must also be restored.

Permissions gate application features; they do not isolate programs sharing the server's OS user.
A desktop terminal, command, or filesystem access that reaches the database can manage credentials
directly. Keep that limit in mind when assigning desktop control, file access or execution grants.
