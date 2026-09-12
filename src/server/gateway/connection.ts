import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { Duplex } from "node:stream";
import { WebSocket } from "ws";
import { shellQuote, sshArguments, type Backend } from "./config";

export class RpcError extends Error {
  constructor(
    message: string,
    readonly code: number,
  ) {
    super(message);
  }
}
export class DeliveryUnknownError extends Error {}
type Pending = {
  resolve: (value: any) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
};
type PendingControl = {
  resolve: (value: any) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
};
const MAX_MESSAGE_BYTES = 8 * 1024 * 1024;

/** One connection per configured backend, never per viewer. No RPC is replayed. */
export class AppServerConnection extends EventEmitter {
  epoch = "";
  connected = false;
  private opening: Promise<void> | null = null;
  private closed = false;
  private sendFrame: ((message: string) => void) | null = null;
  private shutdownTransport: (() => void) | null = null;
  private pending = new Map<string, Pending>();
  private pendingControls = new Map<string, PendingControl>();
  constructor(
    readonly backend: Backend,
    private readonly timeoutMs = 30_000,
  ) {
    super();
  }

  connect(): Promise<void> {
    if (this.closed)
      return Promise.reject(
        new DeliveryUnknownError("Connection owner has shut down"),
      );
    if (this.connected) return Promise.resolve();
    if (
      this.backend.transport.type === "companion" ||
      this.backend.transport.type === "desktop"
    )
      return Promise.reject(
        new DeliveryUnknownError("Execution companion is not connected"),
      );
    if (this.opening) return this.opening;
    this.opening = this.open().finally(() => {
      this.opening = null;
    });
    return this.opening;
  }

