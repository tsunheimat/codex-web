# Optional native compatibility adapter: route evidence and patch review

**Status: unapplied, optional compatibility mode, pending separate approval.**
The unmodified-Desktop bridge remains the default. This review corrects the earlier
implication that the installed-file patch is an unavoidable dependency. The evidence
establishes limits in the interfaces codex-web implemented; it does **not** establish
that there is no usable unmodified-Desktop route.

Review artifacts for Desktop **26.908.40834**:

- [Installed-file review diff](reviews/native-adapter-26.908.40834/installed-files.diff)
- [Exact hash-pinned edits and added-module contents](reviews/native-adapter-26.908.40834/edits.json)
- [Component/archive hashes and review provenance](reviews/native-adapter-26.908.40834/manifest.json)
- [Installation boundary and rollback procedure](native-adapter-installation.md)

The diff formats both sides with the same formatter and includes only changed
hunks and the six added modules. It is for review, **not `git apply` against a raw
minified bundle**. The edit recipe and raw hashes specify the actual changes.
Original/proposed ASAR binaries, account data, local approval secrets and
machine-specific user paths are not published.

## What the existing interfaces establish

| Surface                                   | Examined behavior                                                                                                                                                                                   | Supported conclusion                                                                                                                                                                |
| ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `\\.\pipe\codex-ipc`                      | Versioned owner/follower registration, snapshots, Codex turns and selected approval replies                                                                                                         | No native ChatGPT upload/submission or original Computer Use socket-subscription operation was identified in this registry. This is a limit of that registry, not all of Desktop    |
| Desktop app-tools pipe                    | `tools/call` reaches `callDynamicAppTool`, the ready renderer and its handler switch. Stock `send_message_to_thread` accepts a prompt, not attachments, and its native ChatGPT branch reaches `$qr` | That stock text handler cannot represent the requested image message. Increasing codex-web's allowlist does not add a native handler                                                |
| Current gateway **Official Remote** panel | Calls `remoteControl/status/read`, enable/disable, pairing and client-management methods                                                                                                            | It manages Remote enrollment/host state. It is not a Remote data-plane client or a native-operation adapter                                                                         |
| Official Remote product                   | Official clients work with ChatGPT/Codex chats, host files, approvals, screenshots and Computer Use                                                                                                 | A blanket claim that unmodified Desktop cannot provide these capabilities is unjustified. The specific third-party photo/upload RPC and owner-session route still need verification |

