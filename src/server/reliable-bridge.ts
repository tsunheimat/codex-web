import { WebSocket, type RawData } from "ws";

export const RELIABLE_BRIDGE_PROTOCOL_VERSION = 2;

const DEFAULT_GRACE_TIME_MS = 5 * 60 * 1_000;
const DEFAULT_MAX_UNACKED_BYTES = 64 * 1024 * 1_024;
const DEFAULT_MAX_IN_FLIGHT_BYTES = 256 * 1024;
const KEEPALIVE_INTERVAL_MS = 5_000;
const SOCKET_TIMEOUT_MS = 20_000;

export type ReliableBridgeHello = {
  type: "bridge-hello";
  protocolVersion: number;
  connectionId: string;
  serverEpoch: string | null;
};

type ReliableBridgeClientFrame<T> =
  | { type: "bridge-data"; id: number; ack: number; message: T }
  | { type: "bridge-ack"; ack: number }
  | { type: "bridge-replay-request"; ack: number }
  | { type: "bridge-keepalive" }
  | { type: "bridge-disconnect" };

type OutgoingMessage<T> = {
  id: number;
  message: T;
  byteLength: number;
};

type ReliableBridgeSessionOptions<TIncoming> = {
  connectionId: string;
  serverEpoch: string;
  graceTimeMs?: number;
  maxUnackedBytes?: number;
  maxInFlightBytes?: number;
  onDispose: (reason: string) => void;
  onMessage: (message: TIncoming) => void;
};

/**
 * An in-memory, page-scoped reliable transport. It preserves ordered messages
 * across transient socket replacement, but intentionally provides no durable
 * recovery across renderer reloads, browser close/reopen, or server restart.
 */
export class ReliableBridgeSession<TIncoming, TOutgoing> {
  readonly connectionId: string;
  readonly serverEpoch: string;

  private readonly graceTimeMs: number;
  private readonly maxUnackedBytes: number;
  private readonly maxInFlightBytes: number;
  private readonly onDispose: (reason: string) => void;
  private readonly onMessage: (message: TIncoming) => void;
  private socket: WebSocket | null = null;
  private outgoingMessageId = 0;
  private outgoingAckId = 0;
  private outgoingSentId = 0;
  private outgoingUnackedBytes = 0;
  private outgoingUnacked: OutgoingMessage<TOutgoing>[] = [];
  private incomingMessageId = 0;
  private disposed = false;
  private graceTimer: NodeJS.Timeout | null = null;
  private keepaliveTimer: NodeJS.Timeout | null = null;
  private lastIncomingAt = Date.now();

  constructor(options: ReliableBridgeSessionOptions<TIncoming>) {
    this.connectionId = options.connectionId;
    this.serverEpoch = options.serverEpoch;
    this.graceTimeMs = options.graceTimeMs ?? DEFAULT_GRACE_TIME_MS;
    this.maxUnackedBytes = options.maxUnackedBytes ?? DEFAULT_MAX_UNACKED_BYTES;
    this.maxInFlightBytes =
      options.maxInFlightBytes ?? DEFAULT_MAX_IN_FLIGHT_BYTES;
    this.onDispose = options.onDispose;
    this.onMessage = options.onMessage;
  }

  attach(socket: WebSocket): void {
    if (this.disposed) {
      socket.close(1012, "bridge session disposed");
      return;
    }

    this.clearGraceTimer();
    this.replaceSocket(socket);
    this.lastIncomingAt = Date.now();
    socket.on("message", this.handleSocketMessage);
    socket.on("close", this.handleSocketClose);
    socket.on("error", this.handleSocketError);

    this.write({
      type: "bridge-ready",
      connectionId: this.connectionId,
      serverEpoch: this.serverEpoch,
    });
    this.writeAck();
    this.outgoingSentId = this.outgoingAckId;
    this.pumpOutgoing();
    this.startKeepalive();
  }

  send(message: TOutgoing): void {
    if (this.disposed) {
      return;
    }

    const byteLength = Buffer.byteLength(JSON.stringify(message));
    this.outgoingUnacked.push({
      id: ++this.outgoingMessageId,
      message,
      byteLength,
    });
    this.outgoingUnackedBytes += byteLength;
    if (this.outgoingUnackedBytes > this.maxUnackedBytes) {
      this.reset("reliable bridge buffer exceeded");
      return;
    }
    this.pumpOutgoing();
  }