  private async open(): Promise<void> {
    this.epoch = randomUUID();
    const epoch = this.epoch;
    const t = this.backend.transport;
    const fail = () => {
      if (this.epoch === epoch) this.disconnect();
    };
    try {
      if (t.type === "stdio" || t.type === "ssh") {
        const child =
          t.type === "stdio"
            ? spawn(t.command, t.args, { cwd: this.backend.cwd, stdio: "pipe" })
            : spawn(
                "ssh",
                [
                  ...sshArguments(t.ssh),
                  "-T",
                  t.ssh.host,
                  `cd ${shellQuote(this.backend.cwd)} && exec ${[t.command, ...t.args].map(shellQuote).join(" ")}`,
                ],
                { stdio: "pipe" },
              );
        this.bindChild(child, fail);
        let buffer = Buffer.alloc(0);
        child.stdout.on("data", (chunk: Buffer) => {
          buffer = Buffer.concat([buffer, chunk]);
          let end: number;
          while ((end = buffer.indexOf(10)) >= 0) {
            const frame = buffer.subarray(0, end);
            buffer = buffer.subarray(end + 1);
            if (frame.length > MAX_MESSAGE_BYTES) {
              fail();
              return;
            }
            if (frame.length) this.receive(frame.toString(), epoch);
          }
          if (buffer.length > MAX_MESSAGE_BYTES) fail();
        });
        this.sendFrame = (frame) => {
          if (
            !child.stdin.writable ||
            child.stdin.writableLength > MAX_MESSAGE_BYTES
          )
            throw new DeliveryUnknownError("Runtime input unavailable");
          child.stdin.write(frame + "\n", (error) => {
            if (error) fail();
          });
        };
        this.shutdownTransport = () => {
          child.stdin.end();
          child.kill("SIGTERM");
          const timer = setTimeout(() => {
            if (child.exitCode === null) child.kill("SIGKILL");
          }, 3000);
          timer.unref();
        };
      } else {
        let child: ChildProcessWithoutNullStreams | null = null;
        const tokenEnv = "tokenEnv" in t ? t.tokenEnv : undefined;
        const token = tokenEnv ? process.env[tokenEnv] : undefined;
        if (tokenEnv && !token)
          throw new Error(
            `Missing upstream credential environment variable: ${tokenEnv}`,
          );
        const options: any = {
          maxPayload: MAX_MESSAGE_BYTES,
          handshakeTimeout: 15_000,
          perMessageDeflate: false,
          followRedirects: false,
          ...(token ? { headers: { Authorization: `Bearer ${token}` } } : {}),
        };
        let url: string;
        if (t.type === "unix") {
          if (t.socketPath.includes(":"))
            throw new Error("Unix socket paths cannot contain a colon");
          url = `ws+unix://${t.socketPath}:/`;
        } else if (t.type === "ssh-websocket") {
          url = `ws://${t.host}:${t.port}/`;
          child = spawn(
            "ssh",
            [
              ...sshArguments(t.ssh),
              "-T",
              "-W",
              `${t.host}:${t.port}`,
              t.ssh.host,
            ],
            { stdio: "pipe" },
          );
          this.bindChild(child, fail);
          const tunnel = child;
          const stream = new Duplex({
            read() {
              tunnel.stdout.resume();
            },
            write(chunk, encoding, callback) {
              tunnel.stdin.write(chunk, encoding, callback);
            },
            final(callback) {
              tunnel.stdin.end(callback);
            },
            destroy(error, callback) {
              tunnel.kill("SIGTERM");
              callback(error);
            },
          });
          tunnel.stdout.on("data", (chunk) => {
            if (!stream.push(chunk)) tunnel.stdout.pause();
          });
          tunnel.stdout.on("end", () => stream.push(null));
          stream.on("error", fail);
          options.createConnection = () => stream;
        } else if (t.type === "websocket") {
          url = t.url;
        } else {
          throw new DeliveryUnknownError(
            "Companion must connect through the agent endpoint",
          );
        }
        const socket = new WebSocket(url, options);
        socket.on("message", (data, binary) => {
          if (binary) fail();
          else this.receive(String(data), epoch);
        });
        socket.on("close", fail);
        socket.on("error", fail);
        let alive = true;
        socket.on("pong", () => {
          alive = true;
        });
        const heartbeat = setInterval(() => {
          if (socket.readyState !== WebSocket.OPEN) return;
          if (!alive) {
            fail();
            return;
          }
          alive = false;
          socket.ping();
        }, 15_000);
        heartbeat.unref();
        this.shutdownTransport = () => {
          clearInterval(heartbeat);
          socket.terminate();
          child?.kill("SIGTERM");
        };
        this.sendFrame = (frame) => {
          if (
            socket.readyState !== WebSocket.OPEN ||
            socket.bufferedAmount > MAX_MESSAGE_BYTES
          )
            throw new DeliveryUnknownError("Runtime socket unavailable");
          socket.send(frame, (error) => {
            if (error) fail();
          });
        };
        await new Promise<void>((resolve, reject) => {
          socket.once("open", resolve);
          socket.once("error", () =>
            reject(new Error("Could not connect to configured backend")),
          );
          socket.once("close", () =>
            reject(new Error("Backend closed during connection")),
          );
        });
      }
      await this.initialize(epoch);
    } catch (error) {
      fail();
      throw error;
    }
  }

  private async initialize(epoch: string): Promise<void> {
    await this.rpc("initialize", {
      clientInfo: {
        name: "codex_web_gateway",
        title: "Codex Web Gateway",
        version: "1.0.0",
      },
      capabilities: {
        experimentalApi: true,
        requestAttestation: false,
      },
    });
    this.send({ method: "initialized" });
    this.connected = true;
    this.emit("connected", epoch);
  }

  /** Attach a target-side companion's already-open WebSocket transport. */
  async attachCompanion(socket: WebSocket, initialize = true): Promise<void> {
    if (this.backend.transport.type !== "companion")
      throw new Error("Backend is not configured for a companion");
    if (this.closed) {
      socket.close(1001, "Gateway is shutting down");
      throw new DeliveryUnknownError("Connection owner has shut down");
    }
    this.disconnect();
    this.epoch = randomUUID();
    const epoch = this.epoch;
    const fail = () => {
      if (this.epoch === epoch) this.disconnect();
    };
    socket.on("message", (data, binary) => {
      if (binary) fail();
      else this.receive(String(data), epoch);
    });
    socket.on("close", fail);
    socket.on("error", fail);
    this.sendFrame = (frame) => {
      if (socket.readyState !== WebSocket.OPEN)
        throw new DeliveryUnknownError("Companion socket unavailable");
      socket.send(frame, (error) => {
        if (error) fail();
      });
    };
    this.shutdownTransport = () => {
      if (socket.readyState === WebSocket.OPEN) socket.close(1000);
      else socket.terminate();
    };
    try {
      if (initialize) await this.initialize(epoch);
      else {
        this.connected = true;
        this.emit("connected", epoch);
      }
    } catch (error) {
      fail();
      throw error;
    }
  }

