const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { EventEmitter } = require("node:events");
const { randomUUID } = require("node:crypto");
const { WebSocket } = require("ws");
const { nativeAdapterFixture, PNG } = require("./fixtures/native-adapter.cjs");
const { desktopTlsProxy } = require("./fixtures/desktop-tls.cjs");
const {
  NativeAdapterClient,
  loadApprovedNativeConfig,
} = require("../scripts/desktop/native-client.cjs");
const {
  NativeIntegration,
} = require("../scripts/desktop/native-integration.cjs");
const { NativeReceipts } = require("../scripts/desktop/native/receipts.cjs");
const { NativeHost } = require("../scripts/desktop/native/host.cjs");
const { DesktopSession } = require("../scripts/desktop/session.cjs");
const {
  DesktopBridge,
  CommandJournal,
  gatewayUrl,
} = require("../scripts/codex_web_desktop_bridge.cjs");
const { SessionStore } = require("../src/server/gateway/store.js");
const { SessionService } = require("../src/server/gateway/service.js");
const { createGateway } = require("../src/server/gateway/http.js");
async function until(predicate, ms = 8000) {
  const end = Date.now() + ms;
  while (!predicate()) {
    if (Date.now() > end) throw new Error("Native fixture timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
}
async function setup(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-native-test-")),
    native = await nativeAdapterFixture(root);
  const ipc = new EventEmitter();
  ipc.clientId = "existing-desktop";
  ipc.connect = async () => {};
  ipc.close = () => {};
  const nativeTools = {
    originThreadId: "existing-context",
    async call(tool) {
      if (tool === "list_threads")
        return {
          threads: [
            { id: "native-chat", kind: "chatgpt", title: "Native chat" },
          ],
        };
      if (tool === "read_thread")
        return {
          thread: {
            id: "native-chat",
            kind: "chatgpt",
            title: "Native chat",
            status: { type: "idle" },
          },
          turns: [],
        };
      throw new Error("Image submission must not use send_message_to_thread");
    },
  };
  const session = new DesktopSession(ipc, {
    codexHome: root,
    uploadRoot: path.join(root, "staged"),
    nativeTools,
  });
  const journal = new CommandJournal(path.join(root, "bridge.sqlite"));
  const client = new NativeAdapterClient(native.config, "existing-context", {
    timeoutMs: 3000,
    retryMs: 30,
  });
  const integration = new NativeIntegration({ client, session, journal });
  const backend = {
    id: "windows",
    label: "Desktop",
    cwd: "C:\\project",
    transport: { type: "desktop", agentTokenEnv: "NATIVE_TEST_TOKEN" },
  };
  process.env.NATIVE_TEST_TOKEN = randomUUID() + randomUUID();
  const store = new SessionStore(path.join(root, "gateway.sqlite")),
    service = new SessionService(store, [backend]);
  const config = {
    host: "127.0.0.1",
    port: 8215,
    statePath: path.join(root, "gateway.sqlite"),
    token: randomUUID(),
    backends: [backend],
    allowedOrigins: [],
  };
  const app = await createGateway(config, service);
  await app.listen({ host: "127.0.0.1", port: 0 });
  const proxy = await desktopTlsProxy(app.server.address().port);
  const bridge = new DesktopBridge({
    session,
    journal,
    nativeIntegration: integration,
    info: { version: "26.908.40834" },
    backendId: "windows",
    token: process.env.NATIVE_TEST_TOKEN,
    url: gatewayUrl(proxy.url),
    tlsCa: proxy.ca,
    retryMs: 30,
  });
  const request = (method, url, payload) =>
    app.inject({
      method,
      url,
      headers: { authorization: "Bearer " + config.token },
      ...(payload ? { payload } : {}),
    });
  t.after(async () => {
    native.releaseUpload?.();
    native.releaseSubmit?.();
    await bridge.close();
    await app.close();
    await proxy.close();
    await native.close();
    assert.equal(path.dirname(root), os.tmpdir());
    fs.rmSync(root, { recursive: true, force: true });
    delete process.env.NATIVE_TEST_TOKEN;
  });
  bridge.start();
  await until(
    () =>
      bridge.ready &&
      service.summaries()[0].capabilities.chatgptAttachments === true,
  );
  const created = (
    await request("POST", "/api/v1/sessions", {
      clientCommandId: randomUUID(),
      backendId: "windows",
      conversationKind: "chatgpt",
      conversationId: "native-chat",
    })
  ).json();
  await until(() => store.command(created.id)?.state === "accepted");
  const upload = (uploadId = randomUUID()) =>
    request("POST", "/api/v1/backends/windows/uploads", {
      sessionId: created.sessionId,
      uploadId,
      name: "photo.png",
      data: PNG,
    });
  return {
    root,
    native,
    client,
    integration,
    journal,
    bridge,
    service,
    store,
    created,
    upload,
    request,
    app,
    config,
  };
}
test("native photo goes from gateway staging through processed native references into the submitted message", async (t) => {
  const f = await setup(t),
    uploadId = randomUUID();
  const first = await f.upload(uploadId);
  assert.equal(first.statusCode, 200);
  const photo = first.json();
  assert.equal(photo.nativeAttachmentId, "file_native_1");
  assert.equal(photo.attachment.width, 1);
  assert.deepEqual(f.native.uploadFiles[0], Buffer.from(PNG, "base64"));
  const repeated = await f.upload(uploadId);
  assert.equal(repeated.json().nativeAttachmentId, photo.nativeAttachmentId);
  assert.equal(f.native.uploads, 1);
  const commandId = randomUUID();
  const body = {
    clientCommandId: commandId,
    method: "chatgpt/send",
    params: {
      prompt: "Describe this photo",
      attachmentIds: [photo.nativeAttachmentId],
    },
  };
  await f.request(
    "POST",
    `/api/v1/sessions/${f.created.sessionId}/commands`,
    body,
  );
  await until(() => f.store.command(commandId)?.state === "accepted");
  const submitted = f.native.submissions[0];
  assert.equal(
    submitted.prepared.bundle.message.content.parts[0].asset_pointer,
    "sediment://file_native_1",
  );
  assert.equal(
    submitted.prepared.bundle.message.metadata.attachments[0].id,
    photo.nativeAttachmentId,
  );
  assert.equal(
    f.store.command(commandId).result.messageId,
    submitted.prepared.bundle.message.id,
  );
  await f.request(
    "POST",
    `/api/v1/sessions/${f.created.sessionId}/commands`,
    body,
  );
  assert.equal(f.native.submissions.length, 1);
  assert.deepEqual(
    f.native.rendererCalls.filter((x) => x.startsWith("message/")),
    ["message/prepare", "message/submit"],
  );
});
test("lost native upload acknowledgement reconciles its processed result without reupload", async (t) => {
  const f = await setup(t);
  f.native.holdUpload = true;
  const id = randomUUID();
  const response = f.upload(id);
  await until(() => !!f.native.releaseUpload);
  f.client.socket.destroy();
  await until(() => !f.client.verified);
  f.native.releaseUpload();
  await response;
  await until(() => f.client.verified);
  await f.integration.recover();
  await until(
    () => f.integration.publicUploads("native-chat")[0]?.state === "ready",
  );
  const retried = await f.upload(id);
  assert.equal(retried.statusCode, 200);
  assert.equal(f.native.uploads, 1);
  assert.equal(f.native.helperCloses, 0);
});
test("lost gateway message acknowledgement reconciles the original native message ID without another submission", async (t) => {
  const f = await setup(t),
    photo = (await f.upload()).json();
  f.native.holdSubmit = true;
  const id = randomUUID(),
    body = {
      clientCommandId: id,
      method: "chatgpt/send",
      params: {
        prompt: "One image message",
        attachmentIds: [photo.nativeAttachmentId],
      },
    };
  await f.request(
    "POST",
    `/api/v1/sessions/${f.created.sessionId}/commands`,
    body,
  );
  await until(() => !!f.native.releaseSubmit);
  f.bridge.socket.terminate();
  await until(() => f.store.command(id)?.state === "unknown");
  f.native.releaseSubmit();
  await until(() => f.bridge.ready);
  await f.service.reconcile(f.created.sessionId);
  assert.equal(f.store.command(id).state, "accepted");
  assert.equal(f.native.submissions.length, 1);
  await f.request(
    "POST",
    `/api/v1/sessions/${f.created.sessionId}/commands`,
    body,
  );
  assert.equal(f.native.submissions.length, 1);
});
test("Computer Use observer survives both links and viewers; approvals retain original identity and stop is idempotent", async (t) => {
  const f = await setup(t);
  const attached = await f.request(
    "POST",
    `/api/v1/sessions/${f.created.sessionId}/computer-use/attach`,
    {},
  );
  assert.equal(attached.statusCode, 200);
  await until(() => f.store.get(f.created.sessionId).computerUse?.ownerId);
  f.native.host.observePresentation(
    { id: 3 },
    {
      type: "computer-use-capture-updated",
      requestId: "original-capture-request",
      update: { type: "completed" },
    },
  );
  await until(
    () =>
      f.service.captureStatuses.get("windows")?.requestId ===
      "original-capture-request",
  );
  assert.equal(f.service.captureStatuses.get("windows").scope, "desktop");
  f.native.host.observePresentation(
    { id: 3 },
    {
      type: "remote-hosted-pip-task-state-changed",
      state: { threadID: "native-chat", status: "working" },
    },
  );
  await until(
    () =>
      f.store.get(f.created.sessionId).computerUse?.presentations?.[
        "remote-hosted-pip-task-state-changed"
      ]?.state?.status === "working",
  );
  const promise = f.native.offerApproval({
    message: "Allow the existing owner to use this app?",
    meta: {
      method: "get_window_state",
      params: { window: { app: "fixture-app", id: 3 } },
    },
  });
  await until(() => f.store.approvals(f.created.sessionId).length === 1);
  const originalId = f.native.originalApprovals[0].id;
  for (let n = 0; n < 50; n++) f.native.capture();
  f.native.host.capture(
    f.native.owner,
    "data:image/png;base64," + "A".repeat(2 * 1024 * 1024),
    {},
  );
  await until(() => f.integration.captures.size === 1);
  assert.equal(f.integration.captures.size, 1);
  assert.equal(f.native.pending.has(originalId), true);
  const viewer = new WebSocket(
    `ws://127.0.0.1:${f.app.server.address().port}/api/v1/events`,
  );
  await new Promise((r) => viewer.once("open", r));
  viewer.send(
    JSON.stringify({ type: "authenticate", version: 1, token: f.config.token }),
  );
  viewer.close();
  const previousEpoch = f.service.connections.get("windows").epoch,
    previousNativeSocket = f.client.socket;
  f.bridge.socket.terminate();
  f.client.socket.destroy();
  await until(
    () =>
      f.bridge.ready &&
      f.client.verified &&
      f.client.socket !== previousNativeSocket &&
      f.service.connections.get("windows").epoch !== previousEpoch,
  );
  await until(() => f.store.approvals(f.created.sessionId).length === 1);
  const approval = f.store.approvals(f.created.sessionId)[0];
  assert.equal(approval.requestId, originalId);
  assert.deepEqual(approval.params.codexTurnMetadata, f.native.metadata);
  assert.equal(f.native.helperCloses, 0);
  assert.equal(f.native.helper.destroyed, false);
  const answer = await f.request("POST", `/api/v1/approvals/${approval.id}`, {
    decision: "accept",
  });
  assert.equal(
    answer.statusCode,
    200,
    JSON.stringify(
      [...f.native.host.receipts.records.values()].map((r) => ({
        method: r.method,
        error: r.error,
      })),
    ),
  );
  assert.deepEqual(await promise, { action: "accept" });
  assert.equal(f.native.nativeResponses[0].id, originalId);
  assert.equal(f.native.nativeResponses.length, 1);
  const state = f.store.get(f.created.sessionId).computerUse,
    stopId = randomUUID(),
    stop = {
      ownerId: state.ownerId,
      turnId: state.turnId,
      clientCommandId: stopId,
    };
  await f.request(
    "POST",
    `/api/v1/sessions/${f.created.sessionId}/computer-use/stop`,
    stop,
  );
  await until(() => f.store.command(stopId)?.state === "accepted");
  await f.request(
    "POST",
    `/api/v1/sessions/${f.created.sessionId}/computer-use/stop`,
    stop,
  );
  assert.equal(f.native.helperCloses, 1);
  f.client.emit("native/cu/capture", {
    ...state,
    dataUrl: "data:image/png;base64," + PNG,
  });
  assert.equal(f.integration.captures.size, 0);
});
test("native receipts survive a Desktop restart and reconcile a prepared message by identity", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "native-receipt-test-"));
  t.after(() => {
    assert.equal(path.dirname(root), os.tmpdir());
    fs.rmSync(root, { recursive: true, force: true });
  });
  const store = new NativeReceipts(root);
  store.put({
    id: "original-command",
    state: "dispatching",
    method: "native/message/send",
    fingerprint: "same",
    conversationId: "native-chat",
    attachmentIds: ["file_original"],
    messageId: "native-message-original",
  });
  const restarted = new NativeReceipts(root);
  assert.equal(restarted.get("original-command").state, "unknown");
  assert.equal(
    restarted.get("original-command").messageId,
    "native-message-original",
  );
  const operations = [],
    host = new NativeHost({
      receipts: restarted,
      renderer: async (request) => {
        operations.push(request);
        return { found: request.messageId === "native-message-original" };
      },
    });
  const result = await host.operation("original-command");
  assert.equal(result.state, "complete");
  assert.equal(result.result.reconciled, true);
  assert.deepEqual(
    operations.map((r) => r.op),
    ["message/find"],
  );
});
test("unapproved or mismatched adapter cannot enable production capabilities", async (t) => {
  const f = await setup(t);
  f.client.close();
  await until(() => !f.client.verified);
  assert.equal(f.integration.capabilities().computerUse, false);
  f.native.wrongHash = true;
  const mismatch = new NativeAdapterClient(
    f.native.config,
    "existing-context",
    { retryMs: 10000 },
  );
  await assert.rejects(mismatch.connect(), /approved installation/);
  mismatch.close();
  assert.equal(mismatch.verified, false);
  const filename = path.join(f.root, "not-approved.json");
  fs.writeFileSync(
    filename,
    JSON.stringify({ ...f.native.config, enabled: false }),
  );
  assert.throws(() => loadApprovedNativeConfig(filename), /approved/);
});

test("missing or invalid optional compatibility approval leaves the stock bridge independent", (t) => {
  const {
    optionalNativeIntegration,
  } = require("../scripts/codex_web_desktop_bridge.cjs");
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "optional-native-"));
  t.after(() => {
    assert.equal(path.dirname(directory), os.tmpdir());
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const diagnostics = [],
    session = { connected: true },
    journal = {};
  assert.equal(
    optionalNativeIntegration({
      session,
      journal,
      diagnose: (m) => diagnostics.push(m),
    }),
    null,
  );
  assert.equal(diagnostics.length, 0);
  const filename = path.join(directory, "approved.json");
  assert.equal(
    optionalNativeIntegration({
      filename,
      session,
      journal,
      diagnose: (m) => diagnostics.push(m),
    }),
    null,
  );
  fs.writeFileSync(filename, '{"token":"do-not-log-this-secret", broken');
  assert.equal(
    optionalNativeIntegration({
      filename,
      session,
      journal,
      diagnose: (m) => diagnostics.push(m),
    }),
    null,
  );
  assert.equal(session.connected, true);
  assert.equal(
    diagnostics.some((m) => m.includes("do-not-log-this-secret")),
    false,
  );
});
