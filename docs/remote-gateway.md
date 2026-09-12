# Remote session gateway

This upgrade adds a standalone server and a responsive web/mobile client next
to the existing desktop-compatible renderer. Both deployments remain available:

| Entry point                                      | UI and execution integration                                         |
| ------------------------------------------------ | -------------------------------------------------------------------- |
| `npm run server`                                 | Existing patched upstream renderer and Electron compatibility server |
| `npm run gateway -- /absolute/path/gateway.json` | New persistent session service and app-server connectors             |
| `npm run build:gateway:web`                      | Independent static client, also used by Capacitor                    |

The gateway owns upstream connections. Closing, suspending, reloading, or replacing
a client only detaches a viewer. A second device uses the same session ID and
runtime. Backend IDs are persistent execution identities: do not point an existing
ID at a different computer; add a new ID instead.

## Run the gateway

Use Node 22.13 or later. The journal uses Node's built-in SQLite module, which may
print an experimental warning on Node 22. Run one gateway process per database on
a local persistent volume. Do not put its WAL database on an NFS share or run
multiple replicas against it.

```bash
npm ci --ignore-scripts
npm run build:server
npm run build:gateway:web

# Optional: required for the interactive terminal, not for coding sessions.
npm rebuild node-pty --foreground-scripts

cp gateway.example.json gateway.json
# Edit the paths, backends, bind address and allowed frontend origins.
# Set CODEX_WEB_GATEWAY_TOKEN to a random secret of at least 32 characters
# in the service's private environment file or secret manager.
npm run gateway -- "$PWD/gateway.json"
```

The new gateway does not download or require the upstream Electron bundle. It
also does not install Codex on execution hosts. Authenticate the chosen Codex
installation on its own host before connecting.

Serve the gateway behind HTTPS. The access token grants access to **all configured
backends**; this initial version is a single-user/trusted-team service, without
per-user accounts or OIDC access rules. API calls use an Authorization header.
WebSockets authenticate in their first frame, with a five-second deadline and an
exact Origin check. Tokens are never put in URLs, logs, or the backend listing.

The web/mobile client keeps its token in memory. A cold launch requires signing
in again. It caches session summaries, the current snapshot and drafts locally;
Sign out clears the current server's caches. Device keychain enrollment and push
notifications are not included in this iteration.

## Configure execution hosts

Every backend has `id`, `label`, an absolute host-side `cwd`, and `transport`.
Transport settings and SSH keys are server-side configuration, never frontend
input. Backends connect independently, so an unavailable computer does not block
the session picker.

**Running Windows Desktop:** use the distinct `desktop` transport and
[Windows bridge launch instructions](remote-desktop.md). It attaches to the
existing Desktop through local pipes and connects outbound to this gateway.

**Existing app-server over TLS:**

```json
{
  "id": "desktop",
  "label": "My desktop",
  "cwd": "C:\\Users\\me\\projects",
  "transport": {
    "type": "websocket",
    "url": "wss://desktop.example.com/app-server",
    "tokenEnv": "DESKTOP_APP_SERVER_TOKEN"
  }
}
```

`tokenEnv` names an environment variable on the gateway. It supplies an upstream
Bearer header and is optional only when the endpoint's deployment permits it.
Plain `ws://` is accepted only on loopback. Use `ssh-websocket` for a plain remote
listener. Redirects are disabled and the gateway never starts a replacement
runtime when attachment fails.

**Existing local Unix WebSocket endpoint:**

```json
{
  "id": "shared-desktop",
  "label": "Desktop shared runtime",
  "cwd": "/home/me/projects",
  "transport": {
    "type": "unix",
    "socketPath": "/run/user/1000/codex/app-server.sock"
  }
}
```

**Outbound companion for a computer behind NAT:** configure the backend as
`type: "companion"`, set its `agentTokenEnv`, and run the companion on the
computer:

```bash
export CODEX_WEB_COMPANION_GATEWAY=wss://gateway.example.com
export CODEX_WEB_COMPANION_BACKEND=my-computer-companion
export CODEX_WEB_COMPANION_TOKEN='a-separate-random-agent-token'
export CODEX_WEB_COMPANION_ROOT=/home/me/projects
node scripts/codex_web_companion.cjs
```

