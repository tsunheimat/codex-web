# Native photo and Computer Use binding

The working unmodified-Desktop bridge is the default. This optional compatibility
proposal uses a version-pinned adapter **inside the existing Desktop main process
and renderer**; it is not an unavoidable dependency.
The adapter is implemented, and the full web/gateway/bridge path is covered by
fixtures. It is **not installed or enabled in production**. Loading it requires
the separately approved ASAR change and one normal Desktop quit/restart.

Read the [route evidence and published patch review](native-adapter-review.md)
before considering approval. Limits in our two pipes do not prove that official
Remote or every other unmodified-Desktop route is unusable. Official Remote's
host-native dispatch has not been established end to end by this implementation.

## Why this exact loading change

The existing app-tools transport reaches a ready renderer through
`callDynamicAppTool` → `dynamicAppTools.dispatchToolCall` → `g0i`. Its stock handler
switch cannot invoke the photo upload or attachment-aware submission operations.
The reviewed patch adds a real `codex_web_native_v1` handler at that switch. It
receives lexical references to the existing native functions; a renderer export
or an allowlist change alone would not make this work.

The Computer Use helper's original `ire`/`ore` call sites hold the owner socket,
metadata, pending-approval map and response callback. The patch observes those
objects in place. The observer never connects to the Computer Use helper and
never creates another helper/session/runtime.

## Prepare the exact proposal

From the repository on Windows:

```powershell
npm run desktop:native:prepare
```

Preparation only reads the installed package. It checks version **26.908.40834**,
the two inspected source hashes, and the exact count of every insertion point.
It parses the patched JavaScript and verifies the generated ASAR by reading back
the changed modules. It writes these review artifacts under
`scratch/native-adapter-plan`:

- `REVIEW.md`: exact target, hashes, apply and rollback commands.
- `plan.json` / `plan.sha256`: immutable proposed edits and approval identity.
- `original.asar`: byte-for-byte rollback copy, with its SHA-256.
- `prepared.asar`: proposed package with the original unpacked-file metadata and
  unrelated payloads preserved.

After preparation, `npm run desktop:native:review` exports the portable diff,
exact edit recipe and hash manifest under `docs/reviews/`. It verifies the
prepared archives and includes only changed vendor hunks and added modules;
it does not change Desktop or export account data.

The changed installed file is `app/resources/app.asar`. Within it:

| Component                                                             | Proposed change                                                                                                                                                               |
| --------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `.vite/build/main-D8abTQQE.js`                                        | Load the adapter; bind the existing app-tools context and `Ge`; observe original helper requests/results, elicitation creation/resolution, and outbound presentation messages |
| `webview/assets/app-initial-d9bed9d614d8.js`                          | Import the adapter handler and add its explicit native dispatch case                                                                                                          |
| `.vite/build/codex-web-native/{entry,host,receipts,contract,ipc}.cjs` | New local observer, durable receipts, authenticated framing, and narrow operation handlers                                                                                    |
| `webview/assets/codex-web-native-renderer.mjs`                        | New wrapper around native upload/message functions in the existing renderer scope                                                                                             |

No preload, executable, security fuse, account store, plugin runtime, or other
installed file is patched. No debugging port or JavaScript-evaluation API is used.

## Approval, application and rollback

**Do not apply the proposal without explicit approval of the generated plan.**
Quit Desktop normally only after that approval. The installer refuses to operate
while its executable is still running. Use the exact apply command in `REVIEW.md`:

```powershell
node scripts/prepare_desktop_native_adapter.cjs --apply scratch/native-adapter-plan --approval <plan-sha256>
```

The installer verifies both current and proposed ASAR hashes, copies the reviewed
package, and creates `%APPDATA%\Codex\codex-web-native\approved.json` with a new
local observer secret. Access to that new directory is restricted to the reviewed
Windows user and SYSTEM. This secret is independent of account credentials and
the gateway agent token. The same Desktop executable is then reopened with its
existing user-data directory and normal launch settings.

Protected MSIX writes and runtime package-integrity enforcement are **untested**
until approval. A permission/hash failure stops installation. The installer does
not take ownership of WindowsApps, disable integrity checks, patch executable
fuses, or select an alternative launch/runtime path.

Rollback, after quitting Desktop normally:

```powershell
node scripts/prepare_desktop_native_adapter.cjs --rollback scratch/native-adapter-plan --approval <plan-sha256>
```

Rollback requires the expected patched hash, restores `original.asar`, verifies
its original hash, and removes only `approved.json`. Native operation receipts
remain available for reconciliation. Reopen the original Desktop executable;
the observer is gone. Do not delete the review directory until rollback is no
longer needed. If an interrupted copy requires manual restoration, copy the
verified `original.asar` to the exact `target` in `plan.json` while Desktop is quit.

## Start the existing bridge with the approved binding

After installation/restart, add one optional argument to the existing launch:

