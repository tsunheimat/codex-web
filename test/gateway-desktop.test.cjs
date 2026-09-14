const test = require("node:test");
const assert = require("node:assert/strict");
const net = require("node:net");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { WebSocket } = require("ws");
const {
  DesktopIpc,
  FrameReader,
  encodeFrame,
} = require("../scripts/desktop/ipc.cjs");
const {
  DesktopSession,
  applyPatches,
  projectThread,
} = require("../scripts/desktop/session.cjs");
const {
  DesktopBridge,
  CommandJournal,
  gatewayUrl,
} = require("../scripts/codex_web_desktop_bridge.cjs");
const { SessionStore } = require("../src/server/gateway/store.js");
const { SessionService } = require("../src/server/gateway/service.js");
const { createGateway } = require("../src/server/gateway/http.js");
const { parseConfig } = require("../src/server/gateway/config.js");
const { desktopTlsProxy } = require("./fixtures/desktop-tls.cjs");

const {
  InstalledProtocolFixture,
  versions,
} = require("./fixtures/desktop-protocol.cjs");
async function until(predicate, timeout = 5000) {
  const end = Date.now() + timeout;
  while (!predicate()) {
    if (Date.now() > end) throw new Error("Timed out waiting for bridge state");
    await new Promise((r) => setTimeout(r, 10));
  }
}
async function setup(t, nativeTools = null) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-web-desktop-test-"));
  const endpoint =
    process.platform === "win32"
      ? "\\\\.\\pipe\\codex-web-test-" + randomUUID()
      : path.join(dir, "desktop.sock");
  const fixture = await new InstalledProtocolFixture(endpoint).listen();
  const ipc = new DesktopIpc({ endpoint, versions, timeoutMs: 1500 });
  await ipc.connect();
  const session = new DesktopSession(ipc, {
    codexHome: dir,
    uploadRoot: path.join(dir, "uploads"),
    nativeTools,
  });
  fs.writeFileSync(
    path.join(dir, "session_index.jsonl"),
    JSON.stringify({
      id: "owned-thread",
      thread_name: "Desktop conversation",
    }) + "\n",
  );
  const token = "desktop-agent-secret-with-more-than-32-characters";
  process.env.DESKTOP_TEST_TOKEN = token;
  const backend = {
    id: "windows",
    label: "Windows Desktop",
    cwd: "C:\\project",
    transport: { type: "desktop", agentTokenEnv: "DESKTOP_TEST_TOKEN" },
  };
  const store = new SessionStore(":memory:"),
    service = new SessionService(store, [backend]);
  const config = {
    host: "127.0.0.1",
    port: 8215,
    statePath: path.join(dir, "gateway.sqlite"),
    token: "viewer-token-with-more-than-32-characters",
    allowedOrigins: [],
    backends: [backend],
  };
  const app = await createGateway(config, service);
  await app.listen({ host: "127.0.0.1", port: 0 });
  const proxy = await desktopTlsProxy(app.server.address().port),
    url = gatewayUrl(proxy.url);
  const bridge = new DesktopBridge({
    session,
    info: { version: "26.908.40834", packageVersion: "26.908.4834.0" },
    url,
    tlsCa: proxy.ca,
    backendId: backend.id,
    token,
    journal: new CommandJournal(path.join(dir, "bridge.sqlite")),
    retryMs: 50,
  });
  bridge.start();
  t.after(async () => {
    await bridge.close();
    await app.close();
    await proxy.close();
    await fixture.close();
    assert.equal(path.dirname(dir), os.tmpdir());
    fs.rmSync(dir, { recursive: true, force: true });
    delete process.env.DESKTOP_TEST_TOKEN;
  });
  await until(
    () => service.connections.get(backend.id).connected && bridge.ready,
  );
  const request = (method, url, payload) =>
    app.inject({
      method,
      url,
      headers: { authorization: `Bearer ${config.token}` },
      ...(payload ? { payload } : {}),
    });
  const response = await request("POST", "/api/v1/sessions", {
    backendId: "windows",
    threadId: "owned-thread",
    clientCommandId: randomUUID(),
  });
  assert.equal(response.statusCode, 202);
  const created = response.json();
  await until(() => store.command(created.id).state === "accepted");
  return {
    fixture,
    ipc,
    session,
    store,
    service,
    bridge,
    request,
    created,
    app,
    dir,
    config,
  };
}

