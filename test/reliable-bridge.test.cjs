const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const test = require("node:test");
const {
  parseReliableBridgeHello,
  ReliableBridgeCapacity,
  ReliableBridgeSession,
} = require("../src/server/reliable-bridge.js");

class FakeSocket extends EventEmitter {
  readyState = 1;
  sent = [];

  send(payload) {
    this.sent.push(JSON.parse(String(payload)));
  }

  close() {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.emit("close");
  }

  terminate() {
    this.close();
  }

  receive(frame) {
    this.emit("message", Buffer.from(JSON.stringify(frame)));
  }
}

function createSession(received, options = {}) {
  let disposeReason = null;
  const session = new ReliableBridgeSession({
    connectionId: options.connectionId ?? "connection-a",
    serverEpoch: "epoch-a",
    graceTimeMs: 60_000,
    ...options,
    onDispose: (reason) => {
      disposeReason = reason;
    },
    onMessage: (message) => received.push(message),
  });
  return { session, disposeReason: () => disposeReason };
}

function dataFrames(socket) {
  return socket.sent.filter((frame) => frame.type === "bridge-data");
}

test("replays only unacknowledged server messages after socket replacement", () => {
  const { session } = createSession([]);
  const first = new FakeSocket();
  session.attach(first);
  session.send({ value: "one" });
  first.close();
  session.send({ value: "two" });

  const second = new FakeSocket();
  session.attach(second);
  assert.deepEqual(
    dataFrames(second).map((frame) => frame.id),
    [1, 2],
  );
  second.receive({ type: "bridge-ack", ack: 2 });
  second.close();

  const third = new FakeSocket();
  session.attach(third);
  assert.deepEqual(dataFrames(third), []);
  session.dispose("done");
});

test("suppresses replayed client duplicates and requests an ordered gap", () => {
  const received = [];
  const { session } = createSession(received);
  const first = new FakeSocket();
  session.attach(first);
  first.receive({
    type: "bridge-data",
    id: 1,
    ack: 0,
    message: { value: "one" },
  });
  first.close();

  const second = new FakeSocket();
  session.attach(second);
  second.receive({
    type: "bridge-data",
    id: 1,
    ack: 0,
    message: { value: "duplicate" },
  });
  second.receive({
    type: "bridge-data",
    id: 3,
    ack: 0,
    message: { value: "gap" },
  });
  assert.deepEqual(received, [{ value: "one" }]);
  assert.deepEqual(second.sent.at(-1), {
    type: "bridge-replay-request",
    ack: 1,
  });
  session.dispose("done");
});

test("uses acknowledgement-driven in-flight and total buffer bounds", () => {
  const { session } = createSession([], { maxInFlightBytes: 100 });
  const first = new FakeSocket();
  session.attach(first);
  first.close();
  session.send({ value: "a".repeat(60) });
  session.send({ value: "b".repeat(60) });
  const second = new FakeSocket();
  session.attach(second);
  assert.deepEqual(
    dataFrames(second).map((frame) => frame.id),
    [1],
  );
  second.receive({ type: "bridge-ack", ack: 1 });
  assert.deepEqual(
    dataFrames(second).map((frame) => frame.id),
    [1, 2],
  );
  session.dispose("done");

  const bounded = createSession([], { maxUnackedBytes: 8 });
  const socket = new FakeSocket();
  bounded.session.attach(socket);
  bounded.session.send({ tooLarge: true });
  assert.equal(bounded.disposeReason(), "reliable bridge buffer exceeded");
});

test("rejects new retained sessions at capacity but allows existing reconnects", () => {
  const capacity = new ReliableBridgeCapacity();

  for (let index = 0; index < 16; index += 1) {
    assert.equal(capacity.retainSession(`page-${index}`), true);
  }
  assert.equal(capacity.retainedSessionCount, 16);
  assert.equal(capacity.retainSession("page-0"), true);
  assert.equal(capacity.retainedSessionCount, 16);
  assert.equal(capacity.retainSession("page-16"), false);

  capacity.releaseSession("page-0");
  capacity.releaseSession("page-0");
  assert.equal(capacity.retainSession("page-16"), true);
  assert.equal(capacity.retainedSessionCount, 16);
});

