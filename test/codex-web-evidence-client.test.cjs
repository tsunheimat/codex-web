const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const http = require("node:http");
const test = require("node:test");
const WebSocket = require("ws");
const {
  BridgeEvidenceConnection,
  terminalTurnStatusFromBridgeMessage,
  waitForAuthoritativeTerminalTurnViaCodexWeb,
} = require("./fixtures/codex-web-evidence-client.cjs");

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

function bridgeResponse(requestId, threadId, turns) {
  return {
    type: "ipc-main-event",
    channel: "codex_desktop:message-for-view",
    args: [
      {
        type: "mcp-response",
        hostId: "local",
        message: {
          id: requestId,
          result: { thread: { id: threadId, turns } },
        },
      },
    ],
  };
}

test("bridge terminal evidence binds the MCP envelope, request, thread and turn", () => {
  const response = bridgeResponse("read-a", "thread-a", [
    { id: "turn-a", status: "completed" },
  ]);
  assert.equal(
    terminalTurnStatusFromBridgeMessage(
      response,
      "read-a",
      "thread-a",
      "turn-a",
    ),
    "completed",
  );

  for (const invalid of [
    null,
    { ...response, channel: "other" },
    { ...response, args: [] },
    {
      ...response,
      args: [{ ...response.args[0], hostId: "remote" }],
    },
  ]) {
    assert.throws(() =>
      terminalTurnStatusFromBridgeMessage(
        invalid,
        "read-a",
        "thread-a",
        "turn-a",
      ),
    );
  }
});

test(
  "codex-web evidence send rejects and terminates its socket when the callback stalls",
  { timeout: 2_000 },
  async () => {
    const socket = new FakeEvidenceSocket({ completeSend: false });
    const unrelatedSocket = new FakeEvidenceSocket();
    const connection = new BridgeEvidenceConnection(socket, Date.now() + 100);

    await assert.rejects(
      connection.sendJson({ type: "bridge-keepalive" }),
      /timed out sending codex-web evidence frame/,
    );
    assert.equal(socket.terminateCount, 1);
    assert.equal(unrelatedSocket.terminateCount, 0);
  },
);

test(
  "codex-web evidence response wait rejects and terminates its socket at the deadline",
  { timeout: 2_000 },
  async () => {
    const socket = new FakeEvidenceSocket();
    const connection = new BridgeEvidenceConnection(socket, Date.now() + 100);

    await assert.rejects(
      connection.readThread({
        invokeRequestId: "invoke-a",
        requestId: "request-a",
        threadId: "thread-a",
        sourceUrl: "http://127.0.0.1/thread/thread-a",
      }),
      /timed out waiting for authoritative thread\/read/,
    );
    assert.equal(socket.terminateCount, 1);
  },
);

test(
  "codex-web evidence disconnect rejects and terminates its socket at the deadline",
  { timeout: 2_000 },
  async () => {
    const socket = new FakeEvidenceSocket();
    const unrelatedSocket = new FakeEvidenceSocket();
    const connection = new BridgeEvidenceConnection(socket, Date.now() + 100);

    await assert.rejects(
      connection.close(),
      /timed out closing codex-web evidence WebSocket/,
    );
    assert.equal(socket.terminateCount, 1);
    assert.equal(unrelatedSocket.terminateCount, 0);
  },
);

test("codex-web evidence client polls exact thread/read without starting a turn", async () => {
  const httpServer = http.createServer();
  const websocketServer = new WebSocket.Server({ server: httpServer });
  const received = [];
  let incomingId = 0;

  websocketServer.on("connection", (socket) => {
    socket.on("message", (data, isBinary) => {
      assert.equal(isBinary, false);
      const frame = JSON.parse(Buffer.from(data).toString("utf8"));
      received.push(frame);
      if (frame.type === "bridge-hello") {
        socket.send(
          JSON.stringify({
            type: "bridge-ready",
            connectionId: frame.connectionId,
            serverEpoch: "server-a-epoch",
          }),
        );
        return;
      }
      if (frame.type === "bridge-disconnect") {
        socket.close(1000, "evidence complete");
        return;
      }
      if (frame.type !== "bridge-data") return;
      const request = frame.message.args[0].request;
      const readCount = received.filter(
        (candidate) =>
          candidate.type === "bridge-data" &&
          candidate.message.args[0].request.method === "thread/read",
      ).length;
      incomingId += 1;
      socket.send(
        JSON.stringify({
          type: "bridge-data",
          id: incomingId,
          ack: frame.id,
          message: bridgeResponse(request.id, "thread-a", [
            {
              id: "turn-a",
              status: readCount === 1 ? "inProgress" : "completed",
            },
          ]),
        }),
      );
    });
  });

  try {
    await new Promise((resolve, reject) => {
      httpServer.once("error", reject);
      httpServer.listen(0, "127.0.0.1", resolve);
    });
    const address = httpServer.address();
    assert(address && typeof address !== "string");
    const evidence = await waitForAuthoritativeTerminalTurnViaCodexWeb({
      baseUrl: `http://127.0.0.1:${address.port}`,
      threadId: "thread-a",
      turnId: "turn-a",
      maximumWaitMs: 2_000,
      pollIntervalMs: 1,
    });

    assert.equal(evidence.status, "completed");
    assert.equal(evidence.readCount, 2);
    assert.equal(evidence.serverEpoch, "server-a-epoch");
    const requests = received
      .filter(({ type }) => type === "bridge-data")
      .map(({ message }) => message);
    assert.equal(requests.length, 2);
    assert(
      requests.every(
        ({ channel, args }) =>
          channel === "codex_desktop:message-from-view" &&
          args[0].type === "mcp-request" &&
          args[0].hostId === "local" &&
          args[0].request.method === "thread/read" &&
          args[0].request.params.threadId === "thread-a" &&
          args[0].request.params.includeTurns === true,
      ),
    );
    assert.equal(
      requests.filter(({ args }) => args[0].request.method === "turn/start")
        .length,
      0,
    );
    assert(received.some(({ type }) => type === "bridge-disconnect"));
  } finally {
    for (const socket of websocketServer.clients) socket.terminate();
    await new Promise((resolve) => websocketServer.close(() => resolve()));
    await new Promise((resolve, reject) =>
      httpServer.close((error) => (error ? reject(error) : resolve())),
    );
  }
});