test("read-only Windows check rejects gateway mutations before journaling or dispatch", async (t) => {
  const { bridge, service, fixture } = await setup(t);
  bridge.readOnly = true;
  const connection = service.connections.get("windows");
  await assert.rejects(
    connection.request(
      "turn/start",
      {
        threadId: "owned-thread",
        input: [{ type: "text", text: "Must never execute" }],
      },
      "check-mutation",
    ),
    /Connection check does not execute/,
  );
  await assert.rejects(
    connection.request("attachment/upload", {
      name: "photo.png",
      data: "eA==",
    }),
    /Connection check does not execute/,
  );
  assert.equal(fixture.starts, 0);
  assert.equal(
    bridge.journal.db
      .prepare("SELECT id FROM commands WHERE id=?")
      .get("check-mutation"),
    undefined,
  );
  const result = await connection.request("thread/read", {
    threadId: "owned-thread",
  });
  assert.equal(result.thread.id, "owned-thread");
});

test("Desktop capabilities refresh after native pipe rediscovery", async (t) => {
  const { bridge, service, session } = await setup(t);
  session.nativeTools = { originThreadId: "owned-thread" };
  bridge.send({
    method: "desktop/capabilities",
    params: bridge.capabilities(),
  });
  await until(
    () => service.connections.get("windows").info.capabilities.chatgpt === true,
  );
  session.nativeTools = null;
  bridge.send({
    method: "desktop/capabilities",
    params: bridge.capabilities(),
  });
  await until(
    () =>
      service.connections.get("windows").info.capabilities.chatgpt === false,
  );
});

test("closing during Desktop rediscovery cannot reopen the local pipe", async (t) => {
  const { bridge, ipc } = await setup(t);
  let finishDiscovery;
  const discovery = new Promise((resolve) => {
    finishDiscovery = resolve;
  });
  bridge.rediscover = () => discovery;
  bridge.localReconnect = bridge.restoreDesktop();
  const closing = bridge.close();
  finishDiscovery();
  await closing;
  await until(() => ipc.clientId === null);
  assert.equal(ipc.clientId, null);
});

test("Desktop framing handles fragmented Unicode, coalesced frames, oversized and corrupt input", () => {
  const received = [],
    reader = new FrameReader((m) => received.push(m), 1024);
  const frames = Buffer.concat([
    encodeFrame({ text: "電腦🖥️" }),
    encodeFrame({ ok: true }),
  ]);
  for (const byte of frames) reader.push(Buffer.from([byte]));
  assert.deepEqual(received, [{ text: "電腦🖥️" }, { ok: true }]);
  assert.throws(
    () => new FrameReader(() => {}, 10).push(Buffer.from([255, 255, 255, 127])),
    /length/,
  );
  assert.throws(() =>
    new FrameReader(() => {}).push(Buffer.from([1, 0, 0, 0, 123])),
  );
  assert.throws(() =>
    applyPatches({}, [
      { op: "add", path: ["__proto__", "polluted"], value: true },
    ]),
  );
  assert.equal({}.polluted, undefined);
});

test("large Desktop history keeps the latest turn within the relay limit and marks truncation", () => {
  const turns = Array.from({ length: 10 }, (_, i) => ({
    turnId: `turn-${i}`,
    status: i === 9 ? "inProgress" : "completed",
    items: Array.from({ length: 50 }, (_, j) => ({
      id: `item-${j}`,
      type: "agentMessage",
      text: "x".repeat(24000),
    })),
  }));
  const projected = projectThread("owned", {
    turns,
    turnsPagination: { hasLoadedOldest: true },
  });
  assert.equal(projected.turns.at(-1).id, "turn-9");
  assert.equal(projected.turns.at(-1).status, "inProgress");
  assert.equal(projected.historyTruncated, true);
  assert.equal(projected.historyComplete, false);
  assert.ok(Buffer.byteLength(JSON.stringify(projected)) < 8 * 1024 * 1024);
});

test("gateway conversation, streamed history, image input and approvals route to the Desktop owner", async (t) => {
  const { fixture, request, store, created, service } = await setup(t);
  const summary = service.summaries()[0];
  assert.equal(summary.runtimeOwnership, "desktop");
  assert.equal(summary.capabilities.files, false);
  assert.equal(summary.capabilities.computerUse, false);
  const upload = await request("POST", "/api/v1/backends/windows/uploads", {
    sessionId: created.sessionId,
    name: "image.png",
    data: Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).toString("base64"),
  });
  assert.equal(upload.statusCode, 200);
  const body = {
    clientCommandId: randomUUID(),
    method: "turn/start",
    params: {
      input: [
        { type: "text", text: "One routed conversation" },
        { type: "localImage", path: upload.json().path },
      ],
    },
  };
  const command = (
    await request(
      "POST",
      `/api/v1/sessions/${created.sessionId}/commands`,
      body,
    )
  ).json();
  await until(() => store.command(command.id).state === "accepted");
  assert.equal(fixture.starts, 1);
  assert.equal(store.get(created.sessionId).thread.turns[0].id, "desktop-turn");
  await request("POST", `/api/v1/sessions/${created.sessionId}/commands`, body);
  assert.equal(fixture.starts, 1);
  fixture.state.requests = [
    {
      id: 42,
      method: "item/commandExecution/requestApproval",
      params: { availableDecisions: ["accept", "decline"] },
    },
  ];
  fixture.publish();
  await until(() => store.approvals(created.sessionId).length === 1);
  const approval = store.approvals(created.sessionId)[0];
  const response = await request("POST", "/api/v1/approvals/" + approval.id, {
    decision: "accept",
  });
  assert.equal(response.statusCode, 200);
  await until(() => store.approvals(created.sessionId).length === 0);
  assert.equal(
    (
      await request("POST", "/api/v1/approvals/" + approval.id, {
        decision: "decline",
      })
    ).statusCode,
    409,
  );
  assert.ok(
    fixture.calls.every(
      (m) =>
        !["thread/start", "thread/resume", "turn/start"].includes(m.method),
    ),
  );
});

