const assert = require("node:assert/strict");
const test = require("node:test");
const {
  parseRendererBridgeReady,
  RendererRecoveryCoordinator,
} = require("../src/server/renderer-recovery.js");

function turnNotification(method, threadId, turnId) {
  return {
    type: "ipc-main-event",
    channel: "codex_desktop:message-for-view",
    args: [
      {
        type: "mcp-notification",
        method,
        params: { threadId, turn: { id: turnId } },
      },
    ],
  };
}

function createCoordinator(events = []) {
  return new RendererRecoveryCoordinator({
    broadcast: (message) => events.push({ type: "broadcast", message }),
    recover: (connectionId) => events.push({ type: "recover", connectionId }),
    readThread: async () =>
      new Set(["turn-a", "turn-b", "turn-early", "turn-late"]),
  });
}

async function settlePromises() {
  for (let index = 0; index < 6; index += 1) {
    await Promise.resolve();
  }
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

class FakeTimers {
  nextId = 1;
  now = 0;
  timers = new Map();

  setTimeout = (callback, delay) => {
    const id = this.nextId++;
    this.timers.set(id, { at: this.now + delay, callback });
    return id;
  };

  clearTimeout = (id) => {
    this.timers.delete(id);
  };

  advance(milliseconds) {
    const target = this.now + milliseconds;
    while (true) {
      const next = [...this.timers]
        .filter(([, timer]) => timer.at <= target)
        .sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
      if (!next) {
        break;
      }
      this.timers.delete(next[0]);
      this.now = next[1].at;
      next[1].callback();
    }
    this.now = target;
  }
}

function recoveries(events) {
  return events
    .filter((event) => event.type === "recover")
    .map((event) => event.connectionId);
}

test("validates renderer-ready current thread identity", () => {
  assert.deepEqual(
    parseRendererBridgeReady({
      type: "renderer-bridge-ready",
      currentThreadId: "019bf2f0-13ac-7e20-a343-506181c4a272",
    }),
    {
      type: "renderer-bridge-ready",
      currentThreadId: "019bf2f0-13ac-7e20-a343-506181c4a272",
      recoveryReason: null,
    },
  );
  assert.deepEqual(
    parseRendererBridgeReady({
      type: "renderer-bridge-ready",
      currentThreadId: null,
    }),
    {
      type: "renderer-bridge-ready",
      currentThreadId: null,
      recoveryReason: null,
    },
  );
  for (const currentThreadId of [
    undefined,
    "",
    "thread/other",
    "x".repeat(129),
  ]) {
    assert.equal(
      parseRendererBridgeReady({
        type: "renderer-bridge-ready",
        currentThreadId,
      }),
      null,
    );
  }
  assert.deepEqual(
    parseRendererBridgeReady({
      type: "renderer-bridge-ready",
      currentThreadId: "thread-a",
      recoveryReason: "backend-restarted",
    }),
    {
      type: "renderer-bridge-ready",
      currentThreadId: "thread-a",
      recoveryReason: "backend-restarted",
    },
  );
  for (const recoveryReason of ["backend restarted", "restart", 1, {}]) {
    assert.equal(
      parseRendererBridgeReady({
        type: "renderer-bridge-ready",
        currentThreadId: "thread-a",
        recoveryReason,
      }),
      null,
    );
  }
});

test("ordinary first readiness stays distinct while first restart readiness hydrates", () => {
  const ordinaryEvents = [];
  const ordinary = createCoordinator(ordinaryEvents);
  ordinary.acceptRendererReady("ordinary", "thread-a");
  assert.deepEqual(recoveries(ordinaryEvents), []);

  const restartEvents = [];
  const restart = createCoordinator(restartEvents);
  restart.acceptRendererReady(
    "replacement-first",
    "thread-a",
    "backend-restarted",
  );
  restart.acceptRendererReady(
    "replacement-first",
    "thread-a",
    "backend-restarted",
  );
  assert.deepEqual(recoveries(restartEvents), ["replacement-first"]);
});

test("recovery waits only for the ready renderer's current thread", () => {
  const events = [];
  const coordinator = createCoordinator(events);
  coordinator.acceptRendererReady("original", null);
  coordinator.broadcastRuntimeMessage(
    turnNotification("turn/started", "thread-a", "turn-a"),
  );
  coordinator.broadcastRuntimeMessage(
    turnNotification("turn/started", "thread-b", "turn-b"),
  );

  coordinator.acceptRendererReady("page-a", "thread-a");
  coordinator.acceptRendererReady("page-b", "thread-b");
  coordinator.acceptRendererReady("home", null);
  assert.deepEqual(recoveries(events), ["home"]);

  coordinator.broadcastRuntimeMessage(
    turnNotification("turn/completed", "thread-b", "turn-b"),
  );
  assert.deepEqual(recoveries(events), ["home", "page-b"]);

  coordinator.broadcastRuntimeMessage(
    turnNotification("turn/completed", "thread-a", "turn-a"),
  );
  assert.deepEqual(recoveries(events), ["home", "page-b", "page-a"]);
});

test("late same-thread starts join an existing recovery wait", () => {
  const events = [];
  const coordinator = createCoordinator(events);
  coordinator.acceptRendererReady("original", null);
  coordinator.broadcastRuntimeMessage(
    turnNotification("turn/started", "thread-a", "turn-early"),
  );
  coordinator.acceptRendererReady("waiting", "thread-a");

  coordinator.broadcastRuntimeMessage(
    turnNotification("turn/started", "thread-a", "turn-late"),
  );
  coordinator.broadcastRuntimeMessage(
    turnNotification("turn/started", "thread-b", "turn-unrelated"),
  );
  coordinator.broadcastRuntimeMessage(
    turnNotification("turn/completed", "thread-a", "turn-early"),
  );
  assert.deepEqual(recoveries(events), []);

  coordinator.broadcastRuntimeMessage(
    turnNotification("turn/completed", "thread-b", "turn-unrelated"),
  );
  assert.deepEqual(recoveries(events), []);

  coordinator.broadcastRuntimeMessage(
    turnNotification("turn/completed", "thread-a", "turn-late"),
  );
  assert.deepEqual(recoveries(events), ["waiting"]);
});

test("queues real completion before the recovery it releases", () => {
  const events = [];
  const coordinator = createCoordinator(events);
  coordinator.acceptRendererReady("original", null);
  coordinator.broadcastRuntimeMessage(
    turnNotification("turn/started", "thread-a", "turn-a"),
  );
  coordinator.acceptRendererReady("waiting", "thread-a");
  events.length = 0;

  const completion = turnNotification("turn/completed", "thread-a", "turn-a");
  coordinator.broadcastRuntimeMessage(completion);

  assert.deepEqual(events, [
    { type: "broadcast", message: completion },
    { type: "recover", connectionId: "waiting" },
  ]);
});

test("disposal clears pending recovery without evicting other renderers", () => {
  const events = [];
  const coordinator = createCoordinator(events);
  coordinator.acceptRendererReady("original", null);
  coordinator.broadcastRuntimeMessage(
    turnNotification("turn/started", "thread-a", "turn-a"),
  );
  coordinator.acceptRendererReady("waiting", "thread-a");
  coordinator.acceptRendererReady("coexisting", null);
  coordinator.acceptRendererReady("coexisting", null);

  assert.equal(coordinator.readySessionCount, 3);
  assert.equal(coordinator.waitingSessionCount, 1);
  assert.deepEqual(recoveries(events), ["coexisting"]);

  coordinator.disposeRenderer("waiting");
  assert.equal(coordinator.readySessionCount, 2);
  assert.equal(coordinator.waitingSessionCount, 0);
  coordinator.broadcastRuntimeMessage(
    turnNotification("turn/completed", "thread-a", "turn-a"),
  );

  assert.deepEqual(recoveries(events), ["coexisting"]);
  assert.equal(coordinator.readySessionCount, 2);
});

for (const snapshot of [
  { name: "terminal", inProgress: [] },
  { name: "missing", inProgress: ["unrelated-turn"] },
]) {
  test(`authoritative ${snapshot.name} snapshot releases a missing completion`, async () => {
    const events = [];
    const coordinator = new RendererRecoveryCoordinator({
      broadcast: (message) => events.push({ type: "broadcast", message }),
      recover: (connectionId) => events.push({ type: "recover", connectionId }),
      readThread: async () => new Set(snapshot.inProgress),
    });
    coordinator.acceptRendererReady("original", null);
    coordinator.broadcastRuntimeMessage(
      turnNotification("turn/started", "thread-a", "captured"),
    );
    coordinator.acceptRendererReady("waiting", "thread-a");

    await settlePromises();
    assert.deepEqual(recoveries(events), ["waiting"]);
    assert.equal(coordinator.waitingSessionCount, 0);
    coordinator.dispose();
  });
}

test("authoritative in-progress snapshot retains the captured turn", async () => {
  const events = [];
  const timers = new FakeTimers();
  let reads = 0;
  const coordinator = new RendererRecoveryCoordinator({
    broadcast: (message) => events.push({ type: "broadcast", message }),
    recover: (connectionId) => events.push({ type: "recover", connectionId }),
    readThread: async () => {
      reads += 1;
      return new Set(["captured"]);
    },
    retryDelayMs: 10,
    maximumWaitMs: 100,
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
  });
  coordinator.acceptRendererReady("original", null);
  coordinator.broadcastRuntimeMessage(
    turnNotification("turn/started", "thread-a", "captured"),
  );
  coordinator.acceptRendererReady("waiting", "thread-a");

  await settlePromises();
  assert.equal(reads, 1);
  assert.deepEqual(recoveries(events), []);
  assert.equal(coordinator.waitingSessionCount, 1);
  coordinator.dispose();
  assert.equal(timers.timers.size, 0);
});

test("snapshot removes only captured turns and retains a late same-thread start", async () => {
  const events = [];
  const timers = new FakeTimers();
  const firstRead = deferred();
  const coordinator = new RendererRecoveryCoordinator({
    broadcast: (message) => events.push({ type: "broadcast", message }),
    recover: (connectionId) => events.push({ type: "recover", connectionId }),
    readThread: () => firstRead.promise,
    retryDelayMs: 10,
    maximumWaitMs: 100,
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
  });
  coordinator.acceptRendererReady("original", null);
  coordinator.broadcastRuntimeMessage(
    turnNotification("turn/started", "thread-a", "captured"),
  );
  coordinator.acceptRendererReady("waiting", "thread-a");
  coordinator.broadcastRuntimeMessage(
    turnNotification("turn/started", "thread-a", "late"),
  );
  firstRead.resolve(new Set());
  await settlePromises();

  assert.deepEqual(recoveries(events), []);
  assert.equal(coordinator.waitingSessionCount, 1);
  coordinator.broadcastRuntimeMessage(
    turnNotification("turn/completed", "thread-a", "late"),
  );
  assert.deepEqual(recoveries(events), ["waiting"]);
  coordinator.dispose();
});

test("real completion wins a pending read race without duplicate recovery", async () => {
  const events = [];
  const pendingRead = deferred();
  const coordinator = new RendererRecoveryCoordinator({
    broadcast: (message) => events.push({ type: "broadcast", message }),
    recover: (connectionId) => events.push({ type: "recover", connectionId }),
    readThread: () => pendingRead.promise,
  });
  coordinator.acceptRendererReady("original", null);
  coordinator.broadcastRuntimeMessage(
    turnNotification("turn/started", "thread-a", "captured"),
  );
  coordinator.acceptRendererReady("waiting", "thread-a");
  const completion = turnNotification("turn/completed", "thread-a", "captured");
  events.length = 0;
  coordinator.broadcastRuntimeMessage(completion);
  pendingRead.resolve(new Set());
  await settlePromises();

  assert.deepEqual(events, [
    { type: "broadcast", message: completion },
    { type: "recover", connectionId: "waiting" },
  ]);
  coordinator.dispose();
});

test("read errors retry at bounded cadence and deadline falls open exactly once", async () => {
  const events = [];
  const timers = new FakeTimers();
  let reads = 0;
  const coordinator = new RendererRecoveryCoordinator({
    broadcast: (message) => events.push({ type: "broadcast", message }),
    recover: (connectionId) => events.push({ type: "recover", connectionId }),
    readThread: async () => {
      reads += 1;
      throw new Error("transient read failure");
    },
    retryDelayMs: 10,
    maximumWaitMs: 25,
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
  });
  coordinator.acceptRendererReady("original", null);
  coordinator.broadcastRuntimeMessage(
    turnNotification("turn/started", "thread-a", "captured"),
  );
  coordinator.acceptRendererReady("waiting", "thread-a");

  await settlePromises();
  timers.advance(10);
  await settlePromises();
  timers.advance(10);
  await settlePromises();
  assert.equal(reads, 3);
  timers.advance(5);
  await settlePromises();
  timers.advance(1_000);
  await settlePromises();

  assert.deepEqual(recoveries(events), ["waiting"]);
  assert.equal(coordinator.waitingSessionCount, 0);
  assert.equal(timers.timers.size, 0);
  coordinator.dispose();
});

test("disposal invalidates pending reads and independent threads reconcile separately", async () => {
  const events = [];
  const reads = new Map([
    ["thread-a", deferred()],
    ["thread-b", deferred()],
  ]);
  const coordinator = new RendererRecoveryCoordinator({
    broadcast: (message) => events.push({ type: "broadcast", message }),
    recover: (connectionId) => events.push({ type: "recover", connectionId }),
    readThread: (threadId) => reads.get(threadId).promise,
  });
  coordinator.acceptRendererReady("original", null);
  coordinator.broadcastRuntimeMessage(
    turnNotification("turn/started", "thread-a", "turn-a"),
  );
  coordinator.broadcastRuntimeMessage(
    turnNotification("turn/started", "thread-b", "turn-b"),
  );
  coordinator.acceptRendererReady("page-a", "thread-a");
  coordinator.acceptRendererReady("page-b", "thread-b");
  coordinator.disposeRenderer("page-a");
  reads.get("thread-a").resolve(new Set());
  reads.get("thread-b").resolve(new Set());
  await settlePromises();

  assert.deepEqual(recoveries(events), ["page-b"]);
  assert.equal(coordinator.waitingSessionCount, 0);
  coordinator.dispose();
});

test("coordinator disposal cancels timers and invalidates an in-flight read", async () => {
  const events = [];
  const timers = new FakeTimers();
  const pendingRead = deferred();
  const coordinator = new RendererRecoveryCoordinator({
    broadcast: (message) => events.push({ type: "broadcast", message }),
    recover: (connectionId) => events.push({ type: "recover", connectionId }),
    readThread: () => pendingRead.promise,
    retryDelayMs: 10,
    maximumWaitMs: 100,
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
  });
  coordinator.acceptRendererReady("original", null);
  coordinator.broadcastRuntimeMessage(
    turnNotification("turn/started", "thread-a", "captured"),
  );
  coordinator.acceptRendererReady("waiting", "thread-a");

  coordinator.dispose();
  assert.equal(timers.timers.size, 0);
  pendingRead.resolve(new Set());
  await settlePromises();
  timers.advance(1_000);

  assert.deepEqual(recoveries(events), []);
  assert.equal(coordinator.readySessionCount, 0);
  assert.equal(coordinator.waitingSessionCount, 0);
});
