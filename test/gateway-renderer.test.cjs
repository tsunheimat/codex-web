const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { WebSocket } = require("ws");
const { startDesktopStack, until } = require("./fixtures/desktop-stack.cjs");

/** A minimal app-server JSON-RPC client, like the Desktop shell's transport. */
class ShellClient {
  constructor(url, token) {
    this.socket = new WebSocket(url, {
      headers: token ? { authorization: `Bearer ${token}` } : {},
    });
    this.pending = new Map();
    this.notifications = [];
    this.serverRequests = [];
    this.n = 0;
    this.socket.on("close", (code, reason) => {
      for (const resolve of this.pending.values())
        resolve({ error: { message: `socket closed ${code} ${String(reason)}` } });
      this.pending.clear();
    });
    this.socket.on("message", (raw) => {
      const m = JSON.parse(String(raw));
      if (m.method && m.id !== undefined) this.serverRequests.push(m);
      else if (m.method) this.notifications.push(m);
      else if (this.pending.has(m.id)) {
        this.pending.get(m.id)(m);
        this.pending.delete(m.id);
      }
    });
  }
  open() {
    return new Promise((resolve, reject) => {
      this.socket.once("open", resolve);
      this.socket.once("error", reject);
      this.socket.once("unexpected-response", (_r, res) =>
        reject(new Error(`upgrade rejected ${res.statusCode}`)),
      );
    });
  }
  request(method, params) {
    const id = `${method}:${++this.n}`;
    this.socket.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve) => this.pending.set(id, resolve));
  }
  respond(id, result) {
    this.socket.send(JSON.stringify({ id, result }));
  }
  close() {
    this.socket.close();
  }
}

test("renderer app-server endpoint requires the gateway token", async (t) => {
  const stack = await startDesktopStack({ shareAccountToken: false });
  t.after(() => stack.close());
  const anonymous = new ShellClient(
    `ws://127.0.0.1:${stack.port}/api/v1/backends/windows/app-server`,
  );
  await assert.rejects(anonymous.open());
  const wrongBackend = new ShellClient(
    `ws://127.0.0.1:${stack.port}/api/v1/backends/missing/app-server`,
    stack.token,
  );
  await assert.rejects(wrongBackend.open());
  // A private-account bridge withholds the Desktop token from the renderer.
  const shell = new ShellClient(
    `ws://127.0.0.1:${stack.port}/api/v1/backends/windows/app-server`,
    stack.token,
  );
  await shell.open();
  t.after(() => shell.close());
  const auth = await shell.request("getAuthStatus", { includeToken: true });
  assert.equal(auth.result.authMethod, "chatgpt");
  assert.equal(auth.result.authToken, null);
  shell.close();
});

