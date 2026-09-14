# Remote Desktop mode

The unmodified-Desktop bridge is the default. The proposed patched adapter is an
optional compatibility mode pending separate approval, not a mandatory dependency.
See [the interface/official Remote evidence and review diff](native-adapter-review.md).

The Windows bridge attaches to **already-running Codex Desktop** and opens an
authenticated outbound WSS connection to the existing gateway. The original Desktop
renderer, served by the compatibility server in gateway mode, uses the gateway's
sessions, command journal, event synchronization and persisted history. Desktop
retains account authentication and execution ownership on Windows; the bridge
shares Desktop's signed-in identity with the renderer unless it is started with
`--private-account`.

Codex projections keep a recent history window within 6 MiB and clip individual
display strings at 20,000 characters. The UI marks truncated history; full history
remains in Desktop. This keeps long conversations below the WSS message limit.

## Gateway registration

Build the server as usual. Add a new backend ID to the gateway configuration (also shown in `gateway.example.json`):

```json
{
  "id": "windows-desktop",
  "label": "Windows Codex Desktop",
  "cwd": "C:\\Users\\me\\projects",
  "transport": {
    "type": "desktop",
    "agentTokenEnv": "CODEX_WEB_DESKTOP_AGENT_TOKEN"
  }
}
```

Set `CODEX_WEB_DESKTOP_AGENT_TOKEN` in the gateway's private environment to a
random secret of at least 32 characters. Set the **same bridge secret** on Windows.
It is separate from the web/mobile `CODEX_WEB_GATEWAY_TOKEN` and from all Desktop
account credentials. `cwd` is display/default project metadata, not permission to
read arbitrary host files. Preserve existing local, SSH, WebSocket and companion
backend entries. Do not repoint an existing runtime backend ID to Desktop.

Forward WebSocket upgrades at `/api/v1/desktop` through the gateway's HTTPS reverse
proxy. The existing viewer endpoint remains `/api/v1/events`. No inbound Windows
port is needed. A gateway hosted below a URL prefix is supported by passing that
prefix in the bridge URL. Desktop transport rejects `command`, `args`, and other
execution configuration.

## Launch on Windows

For local installation, a protected bridge token, a read-only connection check and
optional Windows sign-in startup, use the [Windows connector setup](windows-desktop-connector.md).
The direct command below remains available.

Use Node 22.13 or later and run under the same Windows account as Desktop.
From this repository, after installing dependencies with `npm ci --ignore-scripts`:

```powershell
$env:CODEX_WEB_DESKTOP_AGENT_TOKEN = '<same-random-bridge-secret-as-gateway>'
node scripts/codex_web_desktop_bridge.cjs --gateway wss://gateway.example.com --backend windows-desktop
```

The packaged command is:

```powershell
codex-web-desktop-bridge --gateway wss://gateway.example.com --backend windows-desktop
```

Optional arguments: `--token-env NAME` selects a different private environment
variable; `--state C:\absolute\bridge.sqlite` selects the durable command journal.
`--wait-for-desktop` waits for the user's Desktop to open instead of failing at
startup. `--check` verifies Desktop and gateway authentication, rejects mutations,
prints capabilities and exits; it never enables the optional adapter.
`--native-adapter-config PATH` connects the separately approved in-process native
binding. It is optional; the baseline bridge remains unchanged without it. See
[the exact patch, installation and rollback procedure](native-adapter-installation.md).
By default the journal lives at `%USERPROFILE%\.codex\codex-web-desktop\BACKEND.sqlite`.
Keep it on the Windows host's local filesystem. Standard Node certificate trust
applies; use `NODE_EXTRA_CA_CERTS` for a private gateway CA. Certificate validation
is never disabled. Plain WS is accepted only for loopback development.

The bridge discovers the running main process, its installed ASAR package, the
application version, Windows package version, and the versioned IPC method table
without executing bundled JavaScript or changing installed files. Its first local
endpoint is `\\.\pipe\codex-ipc`. This installation was verified as app
`26.908.40834`, Windows package `26.908.4834.0`.

The separate native app-tools endpoint is discovered from
`CODEX_APP_TOOLS_PIPE_PATH`, or by a bounded read-only `tools/list` probe of the
application's local pipe candidates. Native tools need a real Codex conversation
as routing context. The bridge uses `CODEX_WEB_DESKTOP_CONTEXT_THREAD`, inherited
`CODEX_THREAD_ID`, or a discovered Desktop-owned local conversation. This is only
the app-tools caller context: the target ChatGPT conversation has its own native
ID and is never resumed in a Codex runtime.

In the frontend choose **Windows Codex Desktop → Open Desktop conversation**.
The picker distinguishes native **ChatGPT** chats from Desktop-owned **Codex**
threads. Creation is disabled because the follower bus has no create-conversation
handler. The backend's capabilities and detected version appear in its summary.

## Implemented behavior and precise limits

