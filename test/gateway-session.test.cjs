const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { SessionStore } = require("../src/server/gateway/store.js");
const { SessionService } = require("../src/server/gateway/service.js");
const { AppServerConnection } = require("../src/server/gateway/connection.js");
const { MockRuntime, waitFor } = require("./fixtures/gateway-runtime.cjs");

async function setup(t, filename = ":memory:") {
  const runtime = await new MockRuntime().listen();
  const backends = [
    {
      id: "desktop",
      label: "My desktop",
      cwd: "/remote/project",
      transport: { type: "websocket", url: runtime.url },
    },
  ];
  const store = new SessionStore(filename, 5);
  const service = new SessionService(
    store,
    backends,
    (b) => new AppServerConnection(b, 300),
  );
  t.after(async () => {
    await service.close();
    await runtime.close();
  });
  const created = service.create({
    clientCommandId: randomUUID(),
    backendId: "desktop",
  });
  await waitFor(() => store.command(created.id).state === "accepted");
  return {
    runtime,
    store,
    service,
    created,
    session: store.get(created.sessionId),
    backends,
  };
}
function input() {
  return {
    clientCommandId: randomUUID(),
    method: "turn/start",
    params: { input: [{ type: "text", text: "Work while I am away" }] },
  };
}

test("runtime continues without viewers and snapshot catches up beyond journal retention", async (t) => {
  const { runtime, store, service, session } = await setup(t);
  const command = service.submit(session.id, input());
  await waitFor(() => store.command(command.id).state === "accepted");
  for (let i = 0; i < 12; i++)
    runtime.notify("item/agentMessage/delta", {
      threadId: session.threadId,
      turnId: "turn-1",
      itemId: "stream",
      delta: "x",
    });
  await waitFor(() => store.get(session.id).seq > 12);
  runtime.finish(session.threadId);
  await waitFor(() => store.get(session.id).status === "completed");
  const state = store.sync(session.id, 0);
  assert.equal(state.reset, true);
  assert.equal(state.lastSeq, state.snapshot.seq);
  assert.match(
    JSON.stringify(state.snapshot.thread),
    /Finished on the execution host/,
  );
  assert.equal(runtime.starts, 1);
});

test("same persistent command ID executes once and rejects changed content", async (t) => {
  const { runtime, store, service, session } = await setup(t);
  const body = input();
  const first = service.submit(session.id, body);
  assert.equal(service.submit(session.id, body).id, first.id);
  assert.throws(
    () =>
      service.submit(session.id, {
        ...body,
        params: { input: [{ type: "text", text: "Different task" }] },
      }),
    /different input/,
  );
  await waitFor(() => store.command(first.id).state === "accepted");
  assert.equal(service.submit(session.id, body).state, "accepted");
  assert.equal(runtime.starts, 1);
});

test("acknowledgement loss records unknown and never resubmits turn/start", async (t) => {
  const { runtime, store, service, session } = await setup(t);
  runtime.dropStartReply = true;
  const body = input();
  const command = service.submit(session.id, body);
  await waitFor(() => store.command(command.id).state === "unknown");
  assert.equal(service.submit(session.id, body).state, "unknown");
  await service.reconcile(session.id);
  assert.equal(runtime.starts, 1);
  assert.equal(store.get(session.id).thread.turns.length, 1);
});

test("approval has one winner, survives absent viewers, and stale epochs are rejected", async (t) => {
  const { runtime, store, service, session } = await setup(t);
  const command = service.submit(session.id, input());
  await waitFor(() => store.command(command.id).state === "accepted");
  runtime.approval(session.threadId);
  await waitFor(() => store.approvals(session.id).length === 1);
  const approval = store.approvals(session.id)[0];
  service.answer(approval.id, { decision: "accept" });
  assert.throws(
    () => service.answer(approval.id, { decision: "decline" }),
    /no longer pending/,
  );
  await waitFor(() => store.approvals(session.id).length === 0);
  assert.equal(runtime.responses.length, 1);
  runtime.approval(session.threadId, 8);
  await waitFor(() => store.approvals(session.id).length === 1);
  const stale = store.approvals(session.id)[0];
  service.connections.get("desktop").close();
  assert.throws(
    () => service.answer(stale.id, { decision: "accept" }),
    /no longer pending/,
  );
  assert.equal(store.approval(stale.id).state, "stale");
});

