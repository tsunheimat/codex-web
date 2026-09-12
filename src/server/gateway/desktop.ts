import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { WebSocket } from "ws";
import { type Backend } from "./config";
import { DeliveryUnknownError, RpcError } from "./connection";

const methods: Record<string, string> = {
  "thread/list": "desktop/list",
  "thread/resume": "desktop/attach",
  "thread/read": "desktop/read",
  "turn/start": "desktop/turn/start",
  "turn/steer": "desktop/turn/steer",
  "turn/interrupt": "desktop/turn/interrupt",
  "chatgpt/list": "desktop/chatgpt/list",
  "chatgpt/attach": "desktop/chatgpt/read",
  "chatgpt/read": "desktop/chatgpt/read",
  "chatgpt/send": "desktop/chatgpt/send",
  "attachment/upload": "desktop/upload",
};

/** A Desktop attachment, with no execution-runtime or process-launching code. */
export class DesktopConnection extends EventEmitter {
  epoch = "";
  connected = false;
  info: any = null;
  private socket: WebSocket | null = null;
  private pending = new Map<
    string,
    {
      resolve: (v: any) => void;
      reject: (e: Error) => void;
      timer: NodeJS.Timeout;
    }
  >();
  private closed = false;
  constructor(
    readonly backend: Backend,
    private timeoutMs = 45000,
  ) {
    super();
  }
  async connect(): Promise<void> {
    if (!this.connected || this.closed)
      throw Object.assign(
        new DeliveryUnknownError(
          "Windows Desktop bridge is unavailable; start codex-web-desktop-bridge on the Desktop host",
        ),
        { statusCode: 409 },
      );
  }
  attachDesktop(socket: WebSocket, info: any): void {
    if (this.closed) throw new Error("Gateway is shutting down");
    if (this.socket)
      throw new Error(
        "A Desktop bridge is already registered for this backend",
      );
    this.socket = socket;
    this.info = info;
    this.epoch = randomUUID();
    this.connected = true;
    const epoch = this.epoch;
    const disconnect = () => {
      if (this.epoch === epoch) this.disconnect();
    };
    socket.on("close", disconnect);
    socket.on("error", disconnect);
    socket.on("message", (raw, binary) => {
      if (this.epoch !== epoch || this.socket !== socket) return;
      try {
        if (binary) throw new Error("Unexpected binary frame");
        const message = JSON.parse(String(raw));
        if (message.id !== undefined && !message.method) {
          const p = this.pending.get(message.id);
          if (!p) return;
          clearTimeout(p.timer);
          this.pending.delete(message.id);
          if (message.error)
            p.reject(
              message.error.deliveryUnknown
                ? new DeliveryUnknownError(message.error.message)
                : new RpcError(message.error.message, -32000),
            );
          else p.resolve(message.result);
        } else if (message.method === "desktop/connection") {
          this.connected = message.params?.available === true;
          if (
            typeof message.params?.desktopVersion === "string" &&
            /^[\w.+-]{1,64}$/.test(message.params.desktopVersion)
          )
            this.info.desktop.version = message.params.desktopVersion;
          this.emit(this.connected ? "connected" : "disconnected", epoch);
        } else if (
          [
            "desktop/snapshot",
            "desktop/chatgpt/snapshot",
            "desktop/unavailable",
            "serverRequest/resolved",
          ].includes(message.method)
        ) {
          this.emit("notification", message);
        } else if (
          message.id !== undefined &&
          [
            "item/commandExecution/requestApproval",
            "item/fileChange/requestApproval",
            "item/tool/requestUserInput",
          ].includes(message.method)
        ) {
          this.emit("request", message, epoch);
        }
      } catch {
        socket.close(1008, "Invalid Desktop bridge frame");
      }
    });
    this.emit("connected", epoch);
  }
  async request(method: string, params: any, commandId?: string): Promise<any> {
    await this.connect();
    const mapped = methods[method];
    if (!mapped)
      throw new RpcError(
        method === "thread/start"
          ? "Desktop IPC exposes follower attachment to an existing conversation, not thread creation. Select an existing Desktop conversation."
          : `Desktop bridge does not expose ${method}`,
        -32601,
      );
    return this.rpc(mapped, params, commandId);
  }
  private rpc(method: string, params: any, commandId?: string): Promise<any> {
    const id = commandId ?? randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new DeliveryUnknownError(
            "Desktop acknowledgement timed out; reconcile before resubmitting",
          ),
        );
      }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.send({ id, method, params });
      } catch (error) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(error);
      }
    });
  }
  async respond(id: string | number, result: any): Promise<void> {
    await this.connect();
    await this.rpc("desktop/approval/respond", { requestId: id, result });
  }
  rejectRequest(_id: string | number): void {
    // An unsupported web approval remains owned by Desktop. Never decline it
    // just because a viewer has not attached or cannot render the request.
  }
  async control(): Promise<any> {
    throw new RpcError(
      "Desktop does not expose host filesystem or companion controls",
      -32601,
    );
  }
  private send(message: unknown): void {
    if (
      this.socket?.readyState !== WebSocket.OPEN ||
      this.socket.bufferedAmount > 8 * 1024 * 1024
    )
      throw new DeliveryUnknownError("Desktop bridge transport unavailable");
    const frame = JSON.stringify(message);
    if (Buffer.byteLength(frame) > 8 * 1024 * 1024)
      throw new RpcError(
        "Desktop request exceeds the 8 MiB transport limit",
        -32602,
      );
    this.socket.send(frame);
  }
  private disconnect(): void {
    if (!this.socket) return;
    this.socket = null;
    this.connected = false;
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(
        new DeliveryUnknownError(
          "Desktop bridge disconnected before acknowledgement",
        ),
      );
    }
    this.pending.clear();
    this.emit("disconnected", this.epoch);
  }
  close(): void {
    this.closed = true;
    const socket = this.socket;
    this.disconnect();
    socket?.close(1000);
  }
}
