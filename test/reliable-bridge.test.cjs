const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const test = require("node:test");
const {
  parseReliableBridgeHello,
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