test("a gateway restart reconciles an externally owned runtime without starting work", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gateway-restart-"));
  const filename = path.join(dir, "state.sqlite");
  const runtime = await new MockRuntime().listen();
  const backends = [
    {
      id: "desktop",
      label: "Desktop",
      cwd: "/remote/project",
      transport: { type: "websocket", url: runtime.url },
    },
  ];
  let service = new SessionService(new SessionStore(filename), backends);
  t.after(async () => {
    await service.close();
    await runtime.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const created = service.create({
    clientCommandId: randomUUID(),
    backendId: "desktop",
  });
  await waitFor(() => service.store.command(created.id).state === "accepted");
  const body = input();
  const command = service.submit(created.sessionId, body);
  await waitFor(() => service.store.command(command.id).state === "accepted");
  const session = service.store.get(created.sessionId);
  await service.close();
  runtime.finish(session.threadId);
  service = new SessionService(new SessionStore(filename), backends);
  service.start();
  await waitFor(() => service.store.get(session.id).status === "completed");
  assert.equal(service.submit(session.id, body).state, "accepted");
  assert.equal(runtime.starts, 1);
});

test("identical upstream thread IDs remain isolated across backends", async (t) => {
  const runtimeA = await new MockRuntime().listen();
  const runtimeB = await new MockRuntime().listen();
  const backends = [runtimeA, runtimeB].map((r, i) => ({
    id: `host${i}`,
    label: `Host ${i}`,
    cwd: `/host${i}`,
    transport: { type: "websocket", url: r.url },
  }));
  const service = new SessionService(new SessionStore(":memory:"), backends);
  t.after(async () => {
    await service.close();
    await runtimeA.close();
    await runtimeB.close();
  });
  const a = service.create({
    backendId: "host0",
    clientCommandId: randomUUID(),
  });
  const b = service.create({
    backendId: "host1",
    clientCommandId: randomUUID(),
  });
  await waitFor(() =>
    [a, b].every((c) => service.store.command(c.id).state === "accepted"),
  );
  const task = service.submit(b.sessionId, input());
  await waitFor(() => service.store.command(task.id).state === "accepted");
  runtimeB.finish("thread-1");
  await waitFor(() => service.store.get(b.sessionId).status === "completed");
  assert.equal(service.store.get(a.sessionId).status, "ready");
  assert.equal(runtimeA.starts, 0);
});

test("startup marks ambiguous dispatch stale instead of replaying it", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gateway-store-"));
  const filename = path.join(dir, "state.sqlite");
  let store = new SessionStore(filename);
  store.putCommand({
    id: "lost-command",
    sessionId: "session",
    method: "turn/start",
    fingerprint: "test",
    state: "dispatching",
  });
  store.close();
  store = new SessionStore(filename);
  assert.equal(store.command("lost-command").state, "unknown");
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("imported sessions retain the thread workspace for host operations", async (t) => {
  const runtime = await new MockRuntime().listen();
  const backend = {
    id: "desktop",
    label: "Desktop",
    cwd: "/configured/default",
    transport: { type: "websocket", url: runtime.url },
  };
  runtime.threads.set("thread-existing", {
    id: "thread-existing",
    cwd: "/selected/project",
    turns: [],
    preview: "Imported project",
  });
  const service = new SessionService(
    new SessionStore(":memory:"),
    [backend],
    (b) => new AppServerConnection(b, 300),
  );
  t.after(async () => {
    await service.close();
    await runtime.close();
  });
  const command = service.create({
    backendId: "desktop",
    threadId: "thread-existing",
    clientCommandId: randomUUID(),
  });
  await waitFor(() => service.store.command(command.id).state === "accepted");
  const session = service.store.get(command.sessionId);
  assert.equal(session.cwd, "/selected/project");
  assert.equal(service.backendForSession(session.id).cwd, "/selected/project");
});