| Operation                                | Bridge behavior                                                                                                                                                                                                                          |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Codex attachment/history                 | Owner discovery, targeted follower subscription, explicit history hydration, canonical `turnHistory` and live `tail:*` projection                                                                                                        |
| Codex prompt/steer/stop                  | Versioned `thread-follower-*` requests routed to the discovered Desktop owner, inheriting Desktop settings                                                                                                                               |
| Codex approvals                          | Command, file and question replies routed to Desktop; original request identity retained and completed requests reconciled                                                                                                               |
| Codex images                             | Upload through the gateway into the bridge's private Windows upload directory; only files staged by this bridge are accepted as image input                                                                                              |
| Native ChatGPT text                      | Existing native conversation discovery, reading and `send_message_to_thread` through Desktop app-tools; no app-server substitution                                                                                                       |
| Native ChatGPT history                   | Bounded recent history from `read_thread`, refreshed every three seconds for up to eight attached native chats; polling continues without viewers                                                                                        |
| Native ChatGPT attachments               | Implemented through the version-pinned renderer adapter: processed native upload IDs and dimensions are consumed by `Iqr`/`Jqr` and submitted intact through `Rqr`. Disabled until the reviewed Desktop patch is approved and connected  |
| Native Computer Use control/presentation | Implemented as observation of the original `ire`/`ore` owner, pending approval map, screenshot results and presentation dispatch. Explicit stop uses that owner's `Ge.closeActiveTurn`. Disabled until the approved binding is connected |

The existing Desktop's native chat, uploads and Computer Use remain established
working features. The last two rows require the separately approved loading change;
fixtures do not enable production capabilities. See [handler trace and provenance](desktop-protocol-reference.md).

Image uploads are limited to 5 MiB each, a 100 MiB staging quota, and PNG/JPEG/GIF/WebP extensions. They are
stored under `%USERPROFILE%\.codex\codex-web-desktop-uploads` and survive viewer
and relay reconnects. Native ChatGPT uploads additionally have durable staged-file,
processed-attachment and prepared-message receipts, so completed native uploads
survive bridge restarts. Legacy Codex-only image staging retains its prior behavior.
File browsing, arbitrary host paths, terminal access, raw IPC, native helper calls,
JavaScript evaluation and debugging endpoints are not exposed by this backend.

## Reconnect and errors

One bridge keeps its local pipe attachment independently of viewers and of the
gateway WSS connection. Viewer disconnects do not unsubscribe, cancel a native
completion, stop a turn or answer an approval. WSS reconnects authenticate again,
restore saved gateway sessions and reconcile snapshots. Out-of-sequence patches
request a fresh owner snapshot. Desktop process reconnects rediscover its version
table and local interfaces; ownership is checked before submitting a mutation.

Both journals record a mutation before dispatch. A command ID has one payload;
repeated IDs return its recorded result. Missing acknowledgements and interrupted
dispatches stay **delivery unknown**. Reconnect never blindly replays a mutation.
Gateway approval claims prevent two viewers from answering the same request.
Approvals which cannot be rendered remotely stay with Desktop.

| Error                                  | Action                                                                                                                           |
| -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| No running Desktop package found       | Run as the Desktop Windows user; a CLI or VS Code process is not the Desktop installation                                        |
| Pipe ENOENT/ECONNREFUSED/EACCES        | Check the running app and Windows user/session; the bridge prints the exact endpoint                                             |
| Protocol unrecognized/version mismatch | Update the bridge for the detected Desktop build; it does not guess a mutation protocol                                          |
| No Desktop owner/snapshot timeout      | Open the existing conversation in Desktop and reconcile; no runtime is spawned                                                   |
| App-tools pipe/origin unavailable      | Check the discovered app-tools endpoint and select a Desktop-owned Codex routing context; Codex follower use remains independent |
| Authentication rejected                | Match the backend ID and bridge token on both hosts; viewer credentials cannot register a bridge                                 |
| Delivery unknown                       | Inspect/reconcile Desktop history before intentionally submitting any new command                                                |

## Verification

`npm run test:desktop` builds the gateway and exercises real named-pipe/Unix-socket
protocol fixtures through an authenticated, certificate-verified WSS reverse
proxy. It covers ownership, canonical history, framing, image routing, approvals,
patch gaps, viewer and relay reconnects, native identity separation and crash
deduplication. The TLS test key is only a fixture and is never used by the launcher.

`npm run test:desktop:live` is an opt-in, read-only bridge check. It uses an existing
thread from `CODEX_WEB_DESKTOP_VERIFY_THREAD` or inherited `CODEX_THREAD_ID` and a
temporary local gateway. It sends zero prompts/uploads/Computer Use actions.
The installed-host check passed WSS gateway routing, a Desktop-owned conversation
with history, retained attachment during relay reconnect, and native ChatGPT
history through the separate app-tools handler.

`npm run test:renderer:browser` opens the original renderer through the
compatibility server in gateway mode against a bridge fixture: the Desktop
thread under its project, seeded history with an image, a prompt from the
original composer, the Desktop reply and the mobile viewport. Set
`CODEX_WEB_BROWSER_EXECUTABLE` when using an installed Chromium-family browser.

The new native tests cover the frontend-to-native-adapter fixture path, upload and
message acknowledgement loss, original Computer Use ownership/approval lifetimes,
frame bounds, and installation-proof gates. Static patch preparation is verified
against the installed package. Live execution of the new patch is awaiting approval;
no established Desktop feature checks were repeated. The full gateway suite is run
on Linux with no exclusions; Windows explicitly reports four POSIX-only tests as
skipped, rather than passing them. See the installation guide for the validation split.
