const { randomUUID } = require("node:crypto");
const WebSocket = require("ws");
const {
  terminalTurnStatusFromThreadReadResponse,
} = require("./app-server-evidence-client.cjs");

const MAX_PAYLOAD_BYTES = 100 * 1024 * 1024;

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateNonEmptyString(value, description) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${description} must be a non-empty string`);
  }
}

function terminalTurnStatusFromBridgeMessage(
  value,
  requestId,
  threadId,
  turnId,
) {
  if (
    !isRecord(value) ||
    value.type !== "ipc-main-event" ||
    value.channel !== "codex_desktop:message-for-view" ||
    !Array.isArray(value.args) ||
    value.args.length !== 1
  ) {
    throw new Error("invalid app-server bridge response envelope");
  }
  const response = value.args[0];
  if (
    !isRecord(response) ||
    response.type !== "mcp-response" ||
    response.hostId !== "local" ||
    !isRecord(response.message)
  ) {
    throw new Error("invalid app-server bridge MCP response");
  }
  return terminalTurnStatusFromThreadReadResponse(
    response.message,
    requestId,
    threadId,
    turnId,
  );
}

class BridgeEvidenceConnection {
  constructor(socket) {
    this.socket = socket;
    this.fatalError = null;
    this.handshake = null;
    this.incomingMessageId = 0;
    this.outgoingMessageId = 0;
    this.pending = null;
    socket.on("message", (data, isBinary) => this.onMessage(data, isBinary));
    socket.on("error", (error) => this.fail(error));
    socket.on("close", () => {
      if (this.handshake || this.pending) {
        this.fail(new Error("codex-web evidence bridge closed early"));
      }
    });
  }

  fail(error) {
    const failure = error instanceof Error ? error : new Error(String(error));
    this.fatalError ??= failure;
    for (const pending of [this.handshake, this.pending]) {
      if (!pending) continue;
      clearTimeout(pending.timeout);
      pending.reject(failure);
    }
    this.handshake = null;
    this.pending = null;
  }

  onMessage(data, isBinary) {
    if (isBinary) {
      this.fail(new Error("codex-web evidence bridge received binary data"));
      return;
    }

    let frame;
    try {
      frame = JSON.parse(Buffer.from(data).toString("utf8"));
    } catch {
      this.fail(new Error("codex-web evidence bridge received invalid JSON"));
      return;
    }
    if (!isRecord(frame) || typeof frame.type !== "string") {
      this.fail(
        new Error("codex-web evidence bridge received an invalid frame"),
      );
      return;
    }

    if (frame.type === "bridge-reset") {
      this.fail(
        new Error(
          `codex-web evidence bridge reset: ${String(frame.reason ?? "unknown")}`,
        ),
      );
      return;
    }
    if (frame.type === "bridge-ready") {
      if (
        !this.handshake ||
        frame.connectionId !== this.handshake.connectionId ||
        typeof frame.serverEpoch !== "string" ||
        frame.serverEpoch.length === 0
      ) {
        this.fail(new Error("codex-web evidence bridge handshake mismatch"));
        return;
      }
      const { resolve, timeout } = this.handshake;
      this.handshake = null;
      clearTimeout(timeout);
      resolve(frame.serverEpoch);
      return;
    }
    if (frame.type === "bridge-keepalive") {
      this.sendJson({ type: "bridge-keepalive" }).catch((error) =>
        this.fail(error),
      );
      return;
    }
    if (frame.type !== "bridge-data") {
      return;
    }
    if (
      !Number.isSafeInteger(frame.id) ||
      frame.id !== this.incomingMessageId + 1 ||
      !isRecord(frame.message)
    ) {
      this.fail(new Error("codex-web evidence bridge data sequence mismatch"));
      return;
    }
    this.incomingMessageId = frame.id;
    this.sendJson({ type: "bridge-ack", ack: frame.id }).catch((error) =>
      this.fail(error),
    );

    if (!this.pending) {
      return;
    }
    const message = frame.message;
    if (
      message.type === "ipc-renderer-invoke-result" &&
      message.requestId === this.pending.invokeRequestId &&
      message.ok === false
    ) {
      this.fail(
        new Error(
          `codex-web evidence invoke failed: ${String(message.errorMessage)}`,
        ),
      );
      return;
    }
    const response = message.args?.[0];
    if (
      message.type !== "ipc-main-event" ||
      message.channel !== "codex_desktop:message-for-view" ||
      !isRecord(response) ||
      response.type !== "mcp-response" ||
      !isRecord(response.message) ||
      response.message.id !== this.pending.appServerRequestId
    ) {
      return;
    }

    const { resolve, timeout } = this.pending;
    this.pending = null;
    clearTimeout(timeout);
    resolve(message);
  }

  async open(connectionId, timeoutMs) {
    if (this.fatalError) throw this.fatalError;
    if (this.socket.readyState !== WebSocket.OPEN) {
      await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          cleanup();
          reject(new Error("timed out opening codex-web evidence WebSocket"));
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
          reject(new Error("codex-web evidence WebSocket closed before open"));
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

    const serverEpoch = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        if (this.handshake?.connectionId !== connectionId) return;
        this.handshake = null;
        reject(new Error("timed out handshaking codex-web evidence bridge"));
      }, timeoutMs);
      this.handshake = { connectionId, reject, resolve, timeout };
    });
    await this.sendJson({
      type: "bridge-hello",
      protocolVersion: 2,
      connectionId,
      serverEpoch: null,
    });
    return await serverEpoch;
  }

  async readThread({
    invokeRequestId,
    requestId,
    threadId,
    sourceUrl,
    timeoutMs,
  }) {
    if (this.fatalError) throw this.fatalError;
    if (this.pending) {
      throw new Error("codex-web evidence requests must be sequential");
    }
    const response = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        if (this.pending?.appServerRequestId !== requestId) return;
        this.pending = null;
        reject(new Error("timed out waiting for authoritative thread/read"));
      }, timeoutMs);
      this.pending = {
        appServerRequestId: requestId,
        invokeRequestId,
        reject,
        resolve,
        timeout,
      };
    });

    this.outgoingMessageId += 1;
    try {
      await this.sendJson({
        type: "bridge-data",
        id: this.outgoingMessageId,
        ack: this.incomingMessageId,
        message: {
          type: "ipc-renderer-invoke",
          requestId: invokeRequestId,
          channel: "codex_desktop:message-from-view",
          args: [
            {
              type: "mcp-request",
              hostId: "local",
              request: {
                id: requestId,
                method: "thread/read",
                params: { threadId, includeTurns: true },
              },
            },
          ],
          sourceUrl,
        },
      });
    } catch (error) {
      this.fail(error);
    }
    return await response;
  }

  async sendJson(value) {
    if (this.socket.readyState !== WebSocket.OPEN) {
      throw new Error("codex-web evidence WebSocket is not open");
    }
    await new Promise((resolve, reject) => {
      this.socket.send(JSON.stringify(value), { binary: false }, (error) =>
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
    await this.sendJson({ type: "bridge-disconnect" }).catch(() => undefined);
    await new Promise((resolve) => {
      const timeout = setTimeout(() => {
        this.socket.terminate();
        resolve();
      }, timeoutMs);
      this.socket.once("close", () => {
        clearTimeout(timeout);
        resolve();
      });
    });
  }
}

async function waitForAuthoritativeTerminalTurnViaCodexWeb({
  baseUrl,
  threadId,
  turnId,
  maximumWaitMs = 30_000,
  pollIntervalMs = 100,
  requestTimeoutMs = 5_000,
}) {
  validateNonEmptyString(baseUrl, "codex-web base URL");
  validateNonEmptyString(threadId, "target thread id");
  validateNonEmptyString(turnId, "target turn id");
  if (!Number.isFinite(maximumWaitMs) || maximumWaitMs <= 0) {
    throw new Error("maximumWaitMs must be positive");
  }

  const parsedBaseUrl = new URL(baseUrl);
  if (
    parsedBaseUrl.protocol !== "http:" &&
    parsedBaseUrl.protocol !== "https:"
  ) {
    throw new Error("codex-web base URL must use HTTP or HTTPS");
  }
  const websocketUrl = new URL("/__backend/ipc", parsedBaseUrl);
  websocketUrl.protocol = parsedBaseUrl.protocol === "https:" ? "wss:" : "ws:";
  const sourceUrl = new URL(
    `/thread/${encodeURIComponent(threadId)}`,
    parsedBaseUrl,
  ).toString();
  const socket = new WebSocket(websocketUrl, {
    maxPayload: MAX_PAYLOAD_BYTES,
    perMessageDeflate: false,
  });
  const connection = new BridgeEvidenceConnection(socket);
  const requestPrefix = `phase6-authoritative-evidence-${randomUUID()}`;
  const connectionId = `${requestPrefix}-bridge`;
  const deadline = Date.now() + maximumWaitMs;
  let readCount = 0;

  try {
    const serverEpoch = await connection.open(
      connectionId,
      Math.min(requestTimeoutMs, maximumWaitMs),
    );
    while (Date.now() < deadline) {
      readCount += 1;
      const requestId = `${requestPrefix}-thread-read-${readCount}`;
      const response = await connection.readThread({
        invokeRequestId: `${requestPrefix}-invoke-${readCount}`,
        requestId,
        threadId,
        sourceUrl,
        timeoutMs: Math.min(
          requestTimeoutMs,
          Math.max(1, deadline - Date.now()),
        ),
      });
      const status = terminalTurnStatusFromBridgeMessage(
        response,
        requestId,
        threadId,
        turnId,
      );
      if (status) {
        return { readCount, requestId, serverEpoch, status, threadId, turnId };
      }
      await new Promise((resolve) =>
        setTimeout(
          resolve,
          Math.min(pollIntervalMs, Math.max(1, deadline - Date.now())),
        ),
      );
    }
    throw new Error(
      `target turn ${turnId} did not become terminal in authoritative thread ${threadId}`,
    );
  } finally {
    await connection.close();
  }
}

module.exports = {
  terminalTurnStatusFromBridgeMessage,
  waitForAuthoritativeTerminalTurnViaCodexWeb,
};
