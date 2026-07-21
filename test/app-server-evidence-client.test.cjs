const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { EventEmitter } = require("node:events");
const test = require("node:test");
const WebSocket = require("ws");
const {
  EvidenceConnection,
  terminalTurnStatusFromThreadReadResponse,
  waitForAuthoritativeTerminalTurn,
} = require("./fixtures/app-server-evidence-client.cjs");

class FakeEvidenceSocket extends EventEmitter {
  constructor({ completeSend = true } = {}) {
    super();
    this.completeSend = completeSend;
    this.readyState = WebSocket.OPEN;
    this.terminateCount = 0;
  }

  send(_message, _options, callback) {
    if (this.completeSend) callback();
  }

  close() {}

  terminate() {
    this.terminateCount += 1;
    this.readyState = WebSocket.CLOSED;
  }
}

function threadReadResponse(id, threadId, turns) {
  return { id, result: { thread: { id: threadId, turns } } };
}

test("terminal snapshot validation binds request, thread, turn and status", () => {
  const requestId = "read-1";
  const threadId = "thread-a";
  const response = threadReadResponse(requestId, threadId, [
    { id: "turn-active", status: "inProgress" },
    { id: "turn-completed", status: "completed" },
    { id: "turn-interrupted", status: "interrupted" },
    { id: "turn-failed", status: "failed" },
  ]);

  assert.equal(
    terminalTurnStatusFromThreadReadResponse(
      response,
      requestId,
      threadId,
      "turn-completed",
    ),
    "completed",
  );
  assert.equal(
    terminalTurnStatusFromThreadReadResponse(
      response,
      requestId,
      threadId,
      "turn-interrupted",
    ),
    "interrupted",
  );
  assert.equal(
    terminalTurnStatusFromThreadReadResponse(
      response,
      requestId,
      threadId,
      "turn-failed",
    ),
    "failed",
  );
  assert.equal(
    terminalTurnStatusFromThreadReadResponse(
      response,
      requestId,
      threadId,
      "turn-active",
    ),
    null,
  );
  assert.equal(
    terminalTurnStatusFromThreadReadResponse(
      response,
      requestId,
      threadId,
      "turn-missing",
    ),
    null,
  );
});

test("terminal snapshot validation rejects mismatched and ambiguous evidence", () => {
  const requestId = "read-1";
  const threadId = "thread-a";
  for (const response of [
    null,
    { id: "other", result: { thread: { id: threadId, turns: [] } } },
    { id: requestId, error: { message: "read failed" } },
    threadReadResponse(requestId, "other-thread", []),
    threadReadResponse(requestId, threadId, null),
    threadReadResponse(requestId, threadId, [
      { id: "turn-a", status: "unknown" },
    ]),
    threadReadResponse(requestId, threadId, [
      { id: "turn-a", status: "completed" },
      { id: "turn-a", status: "inProgress" },
    ]),
  ]) {
    assert.throws(() =>
      terminalTurnStatusFromThreadReadResponse(
        response,
        requestId,
        threadId,
        "turn-a",
      ),
    );
  }
});

test(
  "app-server evidence send rejects and terminates its socket when the callback stalls",
  { timeout: 2_000 },
  async () => {
    const socket = new FakeEvidenceSocket({ completeSend: false });
    const unrelatedSocket = new FakeEvidenceSocket();
    const connection = new EvidenceConnection(socket, Date.now() + 100);

    await assert.rejects(
      connection.sendJson({ method: "initialized" }),
      /timed out sending app-server evidence frame/,
    );
    assert.equal(socket.terminateCount, 1);
    assert.equal(unrelatedSocket.terminateCount, 0);
  },
);

test(
  "app-server evidence response wait rejects and terminates its socket at the deadline",
  { timeout: 2_000 },
  async () => {
    const socket = new FakeEvidenceSocket();
    const connection = new EvidenceConnection(socket, Date.now() + 100);

    await assert.rejects(
      connection.request("request-a", "thread/read", {
        threadId: "thread-a",
      }),
      /timed out waiting for thread\/read response/,
    );
    assert.equal(socket.terminateCount, 1);
  },
);

test(
  "app-server evidence close rejects and terminates its socket at the deadline",
  { timeout: 2_000 },
  async () => {
    const socket = new FakeEvidenceSocket();
    const unrelatedSocket = new FakeEvidenceSocket();
    const connection = new EvidenceConnection(socket, Date.now() + 100);

    await assert.rejects(
      connection.close(),
      /timed out closing app-server evidence WebSocket/,
    );
    assert.equal(socket.terminateCount, 1);
    assert.equal(unrelatedSocket.terminateCount, 0);
  },
);

test("Unix WebSocket evidence client handshakes, reads until terminal and closes", async () => {
  const tempRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "codex-web-evidence-client-"),
  );
  const socketPath = path.join(tempRoot, "app-server.sock");
  const httpServer = http.createServer();
  const websocketServer = new WebSocket.Server({ server: httpServer });
  const received = [];
  let appServerSocket;

  websocketServer.on("connection", (socket) => {
    appServerSocket = socket;
    socket.on("message", (data, isBinary) => {
      assert.equal(isBinary, false);
      const message = JSON.parse(Buffer.from(data).toString("utf8"));
      received.push(message);
      if (message.method === "initialize") {
        socket.send(
          JSON.stringify({ id: message.id, result: { userAgent: "test" } }),
        );
        return;
      }
      if (message.method === "thread/read") {
        const readCount = received.filter(
          ({ method }) => method === "thread/read",
        ).length;
        socket.send(
          JSON.stringify(
            threadReadResponse(message.id, "thread-a", [
              {
                id: "turn-a",
                status: readCount === 1 ? "inProgress" : "completed",
              },
            ]),
          ),
        );
      }
    });
  });

  try {
    await new Promise((resolve, reject) => {
      httpServer.once("error", reject);
      httpServer.listen(socketPath, resolve);
    });

    const evidence = await waitForAuthoritativeTerminalTurn({
      socketPath,
      threadId: "thread-a",
      turnId: "turn-a",
      maximumWaitMs: 2_000,
      pollIntervalMs: 1,
    });

    assert.equal(evidence.status, "completed");
    assert.equal(evidence.readCount, 2);
    assert.deepEqual(
      received.map(({ method }) => method),
      ["initialize", "initialized", "thread/read", "thread/read"],
    );
    assert.deepEqual(received[0].params, {
      clientInfo: {
        name: "codex-web-phase4-restart-evidence",
        title: "Codex Web Phase 4 restart evidence",
        version: "1.0.0",
      },
      capabilities: { experimentalApi: true },
    });
    assert.deepEqual(received[2].params, {
      threadId: "thread-a",
      includeTurns: true,
    });
    assert.equal(appServerSocket.readyState, WebSocket.CLOSED);
  } finally {
    for (const socket of websocketServer.clients) socket.terminate();
    await new Promise((resolve) => websocketServer.close(() => resolve()));
    await new Promise((resolve, reject) =>
      httpServer.close((error) => (error ? reject(error) : resolve())),
    );
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});