test("defaults to a 128 MiB process-wide byte budget", () => {
  const capacity = new ReliableBridgeCapacity();
  const maxBytes = 128 * 1024 * 1024;

  assert.equal(capacity.reserveBytes(maxBytes), true);
  assert.equal(capacity.retainedUnackedBytes, maxBytes);
  assert.equal(capacity.reserveBytes(1), false);
  assert.equal(capacity.retainedUnackedBytes, maxBytes);
  capacity.releaseBytes(maxBytes);
  assert.equal(capacity.retainedUnackedBytes, 0);
});

test("enforces cross-session bytes and releases reservations exactly once", () => {
  const payload = { value: "shared-capacity" };
  const payloadBytes = Buffer.byteLength(JSON.stringify(payload));
  const capacity = new ReliableBridgeCapacity({
    maxTotalUnackedBytes: payloadBytes,
  });
  const a = createSession([], {
    connectionId: "page-a",
    capacity,
  });
  const b = createSession([], {
    connectionId: "page-b",
    capacity,
  });
  const socketA = new FakeSocket();
  const socketB = new FakeSocket();
  a.session.attach(socketA);
  b.session.attach(socketB);

  a.session.send(payload);
  assert.equal(capacity.retainedUnackedBytes, payloadBytes);
  b.session.send(payload);
  assert.equal(b.disposeReason(), "reliable bridge process buffer exceeded");
  assert.equal(capacity.retainedUnackedBytes, payloadBytes);

  socketA.receive({ type: "bridge-ack", ack: 1 });
  socketA.receive({ type: "bridge-ack", ack: 1 });
  assert.equal(capacity.retainedUnackedBytes, 0);

  const c = createSession([], {
    connectionId: "page-c",
    capacity,
  });
  const socketC = new FakeSocket();
  c.session.attach(socketC);
  c.session.send(payload);
  assert.equal(capacity.retainedUnackedBytes, payloadBytes);
  c.session.dispose("done");
  c.session.dispose("done again");
  assert.equal(capacity.retainedUnackedBytes, 0);
  a.session.dispose("done");
});

for (const frameType of ["bridge-ack", "bridge-replay-request"]) {
  test(`rejects ${frameType} for an unsent queued message before mutation`, () => {
    const bridge = createSession([], { maxInFlightBytes: 100 });
    const first = new FakeSocket();
    bridge.session.attach(first);
    first.close();
    bridge.session.send({ value: "a".repeat(60) });
    bridge.session.send({ value: "b".repeat(60) });

    const second = new FakeSocket();
    bridge.session.attach(second);
    assert.deepEqual(
      dataFrames(second).map((frame) => frame.id),
      [1],
    );

    let stateAtReset = null;
    const reset = bridge.session.reset.bind(bridge.session);
    bridge.session.reset = (reason) => {
      stateAtReset = {
        reason,
        outgoingAckId: bridge.session.outgoingAckId,
        queuedIds: bridge.session.outgoingUnacked.map((message) => message.id),
      };
      reset(reason);
    };

    second.receive({ type: frameType, ack: 2 });

    assert.deepEqual(stateAtReset, {
      reason: "invalid reliable bridge acknowledgement",
      outgoingAckId: 0,
      queuedIds: [1, 2],
    });
    assert.equal(
      bridge.disposeReason(),
      "invalid reliable bridge acknowledgement",
    );
  });
}

test("new page connection ids do not inherit prior in-memory state", () => {
  const receivedA = [];
  const receivedB = [];
  const a = createSession(receivedA, { connectionId: "page-a" }).session;
  const b = createSession(receivedB, { connectionId: "page-b" }).session;
  const socketA = new FakeSocket();
  const socketB = new FakeSocket();
  a.attach(socketA);
  b.attach(socketB);
  socketA.receive({ type: "bridge-data", id: 1, ack: 0, message: "a" });
  socketB.receive({ type: "bridge-data", id: 1, ack: 0, message: "b" });
  assert.deepEqual(receivedA, ["a"]);
  assert.deepEqual(receivedB, ["b"]);
  a.dispose("done");
  b.dispose("done");
});

test("validates bounded reliable bridge handshakes", () => {
  assert.deepEqual(
    parseReliableBridgeHello({
      type: "bridge-hello",
      protocolVersion: 2,
      connectionId: "page-a",
      serverEpoch: null,
    }),
    {
      type: "bridge-hello",
      protocolVersion: 2,
      connectionId: "page-a",
      serverEpoch: null,
    },
  );
  assert.equal(
    parseReliableBridgeHello({
      type: "bridge-hello",
      protocolVersion: 2,
      connectionId: "x".repeat(129),
      serverEpoch: null,
    }),
    null,
  );
});
