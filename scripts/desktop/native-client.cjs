const net = require("node:net");
const fs = require("node:fs");
const { EventEmitter } = require("node:events");
const { randomUUID } = require("node:crypto");
const { FrameReader, encodeFrame, DesktopError } = require("./ipc.cjs");
const { BINDING_ID, FRAME_LIMIT, METHODS } = require("./native/contract.cjs");
function loadApprovedNativeConfig(filename) {
  const config = JSON.parse(fs.readFileSync(filename, "utf8"));
  if (
    config.enabled !== true ||
    config.bindingId !== BINDING_ID ||
    config.desktopVersion !== "26.908.40834" ||
    !/^[a-f0-9]{64}$/.test(config.planSha256 ?? "") ||
    !/^[a-f0-9]{64}$/.test(config.patchedArchiveSha256 ?? "") ||
    !/^\\\\\.\\pipe\\codex-web-native-[\da-f-]+$/.test(config.endpoint ?? "") ||
    typeof config.token !== "string" ||
    config.token.length < 32
  )
    throw new Error(
      "Native adapter configuration is not an approved version-pinned installation",
    );
  return config;
}
/** Persistent observer channel, entirely separate from the native helper socket. */
class NativeAdapterClient extends EventEmitter {
  constructor(
    config,
    contextThreadId,
    { timeoutMs = 30000, retryMs = 3000 } = {},
  ) {
    super();
    this.config = config;
    this.contextThreadId = contextThreadId;
    this.timeoutMs = timeoutMs;
    this.retryMs = retryMs;
    this.pending = new Map();
    this.subscriptions = new Map();
    this.connected = false;
    this.verified = false;
    this.capabilities = {};
    this.closed = false;
  }
  start() {
    if (!this.closed)
      void this.connect().catch((error) => {
        if (this.lastError !== error.message) {
          this.lastError = error.message;
          this.emit("diagnostic", error.message);
        }
        this.retry();
      });
  }
  retry() {
    if (this.closed || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.start();
    }, this.retryMs);
  }
  connect() {
    if (this.connected) return Promise.resolve();
    if (this.opening) return this.opening;
    this.opening = this.open().finally(() => {
      this.opening = null;
    });
    return this.opening;
  }
  async open() {
    const socket = net.createConnection(this.config.endpoint);
    this.socket = socket;
    const reader = new FrameReader((message) => {
      if (message.id) {
        const p = this.pending.get(message.id);
        if (!p) return;
        this.pending.delete(message.id);
        clearTimeout(p.timer);
        if (message.error)
          p.reject(
            new DesktopError(
              "NATIVE_OPERATION",
              message.error.message,
              message.error.deliveryUnknown === true,
            ),
          );
        else p.resolve(message.result);
      } else if (
        this.verified &&
        [
          "native/cu/state",
          "native/cu/capture",
          "native/capture/status",
        ].includes(message.event)
      )
        this.emit(message.event, message.data);
    }, FRAME_LIMIT);
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
      this.connected = false;
      this.verified = false;
      this.capabilities = {};
      for (const p of this.pending.values()) {
        clearTimeout(p.timer);
        p.reject(
          new DesktopError(
            "NATIVE_DISCONNECTED",
            "Native observer disconnected before acknowledgement; reconcile without replay",
            true,
          ),
        );
      }
      this.pending.clear();
      this.emit("status", false);
      this.retry();
    });
    try {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          socket.destroy();
          reject(new Error("Native adapter connection timed out"));
        }, 5000);
        socket.once("connect", () => {
          clearTimeout(timer);
          resolve();
        });
        socket.once("error", (e) => {
          clearTimeout(timer);
          reject(e);
        });
      });
      const hello = await this.rpc("native/hello", {
        token: this.config.token,
        bindingId: BINDING_ID,
        planSha256: this.config.planSha256,
        contextThreadId: this.contextThreadId,
      });
      if (
        hello?.bindingId !== BINDING_ID ||
        hello.desktopVersion !== this.config.desktopVersion ||
        hello.planSha256 !== this.config.planSha256 ||
        hello.patchedArchiveSha256 !== this.config.patchedArchiveSha256
      )
        throw new Error(
          "Running native adapter does not match the approved installation",
        );
      this.connected = true;
      this.verified = true;
      this.capabilities = hello;
      this.emit("status", true);
      this.lastError = null;
      for (const status of hello.captureStatuses ?? [])
        this.emit("native/capture/status", status);
      for (const previous of this.subscriptions.values()) {
        try {
          const state = await this.request("native/cu/sync", {
            ownerId: previous.ownerId,
            turnId: previous.turnId,
          });
          this.emit("native/cu/state", state);
        } catch {
          this.emit("native/cu/state", {
            ...previous,
            status: "owner-lost",
            approvals: [],
          });
        }
      }
    } catch (error) {
      socket.destroy();
      throw error;
    }
  }
  async request(method, params) {
    if (!this.verified || !this.connected)
      throw new DesktopError(
        "NATIVE_DISABLED",
        "Native integration awaits the approved Desktop adapter installation or reconnection",
      );
    if (!METHODS.has(method))
      throw new DesktopError(
        "NATIVE_METHOD",
        "Native operation is not exposed",
      );
    const result = await this.rpc(method, params);
    if (method === "native/cu/attach")
      this.subscriptions.set(result.ownerId, result);
    return result;
  }
  rpc(method, params) {
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new DesktopError(
            "NATIVE_TIMEOUT",
            "Native acknowledgement timed out; reconcile the operation",
            true,
          ),
        );
      }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        if (!this.socket?.writable)
          throw new Error("Native observer is disconnected");
        this.socket.write(encodeFrame({ id, method, params }, FRAME_LIMIT));
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
  }
  close() {
    this.closed = true;
    clearTimeout(this.timer);
    this.socket?.destroy();
  }
}
module.exports = { NativeAdapterClient, loadApprovedNativeConfig };