```powershell
npm run desktop:bridge -- --gateway wss://gateway.example.com --backend windows-desktop --native-adapter-config "$env:APPDATA\Codex\codex-web-native\approved.json"
```

There are no gateway registration changes. Existing gateway/agent credentials,
backend ID and native/Codex identity separation are retained. Without this
argument, both new capabilities remain false and the baseline bridge works as
before. With it, they become true only after the local adapter authenticates and
reports the exact approved plan/ASAR hashes and a ready renderer binding. Fixture
tests do not create an approval file or enable a production capability.
Missing or invalid optional approval configuration disables compatibility mode
without preventing the stock bridge from starting.

## Photo operation and lifetime

The frontend supplies a stable `uploadId` to the existing upload endpoint. The
gateway uses it as the bridge command ID. The bridge stages the file using the
existing bounded image handler and records its state/path in its local journal.
The in-process renderer calls `uploadChatGptConversationFile`, waits for native
processing, and returns the original file/library IDs plus measured dimensions.
No upload URL, auth header, cookie or account token leaves Desktop.

Submission uses `attachmentIds`, never a host path inserted into text. The native
`Iqr`/`Jqr` builder creates the `image_asset_pointer` parts and native message ID.
The Desktop-side receipt stores that prepared message before the wrapper calls
`Rqr` with the **same** `userCompletionMessages`, attachments and parent ID. A
changed parent or active conversation is rejected instead of silently branching.

The bridge persists staged/uploading/ready/unknown states and completed native
IDs. Viewer or gateway reconnects query receipts; they never restart a mutation.
If Desktop exits mid-operation, its receipt becomes unknown. A prepared message
can be reconciled by finding that exact native message ID and attachment references
in native history. An unacknowledged upload without a processed receipt remains
unknown; the code does not assume absence means it is safe to upload again.

## Computer Use operation and lifetime

Choose **Observe Computer Use** on the task/chat that owns an active native
session. Attachment succeeds only when the main-process registry finds one live
original socket and `Ge.hasActiveTurn` confirms its session/turn. The returned
owner ID is bound to the original `codexTurnMetadata`; every approval/stop operation
checks the owner and active turn again.

`requestComputerUseApproval` keeps its original ID, params, sender, and live
pending-map check. Answers call that owner's `ore.handleApprovalResponse` with
the original ID. Replies from Desktop itself are observed too. Explicit stop uses
that owner's `Ge.closeActiveTurn({sessionId, turnId})`. It does not create a helper
connection or replace the owning task's runtime.

Screenshots are observed from the original `get_window_state` result. Native
images are converted to bounded JPEG previews inside Desktop; the original helper
result is unchanged. Only one replaceable preview is retained per owner. Controls,
pending/resolved approvals and lifecycle state use separate reliable snapshots.
On backpressure a preview may be skipped; control state remains reconcilable.
Observer/viewer/gateway disconnection never calls `closeActiveTurn` or cancels an
original pending approval. Late frames from ended owners are rejected.

The adapter also observes the actual `sendInlineMessageForView` dispatch for
`computer-use-capture-updated` and the three relevant `remote-hosted-pip-*` state
events. A composer capture often has only a request/webContents identity. Such
updates retain that request ID as **Desktop-scoped capture status**, not as an
invented task/turn association. Owner screenshots always use the original helper
request's session and turn metadata.

## Verification boundaries

- **Fixtures:** gateway/WSS/native-pipe tests cover processed photo references,
  native message identity, upload/message acknowledgement loss, durable receipts,
  owner/approval identity, both reconnects, screenshots, explicit stop and disabled
  or mismatched installation proofs. The mobile browser test traverses the full
  frontend → gateway → bridge → in-process adapter fixture and closes the viewer
  during upload.
- **Static installed-package inspection:** source hashes, lexical hooks, patched
  JavaScript parsing, ASAR construction and readback are checked against the actual
  installed 26.908.40834 package. This is preparation, not execution of the patch.
- **Live new integration:** not run; the installed patch/restart is awaiting
  approval. No standalone native feature tests were repeated.
- **Linux regressions:** the full gateway suite runs on Linux without exclusions.
  Windows marks its four genuine POSIX helper/SSH/Unix-socket cases skipped with
  reasons; those exclusions are not counted as passed.

Useful commands: `npm run test:desktop`, `npm run test:renderer:browser`, and
`npm run test:gateway` on Linux. Build the frontend before the browser test. Use
`CODEX_WEB_BROWSER_EXECUTABLE` for an installed Chromium browser when necessary.

Recorded validation for this implementation: **Linux 40 passed, 0 skipped**;
**Windows 36 passed, 4 explicit POSIX skips**. Server/client type checks, production
frontend build, baseline gateway/desktop browser checks, and the new full mobile
native-path fixture passed. New live Desktop handler execution, protected-package
installation, restart and rollback remain untested and require approval.