The companion starts the local app-server once, forwards its structured stdio
over the authenticated outbound socket, and reconnects that socket with an
exponential backoff. The gateway never accepts browser-supplied companion
credentials. A companion reconnect cannot replay an in-flight RPC; the gateway
marks its delivery unknown and reconciles from authoritative thread history.
Set the gateway process's `CODEX_WEB_COMPANION_AGENT_TOKEN` to the same secret
as the companion's `CODEX_WEB_COMPANION_TOKEN`, and keep both values outside
the checked-in JSON configuration.
`CODEX_WEB_COMPANION_ROOT` is the only workspace exposed to companion file
operations; symlink escapes and paths outside it are rejected.

**Codex over SSH stdio:**

```json
{
  "id": "dev-server",
  "label": "Development server",
  "cwd": "/srv/projects",
  "transport": {
    "type": "ssh",
    "ssh": {
      "host": "me@dev.example.com",
      "identityFile": "/home/gateway/.ssh/id_ed25519",
      "knownHostsFile": "/home/gateway/.ssh/known_hosts"
    },
    "command": "/usr/local/bin/codex",
    "args": ["app-server", "--listen", "stdio://"]
  }
}
```

OpenSSH config aliases are supported. Host key verification is strict and batch
mode disables interactive prompts. Provision a verified known-hosts entry before
starting the gateway. A changed key fails the connection. SSH commands and paths
are quoted separately; frontend paths travel over stdin JSON for file operations.

This transport starts a runtime in an SSH channel. It survives phone/browser
disconnection while the gateway and SSH channel remain alive. It does not promise
runtime survival when that channel or the gateway fails.

**SSH attachment to an independently supervised app-server:**

```json
{
  "id": "persistent-dev",
  "label": "Persistent development runtime",
  "cwd": "/srv/projects",
  "transport": {
    "type": "ssh-websocket",
    "ssh": {
      "host": "dev-server",
      "knownHostsFile": "/home/gateway/.ssh/known_hosts"
    },
    "host": "127.0.0.1",
    "port": 4500,
    "tokenEnv": "DEV_APP_SERVER_TOKEN"
  }
}
```

Run the app-server under the target machine's supervisor, listening on its
loopback interface. The gateway uses `ssh -W` to tunnel the actual WebSocket
handshake. This is distinct from launching a new app-server on every connection.
The gateway only closes its tunnel on shutdown; it never kills the external
runtime. Uninterrupted work still depends on the target runtime's own behavior.