test("viewer and outbound relay disconnects retain the pipe; lost mutation acknowledgements never replay", async (t) => {
  const { fixture, bridge, store, request, created, service, app, config } =
    await setup(t);
  const viewer = new WebSocket(
    `ws://127.0.0.1:${app.server.address().port}/api/v1/events`,
  );
  await new Promise((r) => viewer.once("open", r));
  viewer.send(
    JSON.stringify({ type: "authenticate", version: 1, token: config.token }),
  );
  viewer.close();
  await new Promise((r) => viewer.once("close", r));
  assert.equal(fixture.clients.size, 1);
  fixture.holdStart = true;
  const body = {
    clientCommandId: randomUUID(),
    method: "turn/start",
    params: { input: [{ type: "text", text: "Continue while disconnected" }] },
  };
  await request("POST", `/api/v1/sessions/${created.sessionId}/commands`, body);
  await until(() => !!fixture.releaseStart);
  bridge.socket.terminate();
  await until(() => store.command(body.clientCommandId).state === "unknown");
  fixture.releaseStart();
  await until(
    () => bridge.ready && service.connections.get("windows").connected,
  );
  assert.equal(fixture.clients.size, 1);
  const turn =
    fixture.state.turnHistory.history.entitiesByKey[
      "tail:0:local:desktop-turn"
    ];
  turn.status = "completed";
  turn.items.push({
    id: "reply",
    type: "agentMessage",
    text: "Desktop kept working",
  });
  fixture.publish();
  await until(() =>
    store
      .get(created.sessionId)
      .thread.turns[0].items.some((i) => i.text === "Desktop kept working"),
  );
  await request("POST", `/api/v1/sessions/${created.sessionId}/commands`, body);
  assert.equal(fixture.starts, 1);
  assert.equal(store.command(body.clientCommandId).state, "unknown");
});

test("patch gaps obtain a fresh Desktop snapshot and never repeat turn submission", async (t) => {
  const { fixture, session } = await setup(t);
  const before = fixture.calls.filter(
    (m) => m.method === "thread-stream-following-changed",
  ).length;
  for (const socket of fixture.clients)
    fixture.send(socket, {
      type: "broadcast",
      method: "thread-stream-state-changed",
      version: 11,
      sourceClientId: "desktop-owner",
      params: {
        hostId: "local",
        conversationId: "owned-thread",
        change: {
          type: "patches",
          baseRevision: 9999,
          revision: 10000,
          patches: [],
        },
      },
    });
  await until(
    () =>
      fixture.calls.filter(
        (m) => m.method === "thread-stream-following-changed",
      ).length > before,
  );
  assert.equal(session.followed.get("owned-thread").revision, fixture.revision);
  assert.equal(fixture.starts, 0);
});

test("Desktop registration requires its own credential and verified TLS, with no raw IPC or file channel", async (t) => {
  const { app, config, service, bridge, request, created } = await setup(t);
  const epoch = service.connections.get("windows").epoch;
  const unauthorized = new WebSocket(
    `ws://127.0.0.1:${app.server.address().port}/api/v1/desktop`,
  );
  await new Promise((resolve) => unauthorized.once("open", resolve));
  const closed = new Promise((resolve) => unauthorized.once("close", resolve));
  unauthorized.send(
    JSON.stringify({
      type: "desktop-authenticate",
      version: 1,
      backendId: "windows",
      token: config.token,
      desktop: { version: "26.908.40834" },
      capabilities: { codex: true },
    }),
  );
  assert.equal(await closed, 1008);
  assert.equal(service.connections.get("windows").epoch, epoch);
  const untrusted = new WebSocket(bridge.url);
  await assert.rejects(
    new Promise((resolve, reject) => {
      untrusted.once("open", resolve);
      untrusted.once("error", reject);
    }),
    /certificate|self.signed/i,
  );
  untrusted.terminate();
  await assert.rejects(
    service.connections
      .get("windows")
      .request("javascript/evaluate", { expression: "process.env" }),
    /does not expose/,
  );
  await assert.rejects(
    bridge.dispatch("ipc/request", { method: "thread/start" }),
    /Unsupported/,
  );
  const files = await request(
    "GET",
    `/api/v1/backends/windows/files?sessionId=${created.sessionId}`,
  );
  assert.equal(files.statusCode, 409);
  const tooLarge = await request("POST", "/api/v1/backends/windows/uploads", {
    sessionId: created.sessionId,
    name: "large.png",
    data: Buffer.alloc(5 * 1024 * 1024 + 3).toString("base64"),
  });
  assert.equal(tooLarge.statusCode, 400);
  assert.equal(service.connections.get("windows").connected, true);
  assert.equal(
    JSON.stringify(service.summaries()).includes("credential"),
    false,
  );
});

