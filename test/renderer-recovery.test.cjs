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
  });
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
    },
  );
  assert.deepEqual(
    parseRendererBridgeReady({
      type: "renderer-bridge-ready",
      currentThreadId: null,
    }),
    { type: "renderer-bridge-ready", currentThreadId: null },
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