The transport uses the documented app-server handshake (`initialize`, then
`initialized`) and structured commands. WebSocket transport and native desktop
integration should be tested against your installed runtime version.
[Official app-server protocol](https://learn.chatgpt.com/docs/app-server).

### Use Codex's official Remote host relay

For a host that should also be available through OpenAI's supported Remote
clients, start or enable Codex Remote on that host first:

```bash
codex remote-control start
```

The gateway's **Official Remote** panel calls the app-server's
`remoteControl/*` methods to show status and create a short-lived pairing code.
The code is shown only to the authenticated gateway viewer; it is never placed
in a URL or backend summary. Pair the official Codex client using that code.
This is a host-control surface, not a reimplementation of OpenAI's relay
protocol.

An app-server connection does not automatically provide native ChatGPT
attachments or Computer Use. Those remain capabilities of the official
Desktop/Remote host and are reported separately from `codex` in the backend
capability list.

## Separate web and mobile deployments

The gateway can serve `scratch/gateway-web` through `webRoot`, or you can omit
`webRoot` and deploy that directory on a separate static server. Enter the gateway
URL at login. Add the exact frontend origin to `allowedOrigins`, for example:

```json
"allowedOrigins": [
  "https://codex-ui.example.com",
  "capacitor://localhost",
  "https://localhost"
]
```

No wildcard origins are accepted. The last two entries are for the packaged iOS
and Android clients. Do not configure Capacitor's `server.url` or unrestricted
navigation: the native shell must load the bundled client assets. The first
client bundle is approximately 67 KiB gzipped; terminal code loads only when the
terminal panel opens. Session caches are rendered during reconnection. The same
static bundle includes an installable PWA manifest and a shell service worker.
The worker caches only same-origin static assets and navigation shells; API,
WebSocket, upload, download, and terminal requests always go to the live
gateway. A PWA install does not make background JavaScript reliable; accepted
work continues because the gateway owns the session.

```bash
# Generate the standard native projects on the development computer:
npm run mobile:add:android
npm run mobile:add:ios

# After frontend changes:
npm run mobile:sync
npx cap open android
npx cap open ios
```

Android Studio/Android SDK and macOS/Xcode are needed for native builds. Choose
your signing identity there. Generated `android/` and `ios/` projects are ignored;
the checked-in Capacitor config and lockfile reproduce the shell. No signed APK,
IPA, background-transfer integration or native secure-storage plugin is included.

The file input supports choosing photos/files in the WebView. The UI distinguishes
an upload in progress from an accepted task. It does not claim that an upload
continues after the OS suspends the WebView; finish the upload before closing the
app. A task accepted by the gateway continues independently of the WebView.

## Keep using the original renderer

The legacy renderer's IPC, ChatGPT pubsub relay, uploads, downloads and local-image
URLs now use `src/browser/server-config.ts`. Its static `server-config.js` loads
before preload. To point a separately deployed renderer at its compatibility
server, edit the deployed file:

```js
window.__CODEX_WEB_CONFIG__ = {
  serverBaseUrl: "https://desktop-bridge.example.com",
};
```

On that compatibility server set:

```bash
CODEX_WEB_ALLOWED_ORIGINS=https://your-renderer.example.com
CODEX_WEB_RUNTIME_OWNERSHIP=external
```

Ownership accepts `owned` or `external`. If omitted, the existing Unix-socket
environment behavior is preserved. This flag describes lifecycle ownership; it
does not configure the endpoint. Keep the existing runtime/proxy configuration.

The legacy server still relies on its trusted authenticating reverse proxy.
Cross-origin cookies must be configured at that proxy; a same-site deployment is
preferable when browsers block third-party cookies. Changing the frontend URL
does not make the legacy Electron IPC protocol interchangeable with the gateway's
session API. Existing renderer streaming/approval recovery remains its existing
behavior; it does not acquire the new gateway's durability guarantees.

## Session guarantees and API

| Event                                              | Gateway behavior                                                               |
| -------------------------------------------------- | ------------------------------------------------------------------------------ |
| Phone suspends; browser closes; viewer disconnects | Retain upstream connection and continue consuming runtime events               |
| Reconnect from another device                      | Synchronize the same session from its current snapshot and cursor              |
| Event cursor is older than retention               | Return a current snapshot and `reset: true`                                    |
| Prompt HTTP reply is lost                          | Retry the identical `clientCommandId`; the server returns the existing command |
| Runtime acknowledgement is lost                    | Persist `unknown`; inspect `thread/read`; never replay `turn/start`            |
| Approval answered from two devices                 | First response claims it; subsequent responses receive HTTP 409                |
| Runtime reconnects or gateway restarts             | Old approval IDs become stale; they cannot authorize a new runtime             |
| Gateway restarts with an external runtime          | Reattach and reconcile available history; no automatic work replay             |
| Owned local/SSH runtime exits                      | Reconnect/recover available history; interruption is possible                  |

Commands progress through `received → dispatching → accepted`, or `failed` /
`unknown`. `accepted` is a runtime acknowledgement, not a completion claim. Turn
status and pending approval state are separate. The request ID used with Codex is
not the persistent client command ID.

The gateway journals at most 2,048 events and 16 MiB per session, with oversized
events pointing clients to the snapshot. Snapshot and cursor are read in the same
synchronous owner operation; listeners are already installed before delivery.
Slow viewers are disconnected and synchronize again instead of blocking the
runtime reader. The initial client replaces its state with the supplied snapshot;
it must not apply the included historical deltas on top of that snapshot.

Command deduplication records remain in the database. Uploaded files remain on
their host across restarts. Back up the gateway database consistently together
with its WAL or use SQLite's backup tooling. Conversation history remains on the
execution host, and losing the gateway database loses its command deduplication
records. There is no exactly-once guarantee across that loss.

| API                                                | Purpose                                                  |
| -------------------------------------------------- | -------------------------------------------------------- |
| `GET /api/v1`                                      | Protocol compatibility check                             |
| `GET /api/v1/backends`                             | Sanitized backend list and capabilities                  |
| `GET /api/v1/backends/:id/threads`                 | Recent upstream threads for import                       |
| `GET /api/v1/backends/:id/remote-control`          | Official Remote host status                              |
| `POST /api/v1/backends/:id/remote-control/:action` | Enable, disable, pair, or manage official Remote clients |
| `GET, POST /api/v1/sessions`                       | List sessions; create/import one with `clientCommandId`  |
| `GET /api/v1/sessions/:id?afterSeq=N`              | Snapshot, cursor, commands and pending approvals         |
| `POST /api/v1/sessions/:id/commands`               | `turn/start`, `turn/steer`, or `turn/interrupt`          |
| `POST /api/v1/sessions/:id/reconcile`              | Read authoritative history without starting work         |
| `POST /api/v1/approvals/:id`                       | Answer a live approval/input request                     |
| `WS /api/v1/events`                                | Authenticate, then subscribe to a session                |
| `GET /api/v1/backends/:id/files`                   | Browse the configured host workspace                     |
| `POST /api/v1/backends/:id/uploads`                | Separate bounded HTTPS upload                            |
| `GET /api/v1/backends/:id/download`                | Download a selected host file                            |
| `WS /api/v1/terminal`                              | Separate authenticated terminal stream                   |

An events client first sends `{ "type": "authenticate", "version": 1, "token":
"..." }`, waits for `ready`, then sends `{ "type": "subscribe", "sessionId":
"...", "afterSeq": 0 }`. Credentials never belong in the WebSocket URL.

## Files and terminals

The `stdio`, `ssh`, and `companion` transports have explicit host channels for files and
terminals. Python 3 is required on that host for files; tmux is required for
terminals. Files are confined to the configured `cwd`, including checks against
symlink escapes. Listings are bounded to 1,000 entries; uploads/downloads to
10 MiB. Uploads use private random filenames under `.codex-web-uploads`, with a
100 MiB quota per workspace. Remove old uploads through host maintenance when
they are no longer needed by tasks.

When an existing thread is imported, the gateway records the thread's own host
workspace. Subsequent file browsing, uploads, downloads, and terminal sessions
must include that session ID so they operate in the same project as Codex. A
backend's configured `cwd` is used only until a new thread or import returns its
authoritative working directory.

Terminal access uses a real PTY and tmux, including resize, keyboard input and a
bounded replay tail. Disconnecting a terminal viewer leaves the gateway's PTY
alive. When a gateway's SSH terminal closes, tmux remains on the target. Reopening
attaches to the named session. Pressing a terminal's shell exit command has its
normal tmux/shell meaning.

WebSocket, Unix-socket and SSH-WebSocket backends do not acquire a filesystem/PTY
channel merely by connecting. Their file/terminal controls are disabled. There is
no fallback to gateway-local paths for those targets.

## Remote Desktop adapter

The `desktop` transport uses `DesktopConnection`, separate from `AppServerConnection`.
The [Windows bridge](remote-desktop.md) attaches to the already-running Desktop;
it never starts an app-server, companion, or replacement runtime. Native ChatGPT
text and history use Desktop's app-tools handlers. Native upload and Computer Use
control gaps name the exact renderer/helper interfaces in the protocol reference.
Bridge validation covers its own routing, framing, approvals, TLS and reconnect
behavior. It does not require retesting the user's established native features.

## Validation

`npm run test:gateway` covers real WebSocket connections to deterministic runtime
fixtures, disconnect/reconnect, acknowledgement loss, durable restart recovery,
approval races, host isolation, authentication/CORS and target-root file handling.
`npm run build:gateway:web` also type-checks the shared client and UI. Additional
browser and transport tests are documented in the PR's validation results.

The legacy full `npm test` and browser lifecycle tests also require the prepared
upstream desktop bundle and matching Codex runtime. Do not treat unavailable
native-desktop, real-SSH, signed-mobile or live-account tests as passed.
