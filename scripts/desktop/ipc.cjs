// Codex Desktop IPC wire protocol. Independently implemented from the installed
// application's handlers; see docs/remote-desktop.md for reference provenance.
const net = require("node:net");
const { randomUUID } = require("node:crypto");
const { EventEmitter } = require("node:events");

class DesktopError extends Error {
  constructor(code, message, unknown = false) {
    super(message);
    this.code = code;
    this.deliveryUnknown = unknown;
  }
}

function encodeFrame(message, limit = 64 * 1024 * 1024) {
  const body = Buffer.from(JSON.stringify(message));
  if (!body.length || body.length > limit)
    throw new DesktopError(
      "FRAME_LIMIT",
      "Desktop message exceeds the bridge frame limit",
    );
  const frame = Buffer.allocUnsafe(4 + body.length);
  frame.writeUInt32LE(body.length);
  body.copy(frame, 4);
  return frame;
}

class FrameReader {
  constructor(receive, limit = 64 * 1024 * 1024) {
    this.receive = receive;
    this.limit = limit;
    this.header = Buffer.alloc(4);
    this.reset();
  }
  reset() {
    this.headerUsed = 0;
    this.body = null;
    this.used = 0;
  }
  push(chunk) {
    let offset = 0;
    while (offset < chunk.length) {
      if (!this.body) {
        const count = Math.min(4 - this.headerUsed, chunk.length - offset);
        chunk.copy(this.header, this.headerUsed, offset);
        this.headerUsed += count;
        offset += count;
        if (this.headerUsed < 4) continue;
        const length = this.header.readUInt32LE();
        if (!length || length > this.limit)
          throw new DesktopError("FRAME_LIMIT", "Invalid Desktop frame length");
        this.body = Buffer.allocUnsafe(length);
      }
      const count = Math.min(
        this.body.length - this.used,
        chunk.length - offset,
      );
      chunk.copy(this.body, this.used, offset);
      this.used += count;
      offset += count;
      if (this.used === this.body.length) {
        const message = JSON.parse(this.body.toString("utf8"));
        this.reset();
        if (!message || typeof message !== "object" || Array.isArray(message))
          throw new DesktopError("PROTOCOL", "Invalid Desktop envelope");
        this.receive(message);
      }
    }
  }
}

class DesktopIpc extends EventEmitter {
  constructor({
    endpoint = "\\\\.\\pipe\\codex-ipc",
    versions,
    timeoutMs = 15000,
  }) {
    super();
    this.endpoint = endpoint;
    this.versions = versions;
    this.timeoutMs = timeoutMs;
    this.pending = new Map();
    this.clientId = null;
    this.socket = null;
    this.opening = null;
  }
  connect() {
    if (this.clientId) return Promise.resolve();
    if (this.opening) return this.opening;
    this.opening = this.open().finally(() => {
      this.opening = null;
    });
    return this.opening;
  }
  async open() {
    const socket = net.createConnection(this.endpoint);
    this.socket = socket;
    const reader = new FrameReader((message) => this.receive(message));
    socket.on("data", (chunk) => {
      try {
        reader.push(chunk);
      } catch {
        socket.destroy();
      }
    });
    socket.on("error", () => {});
    socket.on("close", () => {
      if (this.socket !== socket) return;
      this.socket = null;
      this.clientId = null;
      for (const p of this.pending.values()) {
        clearTimeout(p.timer);
        p.reject(
          new DesktopError(
            "IPC_DISCONNECTED",
            "Desktop disconnected before acknowledgement; reconcile before submitting again",
            true,
          ),
        );
      }
      this.pending.clear();
      this.emit("disconnected");
    });
    try {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          socket.destroy();
          reject(
            new DesktopError(
              "IPC_TIMEOUT",
              `Cannot connect to ${this.endpoint}; run the bridge as the same Windows user as Desktop`,
            ),
          );
        }, this.timeoutMs);
        socket.once("connect", () => {
          clearTimeout(timer);
          resolve();
        });
        socket.once("error", (error) => {
          clearTimeout(timer);
          reject(
            new DesktopError(
              error.code,
              `Cannot attach to ${this.endpoint} (${error.code}); check that Desktop is running under this Windows user`,
            ),
          );
        });
      });
      const reply = await this.request("initialize", {
        clientType: "codex-web-desktop-bridge",
      });
      if (typeof reply.result?.clientId !== "string")
        throw new DesktopError(
          "INITIALIZE",
          "Desktop returned no IPC client identity",
        );
      this.clientId = reply.result.clientId;
      this.emit("connected");
    } catch (error) {
      socket.destroy();
      throw error;
    }
  }
  version(method) {
    if (method === "initialize" || method === "client-status-changed")
      return this.versions[method] ?? 0;
    const version = this.versions[method];
    if (!Number.isInteger(version))
      throw new DesktopError(
        "HANDLER_UNAVAILABLE",
        `Installed Desktop has no IPC method version for ${method}`,
      );
    return version;
  }
  request(method, params, targetClientId) {
    const requestId = randomUUID();
    const message = {
      type: "request",
      requestId,
      sourceClientId: this.clientId ?? "initializing-client",
      version: this.version(method),
      method,
      params,
      ...(targetClientId ? { targetClientId } : {}),
    };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(
          new DesktopError(
            "IPC_TIMEOUT",
            `Desktop did not acknowledge ${method}; delivery is unknown`,
            true,
          ),
        );
      }, this.timeoutMs);
      this.pending.set(requestId, { resolve, reject, timer });
      try {
        this.write(message);
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(requestId);
        reject(error);
      }
    });
  }
  broadcast(method, params, targetClientIds) {
    this.write({
      type: "broadcast",
      method,
      params,
      sourceClientId: this.clientId,
      version: this.version(method),
      ...(targetClientIds ? { targetClientIds } : {}),
    });
  }
  write(message) {
    if (!this.socket?.writable || this.socket.writableLength > 8 * 1024 * 1024)
      throw new DesktopError(
        "IPC_UNAVAILABLE",
        "Desktop pipe is unavailable",
        true,
      );
    this.socket.write(encodeFrame(message));
  }
  receive(message) {
    if (message.type === "client-discovery-request") {
      // The bridge is never an owner or an execution runtime.
      this.write({
        type: "client-discovery-response",
        requestId: message.requestId,
        response: { canHandle: false },
      });
      return;
    }
    if (message.type === "request") {
      this.write({
        type: "response",
        requestId: message.requestId,
        resultType: "error",
        error: "no-handler-for-request",
      });
      return;
    }
    if (message.type === "response") {
      const p = this.pending.get(message.requestId);
      if (!p) return;
      clearTimeout(p.timer);
      this.pending.delete(message.requestId);
      if (message.resultType === "success") p.resolve(message);
      else
        p.reject(
          new DesktopError(
            "IPC_REJECTED",
            `Desktop ${message.error ?? "rejected the request"}`,
            !/^(no-client-found|no-handler-for-request|request-version-mismatch|not-initialized)$/.test(
              message.error ?? "",
            ),
          ),
        );
      return;
    }
    if (
      message.type === "broadcast" &&
      (!message.targetClientIds ||
        message.targetClientIds.includes(this.clientId))
    ) {
      if (message.version !== (this.versions[message.method] ?? 0)) {
        this.emit("versionMismatch", message.method);
        return;
      }
      this.emit("broadcast", message);
    }
  }
  close() {
    this.socket?.destroy();
  }
}
module.exports = { DesktopError, DesktopIpc, FrameReader, encodeFrame };