  private bindChild(
    child: ChildProcessWithoutNullStreams,
    fail: () => void,
  ): void {
    // Drain stderr without logging account details, signed URLs or credentials.
    child.stderr.resume();
    child.stdin.on("error", fail);
    child.on("error", fail);
    child.on("exit", fail);
  }

  async request(method: string, params: unknown): Promise<any> {
    await this.connect();
    return this.rpc(method, params);
  }

  async control(action: string, params: Record<string, unknown>): Promise<any> {
    if (this.backend.transport.type !== "companion")
      throw new DeliveryUnknownError(
        "Backend has no companion control channel",
      );
    await this.connect();
    const requestId = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingControls.delete(requestId);
        reject(new DeliveryUnknownError("Companion control request timed out"));
      }, this.timeoutMs);
      timer.unref();
      this.pendingControls.set(requestId, { resolve, reject, timer });
      try {
        this.send({
          type: "companion-control",
          requestId,
          action,
          ...params,
        });
      } catch (error) {
        clearTimeout(timer);
        this.pendingControls.delete(requestId);
        reject(error);
      }
    });
  }

  private rpc(method: string, params: unknown): Promise<any> {
    if (this.pending.size >= 128)
      return Promise.reject(new Error("Backend request capacity exceeded"));
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new DeliveryUnknownError(
            "Runtime acknowledgement timed out; reconcile before taking further action",
          ),
        );
      }, this.timeoutMs);
      timer.unref();
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.send({ id, method, params });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  respond(id: string | number, result: unknown): void {
    this.send({ id, result });
  }
  rejectRequest(id: string | number): void {
    this.send({
      id,
      error: { code: -32601, message: "Client capability unavailable" },
    });
  }

  private send(message: unknown): void {
    if (!this.sendFrame) throw new DeliveryUnknownError("Runtime disconnected");
    const frame = JSON.stringify(message);
    if (Buffer.byteLength(frame) > MAX_MESSAGE_BYTES)
      throw new Error("Runtime message too large");
    this.sendFrame(frame);
  }

  private receive(raw: string, epoch: string): void {
    if (epoch !== this.epoch || !this.sendFrame) return;
    let message: any;
    try {
      message = JSON.parse(raw);
    } catch {
      this.disconnect();
      return;
    }
    if (!message || typeof message !== "object" || Array.isArray(message)) {
      this.disconnect();
      return;
    }
    if (message.type === "companion-result") {
      const pending = this.pendingControls.get(message.requestId);
      if (!pending) return;
      this.pendingControls.delete(message.requestId);
      clearTimeout(pending.timer);
      if (message.error) pending.reject(new Error(String(message.error)));
      else pending.resolve(message.result);
      return;
    }
    if (message.id !== undefined && typeof message.method !== "string") {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error)
        pending.reject(
          new RpcError(
            String(message.error.message ?? "Runtime rejected request"),
            message.error.code,
          ),
        );
      else if ("result" in message) pending.resolve(message.result);
      else
        pending.reject(
          new DeliveryUnknownError("Malformed runtime acknowledgement"),
        );
    } else if (typeof message.method === "string") {
      this.emit(
        message.id === undefined ? "notification" : "request",
        message,
        epoch,
      );
    }
  }

  close(): void {
    this.closed = true;
    this.disconnect();
  }
  private disconnect(): void {
    if (!this.sendFrame && !this.shutdownTransport) return;
    this.connected = false;
    this.sendFrame = null;
    const shutdown = this.shutdownTransport;
    this.shutdownTransport = null;
    shutdown?.();
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(
        new DeliveryUnknownError("Runtime disconnected before acknowledgement"),
      );
    }
    this.pending.clear();
    for (const p of this.pendingControls.values()) {
      clearTimeout(p.timer);
      p.reject(new DeliveryUnknownError("Companion disconnected"));
    }
    this.pendingControls.clear();
    this.emit("disconnected", this.epoch);
  }
}