test("original renderer shell drives a Desktop conversation through the gateway", async (t) => {
  const stack = await startDesktopStack();
  t.after(() => stack.close());
  const shell = new ShellClient(
    `ws://127.0.0.1:${stack.port}/api/v1/backends/windows/app-server`,
    stack.token,
  );
  await shell.open();
  t.after(() => shell.close());

  const init = await shell.request("initialize", {
    clientInfo: { name: "Codex Desktop", title: "Codex Desktop", version: "26.721" },
    capabilities: { experimentalApi: true },
  });
  assert.equal(init.result.platformFamily, "windows");
  assert.equal(init.result.codexHome, "C:\\project");
  shell.socket.send(JSON.stringify({ method: "initialized" }));

  // Desktop owns the account: identity and the signed-in token come from its
  // credential store, never from a gateway login flow.
  const account = await shell.request("account/read", { refreshToken: false });
  assert.deepEqual(account.result.account, {
    type: "chatgpt",
    email: "desktop@example.com",
    planType: "pro",
  });
  const auth = await shell.request("getAuthStatus", { includeToken: true });
  assert.equal(auth.result.authMethod, "chatgpt");
  assert.match(auth.result.authToken, /^eyJ/);
  const withoutToken = await shell.request("getAuthStatus", { includeToken: false });
  assert.equal(withoutToken.result.authToken, null);

  // Startup surface the renderer needs answers for.
  for (const [method, params] of [
    ["config/read", { includeLayers: false, cwd: null }],
    ["model/list", { includeHidden: true, cursor: null, limit: 100 }],
    ["experimentalFeature/list", { cursor: null, limit: 100 }],
    ["app/list", { cursor: null, limit: 1000 }],
    ["plugin/list", { marketplaceKinds: ["local"] }],
    ["mcpServerStatus/list", { cursor: null, limit: 100 }],
    ["skills/list", { forceReload: true }],
    ["remoteControl/status/read", null],
    ["collaborationMode/list", {}],
    ["permissionProfile/list", { cursor: null, limit: 100, cwd: null }],
  ]) {
    const reply = await shell.request(method, params);
    assert.equal(reply.error, undefined, `${method} must succeed`);
  }
  assert.equal(
    (await shell.request("fs/readFile", { path: "C:\\x" })).error.code,
    -32601,
  );
  const create = await shell.request("thread/start", { cwd: "C:\\project" });
  assert.match(create.error.message, /does not create conversations remotely/);

  // The shell checks project roots on the Desktop host before listing them.
  const dirStat = await shell.request("fs/getMetadata", { path: stack.dir });
  assert.equal(dirStat.result.isDirectory, true);
  assert.equal(dirStat.result.isSymlink, false);
  const missing = await shell.request("fs/getMetadata", { path: path.join(stack.dir, "nowhere") });
  assert.equal(missing.error.code, -32602);

  // Desktop's sidebar bookkeeping is exposed for the compat server overlay,
  // limited to the keys that place threads (window bounds stay private).
  const globalState = await fetch(`${stack.gatewayUrl}/api/v1/backends/windows/global-state`, {
    headers: { authorization: `Bearer ${stack.token}` },
  });
  assert.equal(globalState.status, 200);
  const { values } = await globalState.json();
  assert.deepEqual(values["local-projects"]["project-fixture"].rootPaths, ["C:\\project"]);
  assert.deepEqual(values["pinned-thread-ids"], []);
  assert.equal(values["electron-main-window-bounds"], undefined);

  const list = await shell.request("thread/list", {
    limit: 50,
    cursor: null,
    sortKey: "recency_at",
    archived: false,
    sourceKinds: [],
  });
  assert.equal(list.result.data.length, 1);
  assert.equal(list.result.data[0].id, stack.threadId);
  assert.equal(list.result.data[0].name, "Desktop conversation");
  assert.equal(list.result.data[0].cwd, "C:\\project");

  const resumed = await shell.request("thread/resume", { threadId: stack.threadId });
  assert.equal(resumed.result.thread.id, stack.threadId);
  const seed = resumed.result.thread.turns[0];
  assert.equal(seed.status, "completed");
  assert.deepEqual(
    seed.items.map((i) => i.type),
    ["userMessage", "commandExecution", "agentMessage"],
  );
  // Images in the Desktop history are kept, not dropped.
  assert.deepEqual(
    seed.items[0].content.map((c) => c.type),
    ["text", "localImage"],
  );
  assert.equal(seed.items[0].content[1].path, stack.imagePath);
  assert.equal(seed.items[1].command, "dir C:\\project");
  assert.equal(seed.items[1].exitCode, 0);

  // The image is readable through the gateway only because Desktop shows it.
  const image = await fetch(
    `${stack.gatewayUrl}/api/v1/backends/windows/files/image?path=${encodeURIComponent(stack.imagePath)}`,
    { headers: { authorization: `Bearer ${stack.token}` } },
  );
  assert.equal(image.status, 200);
  assert.equal(image.headers.get("content-type"), "image/png");
  const forbidden = await fetch(
    `${stack.gatewayUrl}/api/v1/backends/windows/files/image?path=${encodeURIComponent(stack.dir + "/auth.json")}`,
    { headers: { authorization: `Bearer ${stack.token}` } },
  );
  assert.equal(forbidden.status, 409);

  // Upload by thread id, then send a turn that references the staged image.
  const upload = await fetch(`${stack.gatewayUrl}/api/v1/backends/windows/uploads`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${stack.token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      name: "shot.png",
      data: Buffer.from("png-bytes").toString("base64"),
      threadId: stack.threadId,
    }),
  });
  assert.equal(upload.status, 200);
  const staged = await upload.json();
  const started = await shell.request("turn/start", {
    threadId: stack.threadId,
    input: [
      { type: "text", text: "Ping from the renderer", text_elements: [] },
      { type: "localImage", path: staged.path },
    ],
    cwd: "C:\\project",
    approvalPolicy: "on-request",
  });
  assert.equal(started.error, undefined, JSON.stringify(started));
  assert.equal(started.result.turn.status, "inProgress");
  assert.equal(stack.fixture.starts, 1);
  const submitted = stack.fixture.calls.find(
    (c) => c.method === "thread-follower-start-turn",
  );
  assert.equal(submitted.params.turnStart.request.input[1].path, staged.path);

  await until(
    () => shell.notifications.some((n) => n.method === "turn/completed"),
    10000,
  );
  const methods = shell.notifications.map((n) => n.method);
  assert.ok(methods.includes("turn/started"));
  assert.ok(methods.includes("item/started"));
  assert.ok(methods.includes("item/agentMessage/delta"));
  const completed = shell.notifications.find((n) => n.method === "turn/completed");
  assert.equal(completed.params.threadId, stack.threadId);
  const finalAgent = shell.notifications
    .filter((n) => n.method === "item/completed")
    .map((n) => n.params.item)
    .find((i) => i.type === "agentMessage");
  assert.equal(finalAgent.text, "Desktop echo: Ping from the renderer");
  const status = shell.notifications.filter((n) => n.method === "thread/status/changed");
  assert.deepEqual(
    status.map((n) => n.params.status.type),
    ["active", "idle"],
  );
  // Ownership of the mutation stays in the gateway journal.
  const commands = stack.store.commands(stack.store.findThread("windows", stack.threadId).id);
  assert.ok(commands.some((c) => c.method === "turn/start" && c.state === "accepted"));

  // Approvals arrive as app-server server requests and answers reach Desktop.
  stack.fixture.requestApproval({
    id: 42,
    method: "item/commandExecution/requestApproval",
    params: {
      turnId: "desktop-turn",
      itemId: "cmd-1",
      command: "rm -rf build",
      cwd: "C:\\project",
      availableDecisions: ["accept", "decline"],
    },
  });
  await until(() => shell.serverRequests.length === 1, 10000);
  const approval = shell.serverRequests[0];
  assert.equal(approval.method, "item/commandExecution/requestApproval");
  assert.equal(approval.params.threadId, stack.threadId);
  shell.respond(approval.id, { decision: "accept" });
  await until(() => stack.fixture.decision === "accept", 10000);

  // A second renderer reply for the same approval is ignored, not replayed.
  shell.respond(approval.id, { decision: "decline" });
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(stack.fixture.decision, "accept");
  shell.close();
});