test("native ChatGPT keeps its own identity and uses app-tools text handlers", async (t) => {
  const calls = [],
    nativeTools = {
      originThreadId: "owned-thread",
      async call(method, args) {
        calls.push({ method, args });
        if (method === "list_threads")
          return {
            pinnedThreads: [
              { id: "owned-thread", kind: "chatgpt", title: "Native chat" },
            ],
            threads: [],
          };
        if (method === "read_thread")
          return {
            thread: {
              id: args.threadId,
              kind: "chatgpt",
              title: "Native chat",
            },
            turns: [
              {
                id: "native-turn",
                status: "completed",
                items: [
                  {
                    id: "native-item",
                    type: "agentMessage",
                    text: "Native history",
                  },
                ],
              },
            ],
          };
        if (method === "send_message_to_thread") return { ok: true };
        throw new Error("Unexpected native tool");
      },
    };
  const { request, store, fixture, created } = await setup(t, nativeTools);
  const response = await request("POST", "/api/v1/sessions", {
    backendId: "windows",
    conversationKind: "chatgpt",
    conversationId: "owned-thread",
    clientCommandId: randomUUID(),
  });
  const native = response.json();
  await until(() => store.command(native.id).state === "accepted");
  assert.notEqual(native.sessionId, created.sessionId);
  assert.equal(store.get(native.sessionId).threadId, null);
  assert.equal(
    store.get(native.sessionId).nativeConversation.turns[0].id,
    "native-turn",
  );
  const sent = (
    await request("POST", `/api/v1/sessions/${native.sessionId}/commands`, {
      clientCommandId: randomUUID(),
      method: "chatgpt/send",
      params: { prompt: "Native prompt" },
    })
  ).json();
  await until(() => store.command(sent.id).state === "accepted");
  assert.equal(
    calls.filter((c) => c.method === "send_message_to_thread").length,
    1,
  );
  assert.equal(fixture.starts, 0);
  const denied = await request("POST", "/api/v1/backends/windows/uploads", {
    sessionId: native.sessionId,
    name: "photo.png",
    data: "eA==",
  });
  assert.equal(denied.statusCode, 409);
  assert.match(denied.json().error, /uploadChatGptConversationFile/);
});

test("Desktop configuration rejects spawning and remote plaintext; journal survives a crash without replay", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "desktop-journal-test-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const base = {
    statePath: path.join(dir, "gateway.sqlite"),
    backends: [
      {
        id: "desktop",
        cwd: "C:\\project",
        transport: {
          type: "desktop",
          agentTokenEnv: "TOKEN",
          command: "codex",
        },
      },
    ],
  };
  assert.throws(() => parseConfig(base, "x".repeat(32)), /cannot launch/);
  assert.throws(() => gatewayUrl("ws://remote.example"), /wss/);
  assert.throws(() => gatewayUrl("wss://user:secret@example.com"), /wss/);
  const filename = path.join(dir, "journal.sqlite"),
    journal = new CommandJournal(filename);
  const message = {
    id: "stable-command",
    method: "desktop/turn/start",
    params: { threadId: "owned-thread" },
  };
  let calls = 0;
  assert.deepEqual(
    await journal.run(message, async () => {
      calls++;
      return { ok: true };
    }),
    { ok: true },
  );
  journal.close();
  const reopened = new CommandJournal(filename);
  assert.deepEqual(
    await reopened.run(message, () => {
      calls++;
    }),
    { ok: true },
  );
  assert.equal(calls, 1);
  reopened.db
    .prepare("UPDATE commands SET reply=NULL WHERE id=?")
    .run(message.id);
  reopened.close();
  const crashed = new CommandJournal(filename);
  await assert.rejects(
    crashed.run(message, () => {
      calls++;
    }),
    /restarted/,
  );
  assert.equal(calls, 1);
  crashed.close();
});
