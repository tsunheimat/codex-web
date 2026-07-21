const { randomUUID } = require("node:crypto");
const net = require("node:net");
const WebSocket = require("ws");

const MAX_PAYLOAD_BYTES = 100 * 1024 * 1024;
const ALL_TURN_STATUSES = new Set([
  "completed",
  "interrupted",
  "failed",
  "inProgress",
]);
const TERMINAL_TURN_STATUSES = new Set(["completed", "interrupted", "failed"]);

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateIdentifier(value, description) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${description} must be a non-empty string`);
  }
}

function terminalTurnStatusFromThreadReadResponse(
  response,
  requestId,
  threadId,
  turnId,
) {
  if (!isRecord(response) || response.id !== requestId) {
    throw new Error("thread/read response did not match its request id");
  }
  if ("error" in response) {
    throw new Error(`thread/read failed: ${JSON.stringify(response.error)}`);
  }
  if (!isRecord(response.result) || !isRecord(response.result.thread)) {
    throw new Error("thread/read response did not contain a thread");
  }

  const thread = response.result.thread;
  if (thread.id !== threadId) {
    throw new Error("thread/read response returned a different thread");
  }
  if (!Array.isArray(thread.turns)) {
    throw new Error("thread/read response did not include turns");
  }

  const seenTurnIds = new Set();
  let targetStatus = null;
  for (const turn of thread.turns) {
    if (
      !isRecord(turn) ||
      typeof turn.id !== "string" ||
      turn.id.length === 0 ||
      typeof turn.status !== "string" ||
      !ALL_TURN_STATUSES.has(turn.status) ||
      seenTurnIds.has(turn.id)
    ) {
      throw new Error("thread/read response contained ambiguous turn state");
    }
    seenTurnIds.add(turn.id);
    if (turn.id === turnId) targetStatus = turn.status;
  }

  return TERMINAL_TURN_STATUSES.has(targetStatus) ? targetStatus : null;
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

class EvidenceConnection {
  constructor(socket) {
    this.socket = socket;
    this.pending = null;
    this.fatalError = null;
    socket.on("message", (data, isBinary) => this.onMessage(data, isBinary));
    socket.on("error", (error) => this.fail(error));
    socket.on("close", () => {
      if (this.pending) {
        this.fail(new Error("app-server evidence WebSocket closed early"));
      }
    });
  }

  fail(error) {
    const failure = error instanceof Error ? error : new Error(String(error));
    this.fatalError ??= failure;
    if (!this.pending) return;
    const { reject, timeout } = this.pending;
    this.pending = null;
    clearTimeout(timeout);
    reject(failure);
  }

  onMessage(data, isBinary) {
    if (isBinary) {
      this.fail(new Error("app-server evidence received a binary frame"));
      return;
    }

    let message;
    try {
      message = JSON.parse(Buffer.from(data).toString("utf8"));
    } catch {
      this.fail(new Error("app-server evidence received invalid JSON"));
      return;
    }
    if (!isRecord(message)) {
      this.fail(new Error("app-server evidence received a non-object message"));
      return;
    }

    const isResponse = "result" in message || "error" in message;
    if (!isResponse) {
      if ("id" in message && typeof message.method === "string") {
        this.fail(
          new Error(
            `app-server evidence received unsupported server request ${message.method}`,
          ),
        );
      }
      return;
    }
    if (!this.pending) {
      this.fail(
        new Error("app-server evidence received an unexpected response"),
      );
      return;
    }
    if (message.id !== this.pending.requestId) {
      this.fail(new Error("app-server evidence response id mismatch"));
      return;
    }

    const { resolve, timeout } = this.pending;
    this.pending = null;
    clearTimeout(timeout);
    resolve(message);
  }

  async waitForOpen(timeoutMs) {
    if (this.socket.readyState === WebSocket.OPEN) return;
    if (this.fatalError) throw this.fatalError;
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        cleanup();
        reject(new Error("timed out opening app-server evidence WebSocket"));
      }, timeoutMs);
      const onOpen = () => {
        cleanup();
        resolve();
      };
      const onError = (error) => {
        cleanup();
        reject(error);
      };
      const onClose = () => {
        cleanup();
        reject(new Error("app-server evidence WebSocket closed before open"));
      };
      const cleanup = () => {
        clearTimeout(timeout);
        this.socket.off("open", onOpen);
        this.socket.off("error", onError);
        this.socket.off("close", onClose);
      };
      this.socket.once("open", onOpen);
      this.socket.once("error", onError);
      this.socket.once("close", onClose);
    });
  }

  async sendNotification(method) {
    await this.sendJson({ method });
  }

  async request(id, method, params, timeoutMs) {
    if (this.fatalError) throw this.fatalError;
    if (this.pending) {
      throw new Error("app-server evidence requests must be sequential");
    }
    const response = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        if (this.pending?.requestId !== id) return;
        this.pending = null;
        reject(new Error(`timed out waiting for ${method} response`));
      }, timeoutMs);
      this.pending = { requestId: id, resolve, reject, timeout };
    });
    try {
      await this.sendJson({ id, method, params });
    } catch (error) {
      this.fail(error);
    }
    return await response;
  }

  async sendJson(message) {
    if (this.socket.readyState !== WebSocket.OPEN) {
      throw new Error("app-server evidence WebSocket is not open");
    }
    await new Promise((resolve, reject) => {
      this.socket.send(JSON.stringify(message), { binary: false }, (error) =>
        error ? reject(error) : resolve(),
      );
    });
  }

  async close(timeoutMs = 2_000) {
    if (this.socket.readyState === WebSocket.CLOSED) return;
    if (this.socket.readyState === WebSocket.CONNECTING) {
      this.socket.terminate();
      return;
    }
    await new Promise((resolve) => {
      const timeout = setTimeout(() => {
        this.socket.terminate();
        resolve();
      }, timeoutMs);
      this.socket.once("close", () => {
        clearTimeout(timeout);
        resolve();
      });
      this.socket.close(1000, "authoritative evidence complete");
    });
  }
}

async function waitForAuthoritativeTerminalTurn({
  socketPath,
  threadId,
  turnId,
  maximumWaitMs = 30_000,
  pollIntervalMs = 100,
  requestTimeoutMs = 5_000,
}) {
  validateIdentifier(socketPath, "app-server socket path");
  validateIdentifier(threadId, "target thread id");
  validateIdentifier(turnId, "target turn id");
  if (!Number.isFinite(maximumWaitMs) || maximumWaitMs <= 0) {
    throw new Error("maximumWaitMs must be positive");
  }

  const socket = new WebSocket("ws://localhost/", {
    createConnection: () => net.createConnection({ path: socketPath }),
    maxPayload: MAX_PAYLOAD_BYTES,
    perMessageDeflate: false,
  });
  const connection = new EvidenceConnection(socket);
  const requestPrefix = `phase4-authoritative-evidence-${randomUUID()}`;
  const deadline = Date.now() + maximumWaitMs;
  let readCount = 0;

  try {
    await connection.waitForOpen(Math.min(requestTimeoutMs, maximumWaitMs));
    const initializeId = `${requestPrefix}-initialize`;
    const initializeResponse = await connection.request(
      initializeId,
      "initialize",
      {
        clientInfo: {
          name: "codex-web-phase4-restart-evidence",
          title: "Codex Web Phase 4 restart evidence",
          version: "1.0.0",
        },
        capabilities: { experimentalApi: true },
      },
      Math.min(requestTimeoutMs, Math.max(1, deadline - Date.now())),
    );
    if (
      initializeResponse.id !== initializeId ||
      "error" in initializeResponse ||
      !isRecord(initializeResponse.result)
    ) {
      throw new Error("app-server initialize handshake failed");
    }
    await connection.sendNotification("initialized");

    while (Date.now() < deadline) {
      readCount += 1;
      const requestId = `${requestPrefix}-thread-read-${readCount}`;
      const response = await connection.request(
        requestId,
        "thread/read",
        { threadId, includeTurns: true },
        Math.min(requestTimeoutMs, Math.max(1, deadline - Date.now())),
      );
      const terminalStatus = terminalTurnStatusFromThreadReadResponse(
        response,
        requestId,
        threadId,
        turnId,
      );
      if (terminalStatus) {
        return {
          requestId,
          readCount,
          status: terminalStatus,
          threadId,
          turnId,
        };
      }
      await delay(Math.min(pollIntervalMs, Math.max(1, deadline - Date.now())));
    }
    throw new Error(
      `target turn ${turnId} did not become terminal in authoritative thread ${threadId}`,
    );
  } finally {
    await connection.close();
  }
}

module.exports = {
  terminalTurnStatusFromThreadReadResponse,
  waitForAuthoritativeTerminalTurn,
};
