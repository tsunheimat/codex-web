# Installed Desktop protocol evidence

Inspected read-only: Codex Desktop app version **26.908.40834**, Windows package
**26.908.4834.0**, main executable `app/ChatGPT.exe`. No installed code was changed,
loaded into a replacement runtime, or incorporated into this repository.

## Reference licensing

Protocol references were read from Emanuele-web04/remodex, commit
`7ca6e0f000e451a66fb5837e40cdd0d654d62ce3`:

- [desktop-ipc-shared.js](https://github.com/Emanuele-web04/remodex/blob/7ca6e0f000e451a66fb5837e40cdd0d654d62ce3/phodex-bridge/src/desktop-ipc-shared.js)
- [desktop-ipc-action-follower.js](https://github.com/Emanuele-web04/remodex/blob/7ca6e0f000e451a66fb5837e40cdd0d654d62ce3/phodex-bridge/src/desktop-ipc-action-follower.js)
- [Apache-2.0 license](https://github.com/Emanuele-web04/remodex/blob/7ca6e0f000e451a66fb5837e40cdd0d654d62ce3/LICENSE)

Licensing was checked before implementation. These files are protocol references,
not vendored modules. The new client, frame decoder, state projection and routing
code are independently implemented. No installed Desktop bundle or Remodex source
file is distributed with the bridge.

## Follower bus

`resources/app.asar/.vite/build/src-CCXHtyvY.js` contains the named-pipe resolver,
method version table, IPC client/router, ownership discovery and follower handler
registration. `main-D8abTQQE.js` contains the actual conversation handlers.

- Framing: four-byte unsigned little-endian JSON byte length, then UTF-8 JSON.
  The bridge bounds local frames at 64 MiB and WSS frames at 8 MiB.
- Initialization is a `request` with `sourceClientId: initializing-client`,
  `method: initialize`, **version 0**, and `params.clientType`. The response
  supplies `result.clientId`. Unlike the Remodex map, this installed table gives
  unlisted methods version 0. The live handshake confirmed this.
- Requests carry `requestId`, `sourceClientId`, `method`, `version`, `params` and
  optionally `targetClientId`. Responses carry `resultType`, `result`/`error`,
  and `handledByClientId`. The bridge declines all ownership discovery requests
  addressed to itself.
- `thread-owner-discovery` version 1 uses `{hostId: local, conversationId}` and
  returns the owner's client ID in `handledByClientId`.
- `thread-stream-following-changed` version 1 subscribes with
  `{hostId, conversationId, following: true}`, targeted to the owner.
- `thread-stream-state-changed` version 11 carries snapshots or Immer patches with
  `baseRevision` and `revision`. Native history is normalized into islands and
  `entitiesByKey`; active turns can use `tail:*` keys, not only `turn:*` keys.
- `thread-follower-load-complete-history` version 1 calls
  `getCompleteConversationTurns` and `broadcastConversationSnapshot` in the owner.
- `thread-follower-start-turn` version 2 calls the owner's
  `startTurn(conversationId, turnStart)`; `turnStart` has `request` and `context`,
  not the raw app-server params object. The request includes `threadId` and input,
  and the bridge sets `context.inheritThreadSettings: true`.
- Steer version 1 calls the owner's `steerTurn`; interrupt version 4 passes
  `mode: user-stop` and `expectedTurnId` to `interruptConversation`.
- Approval version-1 handlers call `replyWithCommandExecutionApprovalDecision`,
  `replyWithFileChangeApprovalDecision`, and `replyWithUserInputResponse`.

The installed table is extracted as JSON data, never evaluated as code. The
bridge does not use app-server `thread/resume` to acquire ownership, broadcast
ownership, start an IPC router, or execute Remodex's runtime fallback paths.

## Native ChatGPT

The separate app-tools native pipe is created in `main-D8abTQQE.js` by `Tse` and
uses the same length framing on Windows. Its RPC schema supports `tools/list`,
`tools/call` and cancellation. Calls dispatch through `callDynamicAppTool`, the
ready renderer's `dynamicAppTools.canCallTool`/`dispatchToolCall`, and the native
Codex app tool handler registry. The bridge's private allowlist is only
`list_threads`, `read_thread`, and `send_message_to_thread` in `codex_app`.
That catalog and a native read were confirmed over the actual pipe.

Native completion is implemented in `webview/assets/app-initial-d9bed9d614d8.js`:
`startCompletionStream` → `$ur` → `Request.streamPost('/f/conversation', ...)`.
The native request layer uses `sS` and `run` → app-host `httpFetch.fetch`; completion
integrity/prepare handling and authentication stay inside Desktop. The adapter
calls `send_message_to_thread` so the existing renderer runs that path, instead
of reconstructing account requests at the gateway. Native reads retain their
`kind: chatgpt` identity, pagination metadata and native turn IDs.

The inspected text route is `eTi` → `yai` → native fallback `aJr` → `$qr`.
`aJr` loads the native conversation and rejects a chat that is already responding.
Because the app tool also handles Codex IDs, the bridge verifies the native
catalog and a fresh `read_thread` result with `thread.kind: chatgpt` before sending.

Native photo/file handling is exported by `chatgpt-file-upload-abd0e2109411.js`:
`uploadChatGptConversationFile` (`rkr`) → `createChatGptFile` (`skr`, POST `/files`)
→ `uploadChatGptFileBytes` (`ckr`/`lkr`, native HTTP byte upload)
→ `processChatGptFileUploadStream` (`fkr`, `/files/process_upload_stream`).
The inspected `send_message_to_thread` schema accepts text `prompt`, target ID,
and Codex-only model/thinking overrides; it has **no file/attachment argument**.
The follower bus has no native upload method. The remaining integration gap is
a local binding to this renderer upload operation and its attachment result,
not Windows access or a need to test native uploads again.

## Computer Use

In `main-D8abTQQE.js`, Desktop's worker dispatcher `s8e` handles
`computer-use-service-pid` via `ensureManagedComputerUseService` and
`computer-use-invalidate-service-pid`. Its existing Computer Use pipe dispatcher
`ire` accepts `request`, binds `codexTurnMetadata`, tracks the active turn by
socket, and invokes the managed helper with `createElicitation` routed through
`approvalBridge.requestApprovalForSender`. Closing that socket/session can close
the helper's active turn, so opening an independent controller is not a safe
replacement for attachment to the owner.

The renderer receives `computer-use-capture-updated` and the
`remote-hosted-pip-*` presentation events. Neither the `codex-ipc` follower
registration nor the inspected app-tools catalog exposes a subscription/binding
to the existing Computer Use owner socket, its elicitation responses, or those
capture/presentation events. That exact binding remains unimplemented; the
bridge reports `computerUse: false` and never forwards generic helper requests
or JavaScript execution to compensate.