The product-level statement is supported by OpenAI's
[Remote connections documentation](https://learn.chatgpt.com/docs/remote-connections).
It is not a published third-party wire specification or a live verification of
the exact operations against this installed build.

## What was and was not examined in official Remote

**Before this review:** the gateway's Remote administrative methods and some
`remote-hosted-pip-*` names were inspected. The complete official Remote native
dispatch path was not traced. Those names and administrative methods were not
sufficient evidence to rule out an unmodified route.

**In this review:** static inspection followed the installed Desktop controller
transport through these concrete points:

1. `main-D8abTQQE.js`: `createAppServerConnection` → `W5` → `$Ce`. The Remote branch
   explicitly requires a Desktop auth app-server client and a device-key client.
2. `$Ce` targets `/codex/remote/control/client`; `$D` obtains auth headers and `eO`
   enrolls/refreshes the controller. When no enrollment exists and no step-up
   provider is available, `eO` rejects with an explicit-settings-authorization error.
3. `src-CCXHtyvY.js`: `b$.open` performs enrollment, auth-header refresh and `C$`
   connection setup. `C$` sets client/protocol headers and handles device-key
   challenges when the enrollment requires proof.
4. `main-D8abTQQE.js`: `kXe` loads `remote-control-device-key.node` on **Windows or
   macOS**. `jXe` validates signed connection/enrollment claims, including nonce,
   audience, client/account identity, target origin/path, expiry and scope. Windows
   itself is not shown as a blocker here.
5. `b$` and `S$` multiplex `client_message` / `server_message` envelopes using
   `client_id`, `env_id`, `stream_id`, sequence numbers, acknowledgements, chunks
   and subscription cursors. `S$.send` accepts JSON-RPC **objects**; `A$` checks
   object shape, not a photo/Computer Use method denylist. `S$.handleServerMessage`
   delivers the reassembled JSON-RPC message to the app-server connection layer.

This is the installed **desktop-to-Remote app-server controller path**. It is not
proof of the entire mobile Remote/native application path. The following were
**not established**:

- The receiving host dispatch from that relay into native ChatGPT upload,
  attachment-aware submission, and the existing Computer Use owner/session.
- The exact mobile/native Remote operation schemas and capability negotiation.
- Whether codex-web can reuse an existing authorized controller locally or enroll
  its own controller while keeping authentication/device signing on Windows.
- A live allowed/denied response for either requested native operation over Remote.

No pairing, enrollment, key creation, authentication extraction, Remote feature
toggle, or live native-feature test was performed during this review.

### What specifically prevents direct reuse today

There is no verified operation-specific prohibition to cite. The concrete blockers
are in **our integration**:

- codex-web does not implement the enrollment/device-proof exchange or the Remote
  envelope/stream protocol. Its gateway token and direct JSON-RPC/WebSocket adapter
  cannot simply be pointed at the official relay endpoint.
- The host-native dispatch mapping described above has not been implemented or
  verified. Sending an invented upload method through a generic JSON-RPC carrier
  would not create the missing handler mapping.
- The current administrative panel and the two local pipes do not expose the
  initialized `$Ce`/device-key/renderer objects as an external reusable client.
  That does not rule out constructing an authorized Windows-local client.

Authentication staying on Windows is compatible with a future Remote integration;
it is not a reason that such an integration must export tokens to the gateway.
The appropriate next proof for that route is an authorized, Windows-local Remote
client plus a traced native receiver and a read-only owner/subscription operation.
Until then, neither “Remote works for these exact third-party calls” nor “Remote
cannot carry them” is established. The optional patch should not be recommended
on the premise that all unmodified routes have been exhausted.

## Exactly what the optional patch adds

The proposed installed-file change is limited to `app/resources/app.asar`:

| ASAR component                                 | Addition and invoked native handler                                                                                                                                   |
| ---------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `.vite/build/main-D8abTQQE.js`                 | Load `codex-web-native/entry.cjs`; bind the existing `je.callDynamicAppTool` context and `Ge`; observe `ire`, `ore` and the two `sendInlineMessageForView` call sites |
| `webview/assets/app-initial-d9bed9d614d8.js`   | Import the wrapper and add the explicit `codex_web_native_v1` case in `g0i`; supply lexical references to native functions                                            |
| `.vite/build/codex-web-native/entry.cjs`       | Private authenticated named-pipe transport, approved-hash checks and lifecycle wiring; no generic JS/IPC forwarding                                                   |
| `.vite/build/codex-web-native/host.cjs`        | Narrow native operations; original owner/socket and pending-approval tracking; separate capture/control state                                                         |
| `.vite/build/codex-web-native/receipts.cjs`    | Durable dispatch/prepared/completed/unknown receipts without account credentials                                                                                      |
| `.vite/build/codex-web-native/contract.cjs`    | Operation allowlist and size/identity limits                                                                                                                          |
| `.vite/build/codex-web-native/ipc.cjs`         | Framing helpers used by the new local channel; copied from codex-web's existing independent implementation                                                            |
| `webview/assets/codex-web-native-renderer.mjs` | Photo decoding and native upload, message preparation/submission and message-ID reconciliation wrappers                                                               |

### Photos

The wrapper calls native `uploadChatGptConversationFile` (`rkr`) and waits for its
create-file, byte-upload and processing flow. Its native file/library identities
are retained; image dimensions are measured in the renderer. `Iqr`/`Jqr` create
the real native message ID and `image_asset_pointer` parts. The same prepared
bundle is checkpointed and sent through `Rqr.userCompletionMessages`, which reaches
`Bqr`/`Gqr` and the existing completion stream. `oJr`, the native busy atoms and
the current parent ID protect target/submission consistency. It does not call
the stock text-only `send_message_to_thread` for the image message.

### Computer Use

The `ire` hook retains the **original** helper socket and `codexTurnMetadata`.
The `ore` hook observes the original `requestComputerUseApproval` ID/params and
pending-map membership. Answers invoke the original `handleApprovalResponse`;
explicit stop calls `Ge.closeActiveTurn` after `Ge.hasActiveTurn` confirms the
same session/turn. No new helper connection is opened.

Captures are observed from the existing `get_window_state` result; previews are
bounded independently of approval/control state. The real outbound presentation
dispatch also supplies capture and PIP lifecycle/status events. Composer
`computer-use-capture-updated` events without a native thread identity remain
Desktop-scoped status; they are not falsely attached to a viewer's selected turn.

## Why this hook design runs inside Desktop

`Iqr`, `Rqr` and their application scope are live renderer bindings, not external
RPC methods. The Computer Use socket, pending map and response closures belong
to the running main process. Loading copies of these functions elsewhere would
not give the bridge those objects; opening a helper socket would create a
different lifecycle. This patch therefore installs its observers/calls in the
processes that own that state.

That necessity belongs to **this hook design**. An official Remote receiver could
execute the same operations inside unmodified Desktop on behalf of an external
client. That is why “the handler must execute inside Desktop” does not imply
“our custom code must be patched into Desktop.”

## Default behavior, approval and evidence

The normal bridge launch and all existing backends remain available. Compatibility
mode requires the optional `--native-adapter-config` argument, a separately approved
installation and a matching live handshake. Missing/invalid optional approval
configuration leaves the stock bridge running and the compatibility flags false.
Nothing in the review publication applies the ASAR patch or restarts Desktop.

The existing fixture/build results establish the implementation's tested behavior,
not live compatibility with protected MSIX loading or official Remote. The prepared
archive was parsed/read back and the installed archive remained unchanged. Actual
patch loading, live native integration, protected-package writes and rollback are
still untested. The [installation guide](native-adapter-installation.md) specifies
the separate approval boundary, exact generated commands and original-ASAR rollback.

The source locators above refer to the hash-pinned installed package, not a public
OpenAI source distribution. Source hashes and formatting details are in the review
manifest. No full minified vendor bundle is republished.
