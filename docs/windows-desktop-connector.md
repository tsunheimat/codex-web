# Windows connector for the running Codex Desktop

The web/mobile client connects to the codex-web gateway. The Windows connector
opens an outbound authenticated WSS connection to that gateway and forwards
supported operations to the already-running Desktop through its local pipes.
Desktop owns the account, conversations and execution. There is no inbound Windows
listener, replacement app-server, Desktop patch or User-Agent change.

## Prepare the gateway

Add a separate entry to the gateway's `backends` array:

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

Set that environment variable privately on the gateway to a random secret of at
least 32 characters. Use the same secret when configuring Windows. This is a
gateway-to-bridge credential, separate from the web viewer token and Desktop's
ChatGPT account credentials. Do not put it in a URL or send it in a chat message.
The HTTPS proxy must forward WebSocket upgrades for `/api/v1/desktop`, including
any gateway base-path prefix. Restart the gateway after updating its configuration.

## Build a local Windows package

Install Node.js 22.13 or later on Windows. From the repository, after dependencies
are installed, build into an empty folder on a local disk:

```powershell
node scripts/build_windows_desktop_connector.cjs --output C:\codex-web-connector
```

The package contains the connector and its WebSocket dependency. It needs no
Electron installation or repository build on Windows. Local storage also avoids
depending on mapped network drives at sign-in. This tool does not change Windows
execution policy; machines requiring signed scripts need their normal approved
script-signing process.

Open PowerShell as the same ordinary Windows user who runs Desktop:

```powershell
cd C:\codex-web-connector
.\scripts\windows\codex-web-desktop.ps1 -Action Configure -Gateway https://gateway.example.com -Backend windows-desktop
.\scripts\windows\codex-web-desktop.ps1 -Action Check -Backend windows-desktop
```

Replace the example URL and backend ID with the gateway's actual values. Configure
asks for the bridge token in a hidden prompt, or reads it from the process's
`CODEX_WEB_DESKTOP_AGENT_TOKEN` environment variable when already set. `-TokenEnv`
selects another process environment variable for setup. For a private gateway CA,
pass `-CaCertificate C:\certificates\gateway-ca.pem` to Configure. TLS verification
remains enabled.

Configure copies a small runtime into
`%LOCALAPPDATA%\codex-web\desktop\BACKEND\runtime`, restricts the connection
directory to the current user and protects the token using Windows DPAPI. It does
not store the token in plaintext JSON, command-line arguments or scheduled tasks.
Moving the encrypted token to another user/machine will not configure that host;
run Configure there with its authorized token instead.

Check is temporary and read-only. It verifies the actual gateway authentication
and Desktop pipe connection, prints the detected version and available
capabilities, and exits. It rejects any incoming message, upload or approval
mutation. It does not create the durable command journal. It also does not prove
photo execution or Computer Use. Only one bridge can occupy a backend ID: run
Check before starting the persistent bridge, or use the gateway status while the
bridge is running.

## Keep the connection running

For a foreground run:

```powershell
.\scripts\windows\codex-web-desktop.ps1 -Action Run -Backend windows-desktop
```

Run waits for Desktop to open. It never starts Desktop or another execution
runtime. The bridge reconnects after gateway/network loss and rediscovers Desktop
after its process restarts. Stop a foreground run with Ctrl+C.

For optional startup when this Windows user signs in:

```powershell
.\scripts\windows\codex-web-desktop.ps1 -Action InstallStartup -Backend windows-desktop
.\scripts\windows\codex-web-desktop.ps1 -Action Status -Backend windows-desktop
```

InstallStartup creates and starts `CodexWeb-Desktop-BACKEND` in Windows Task
Scheduler under the current user's interactive session, without elevation. It
uses the locally installed runtime, waits for Desktop, and retries a failed
connector up to three times. Stop any foreground run first. The computer must
remain awake, signed in and running Desktop for execution to remain available.

Logs are in `%LOCALAPPDATA%\codex-web\desktop\BACKEND\bridge.log`, with one rotated
previous log. Task Scheduler's Running state only means the connector process is
running; confirm the backend is connected in codex-web. The token and account
credentials are not logged.

To stop a scheduled connector and remove future sign-in startup:

```powershell
Stop-ScheduledTask -TaskName CodexWeb-Desktop-windows-desktop
.\scripts\windows\codex-web-desktop.ps1 -Action RemoveStartup -Backend windows-desktop
```

RemoveStartup by itself only removes future startup; it leaves an existing run
alone. Stop the connector before reconfiguring or updating its local runtime.
Desktop tasks continue to belong to Desktop when the connector disconnects.

## Current capabilities

| Operation | Unmodified Desktop connector |
| --- | --- |
| Discover and read existing Desktop-owned Codex tasks | Available |
| Send, steer and stop a Codex turn | Available through its Desktop owner |
| Upload images to a Codex task | Available; files staged on Windows and submitted to Desktop |
| Supported Codex command/file/question approvals | Available |
| Read and send text to existing native ChatGPT chats | Available when the app-tools pipe and routing context are ready |
| Create a conversation | Not exposed by this connector |
| Native ChatGPT attachment submission | No verified unmodified route implemented |
| Direct Computer Use session controls, approvals and presentation | No verified unmodified route implemented |

The Computer Use flag describes the connector's remote controls/presentation; it
is not a diagnosis of Desktop's ability to perform Computer Use. Desktop's own
tools and approvals remain owned by the original task. Do not enable missing
capabilities just because the gateway handshake succeeds.

Official Remote enrollment and message transport are not implemented by this
package. Static inspection of Desktop 26.908.40834 found its controller-side relay
and device-proof exchange; a callable external mapping into native ChatGPT upload
and the existing Computer Use owner remains unverified. The similarly named
`remote-middleware` asset is Segment middleware loading, and `remote-conversation-page`
handles cloud Codex conversations; neither establishes that mapping.

The optional patch remains a separate compatibility route. Missing operations
must be implemented against a verified receiving handler before the corresponding
gateway controls can be enabled. The unmodified connector does not require or
install that patch.

## Validation

`npm run test:desktop` covers bridge routing, read-only mutation rejection,
startup retries/cancellation, capability refresh, reconnection and receipt handling.
`npm run test:desktop:windows:live` builds a disposable local Windows package,
protects a temporary token, and runs Check through a certificate-verified local WSS
gateway against the real Desktop. It installs no sign-in task and sends no prompts,
uploads or Computer Use actions. Sign-in startup and the actual remote gateway
deployment require host-specific verification.