  dispose(reason: string): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.clearGraceTimer();
    this.stopKeepalive();
    const socket = this.socket;
    this.socket = null;
    this.removeSocketListeners(socket);
    socket?.close(1000, reason);
    this.outgoingUnacked = [];
    this.outgoingUnackedBytes = 0;
    this.onDispose(reason);
  }

  private readonly handleSocketMessage = (rawData: RawData): void => {
    this.lastIncomingAt = Date.now();
    let frame: ReliableBridgeClientFrame<TIncoming>;
    try {
      frame = JSON.parse(
        String(rawData),
      ) as ReliableBridgeClientFrame<TIncoming>;
    } catch {
      this.reset("invalid reliable bridge frame");
      return;
    }
    if (!frame || typeof frame !== "object" || !("type" in frame)) {
      this.reset("invalid reliable bridge frame");
      return;
    }

    if (frame.type === "bridge-data") {
      if (this.acceptAck(frame.ack)) {
        this.acceptMessage(frame);
      }
      return;
    }
    if (frame.type === "bridge-ack") {
      this.acceptAck(frame.ack);
      return;
    }
    if (frame.type === "bridge-replay-request") {
      if (this.acceptAck(frame.ack, false)) {
        this.outgoingSentId = frame.ack;
        this.pumpOutgoing();
      }
      return;
    }
    if (frame.type === "bridge-disconnect") {
      this.dispose("client disconnected");
      return;
    }
    if (frame.type !== "bridge-keepalive") {
      this.reset("unsupported reliable bridge frame");
    }
  };

  private readonly handleSocketClose = (): void => {
    const socket = this.socket;
    if (!socket) {
      return;
    }
    this.socket = null;
    this.removeSocketListeners(socket);
    this.stopKeepalive();
    this.graceTimer = setTimeout(() => {
      this.dispose("reconnection grace period expired");
    }, this.graceTimeMs);
    this.graceTimer.unref?.();
  };

  private readonly handleSocketError = (): void => {
    this.socket?.terminate();
  };

  private acceptMessage(
    frame: Extract<
      ReliableBridgeClientFrame<TIncoming>,
      { type: "bridge-data" }
    >,
  ): void {
    if (!Number.isSafeInteger(frame.id) || frame.id <= 0) {
      this.reset("invalid reliable bridge message id");
      return;
    }
    if (frame.id === this.incomingMessageId + 1) {
      this.incomingMessageId = frame.id;
      try {
        this.onMessage(frame.message);
      } catch {
        this.reset("reliable bridge message handler failed");
        return;
      }
      this.writeAck();
      return;
    }
    if (frame.id <= this.incomingMessageId) {
      this.writeAck();
      return;
    }
    this.write({ type: "bridge-replay-request", ack: this.incomingMessageId });
  }

  private acceptAck(ack: number, pump = true): boolean {
    if (!Number.isSafeInteger(ack) || ack < 0 || ack > this.outgoingMessageId) {
      this.reset("invalid reliable bridge acknowledgement");
      return false;
    }
    if (ack <= this.outgoingAckId) {
      return true;
    }

    this.outgoingAckId = ack;
    const acknowledged = this.outgoingUnacked.filter(
      (message) => message.id <= ack,
    );
    this.outgoingUnackedBytes -= acknowledged.reduce(
      (total, message) => total + message.byteLength,
      0,
    );
    this.outgoingUnacked = this.outgoingUnacked.filter(
      (message) => message.id > ack,
    );
    if (pump) {
      this.pumpOutgoing();
    }
    return true;
  }

  private pumpOutgoing(): void {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      return;
    }
    let inFlightBytes = this.outgoingUnacked
      .filter((message) => message.id <= this.outgoingSentId)
      .reduce((total, message) => total + message.byteLength, 0);
    for (const message of this.outgoingUnacked) {
      if (message.id <= this.outgoingSentId) {
        continue;
      }
      if (
        inFlightBytes > 0 &&
        inFlightBytes + message.byteLength > this.maxInFlightBytes
      ) {
        break;
      }
      this.writeData(message);
      this.outgoingSentId = message.id;
      inFlightBytes += message.byteLength;
    }
  }

  private writeData(message: OutgoingMessage<TOutgoing>): void {
    this.write({
      type: "bridge-data",
      id: message.id,
      ack: this.incomingMessageId,
      message: message.message,
    });
  }

  private writeAck(): void {
    this.write({ type: "bridge-ack", ack: this.incomingMessageId });
  }

  private write(frame: object): void {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      return;
    }
    try {
      this.socket.send(JSON.stringify(frame));
    } catch {
      this.socket.terminate();
    }
  }

  private reset(reason: string): void {
    this.write({ type: "bridge-reset", reason });
    this.dispose(reason);
  }

  private replaceSocket(socket: WebSocket): void {
    const previousSocket = this.socket;
    this.socket = socket;
    if (!previousSocket || previousSocket === socket) {
      return;
    }
    this.removeSocketListeners(previousSocket);
    previousSocket.terminate();
  }

  private removeSocketListeners(socket: WebSocket | null): void {
    socket?.off("message", this.handleSocketMessage);
    socket?.off("close", this.handleSocketClose);
    socket?.off("error", this.handleSocketError);
  }

  private startKeepalive(): void {
    this.stopKeepalive();
    this.keepaliveTimer = setInterval(() => {
      if (Date.now() - this.lastIncomingAt > SOCKET_TIMEOUT_MS) {
        this.socket?.terminate();
        return;
      }
      this.write({ type: "bridge-keepalive" });
    }, KEEPALIVE_INTERVAL_MS);
    this.keepaliveTimer.unref?.();
  }

  private stopKeepalive(): void {
    if (this.keepaliveTimer) {
      clearInterval(this.keepaliveTimer);
      this.keepaliveTimer = null;
    }
  }

  private clearGraceTimer(): void {
    if (this.graceTimer) {
      clearTimeout(this.graceTimer);
      this.graceTimer = null;
    }
  }
}

export function parseReliableBridgeHello(
  value: unknown,
): ReliableBridgeHello | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const hello = value as Partial<ReliableBridgeHello>;
  if (
    hello.type !== "bridge-hello" ||
    hello.protocolVersion !== RELIABLE_BRIDGE_PROTOCOL_VERSION ||
    typeof hello.connectionId !== "string" ||
    hello.connectionId.length === 0 ||
    hello.connectionId.length > 128 ||
    (hello.serverEpoch !== null && typeof hello.serverEpoch !== "string")
  ) {
    return null;
  }
  return hello as ReliableBridgeHello;
}