test("renderer interrupt and steer map to Desktop follower requests", async (t) => {
  const stack = await startDesktopStack({ autoReply: false });
  t.after(() => stack.close());
  const shell = new ShellClient(
    `ws://127.0.0.1:${stack.port}/api/v1/backends/windows/app-server`,
    stack.token,
  );
  await shell.open();
  t.after(() => shell.close());
  await shell.request("initialize", { clientInfo: { name: "x", title: "x", version: "1" } });
  await shell.request("thread/resume", { threadId: stack.threadId });
  const started = await shell.request("turn/start", {
    threadId: stack.threadId,
    input: [{ type: "text", text: "Work" }],
  });
  assert.equal(started.result.turn.id, "desktop-turn");
  const steered = await shell.request("turn/steer", {
    threadId: stack.threadId,
    input: [{ type: "text", text: "Also this" }],
    expectedTurnId: "desktop-turn",
  });
  assert.equal(steered.error, undefined, JSON.stringify(steered));
  assert.equal(stack.fixture.steers, 1);
  const interrupted = await shell.request("turn/interrupt", {
    threadId: stack.threadId,
    turnId: "desktop-turn",
  });
  assert.equal(interrupted.error, undefined, JSON.stringify(interrupted));
  assert.equal(stack.fixture.interrupts, 1);
  await until(
    () => shell.notifications.some((n) => n.method === "turn/completed"),
    10000,
  );
  shell.close();
});
