type RuntimeTurnLifecycle = {
  method: "turn/started" | "turn/completed";
  threadId: string;
  turnId: string;
};

export type RendererBridgeReady = {
  type: "renderer-bridge-ready";
  currentThreadId: string | null;
  recoveryReason: RendererRecoveryReason;
};

type RendererRecoveryCoordinatorOptions<TMessage> = {
  broadcast: (message: TMessage) => void;
  recover: (connectionId: string) => void;
  readThread: (threadId: string) => Promise<ReadonlySet<string>>;
  retryDelayMs?: number;
  maximumWaitMs?: number;
  setTimeout?: typeof setTimeout;
  clearTimeout?: typeof clearTimeout;
};

const MAX_THREAD_ID_LENGTH = 128;

export function isValidRendererThreadId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_THREAD_ID_LENGTH &&
    !/[\u0000-\u001f\u007f/?#]/.test(value)
  );
}

export function parseRendererBridgeReady(
  value: unknown,
): RendererBridgeReady | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const ready = value as Partial<RendererBridgeReady>;
  if (
    ready.type !== "renderer-bridge-ready" ||
    (ready.currentThreadId !== null &&
      !isValidRendererThreadId(ready.currentThreadId)) ||
    (ready.recoveryReason !== undefined &&
      ready.recoveryReason !== null &&
      ready.recoveryReason !== BACKEND_RESTART_RECOVERY_REASON)
  ) {
    return null;
  }
  return {
    type: "renderer-bridge-ready",
    currentThreadId: ready.currentThreadId,
    recoveryReason:
      ready.recoveryReason === BACKEND_RESTART_RECOVERY_REASON
        ? BACKEND_RESTART_RECOVERY_REASON
        : null,
  };
}

function runtimeTurnLifecycle(value: unknown): RuntimeTurnLifecycle | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const message = value as {
    type?: unknown;
    channel?: unknown;
    args?: unknown[];
  };
  if (
    message.type !== "ipc-main-event" ||
    message.channel !== "codex_desktop:message-for-view"
  ) {
    return null;
  }
  const notification = message.args?.[0] as
    | {
        method?: unknown;
        params?: { threadId?: unknown; turn?: { id?: unknown } };
        type?: unknown;
      }
    | undefined;
  if (
    notification?.type !== "mcp-notification" ||
    (notification.method !== "turn/started" &&
      notification.method !== "turn/completed") ||
    typeof notification.params?.threadId !== "string" ||
    typeof notification.params.turn?.id !== "string"
  ) {
    return null;
  }
  return {
    method: notification.method,
    threadId: notification.params.threadId,
    turnId: notification.params.turn.id,
  };
}

/**
 * Tracks renderer history-recovery timing without owning app-server history.
 * Active turns and pending recovery are process-local and scoped by the
 * renderer's canonical current thread.
 */
export class RendererRecoveryCoordinator<TMessage> {
  private readonly broadcast: (message: TMessage) => void;
  private readonly recover: (connectionId: string) => void;
  private readonly readThread: (
    threadId: string,
  ) => Promise<ReadonlySet<string>>;
  private readonly retryDelayMs: number;
  private readonly maximumWaitMs: number;
  private readonly setTimeoutImpl: typeof setTimeout;
  private readonly clearTimeoutImpl: typeof clearTimeout;
  private readonly activeTurnsByThread = new Map<string, Set<string>>();
  private readonly readySessions = new Set<string>();
  private readonly waitingSessions = new Map<
    string,
    {
      threadId: string;
      turnIds: Set<string>;
      capturedTurnIds: Set<string>;
      retryTimer: ReturnType<typeof setTimeout> | null;
      deadlineTimer: ReturnType<typeof setTimeout>;
      readInFlight: boolean;
    }
  >();
  private hasAcceptedReadySession = false;
  private disposed = false;

  constructor(options: RendererRecoveryCoordinatorOptions<TMessage>) {
    this.broadcast = options.broadcast;
    this.recover = options.recover;
    this.readThread = options.readThread;
    this.retryDelayMs = options.retryDelayMs ?? 1_000;
    this.maximumWaitMs = options.maximumWaitMs ?? 15_000;
    this.setTimeoutImpl = options.setTimeout ?? setTimeout;
    this.clearTimeoutImpl = options.clearTimeout ?? clearTimeout;
    if (
      !Number.isFinite(this.retryDelayMs) ||
      this.retryDelayMs < 0 ||
      !Number.isFinite(this.maximumWaitMs) ||
      this.maximumWaitMs <= 0
    ) {
      throw new Error("invalid renderer recovery timing");
    }
  }

  get readySessionCount(): number {
    return this.readySessions.size;
  }

  get waitingSessionCount(): number {
    return this.waitingSessions.size;
  }

  acceptRendererReady(
    connectionId: string,
    currentThreadId: string | null,
    recoveryReason: RendererRecoveryReason = null,
  ): void {
    if (this.disposed || this.readySessions.has(connectionId)) {
      return;
    }
    this.readySessions.add(connectionId);
    if (recoveryReason === BACKEND_RESTART_RECOVERY_REASON) {
      this.hasAcceptedReadySession = true;
      this.recover(connectionId);
      return;
    }
    if (!this.hasAcceptedReadySession) {
      this.hasAcceptedReadySession = true;
      return;
    }
    if (currentThreadId === null) {
      this.recover(connectionId);
      return;
    }
    const activeTurns = this.activeTurnsByThread.get(currentThreadId);
    if (!activeTurns || activeTurns.size === 0) {
      this.recover(connectionId);
      return;
    }
    const waiting = {
      threadId: currentThreadId,
      turnIds: new Set(activeTurns),
      capturedTurnIds: new Set(activeTurns),
      retryTimer: null,
      deadlineTimer: this.setTimeoutImpl(
        () => this.releaseWaitingSession(connectionId, waiting),
        this.maximumWaitMs,
      ),
      readInFlight: false,
    };
    waiting.deadlineTimer.unref?.();
    this.waitingSessions.set(connectionId, waiting);
    this.reconcileWaitingSession(connectionId, waiting);
  }

  disposeRenderer(connectionId: string): void {
    this.readySessions.delete(connectionId);
    const waiting = this.waitingSessions.get(connectionId);
    if (waiting) {
      this.cancelWaitingSession(connectionId, waiting);
    }
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    for (const [connectionId, waiting] of this.waitingSessions) {
      this.cancelWaitingSession(connectionId, waiting);
    }
    this.readySessions.clear();
  }

  broadcastRuntimeMessage(message: TMessage): void {
    const lifecycle = runtimeTurnLifecycle(message);
    if (lifecycle?.method === "turn/started") {
      this.recordTurnStarted(lifecycle.threadId, lifecycle.turnId);
    }

    // The authoritative app-server event must enter every renderer queue
    // before completing that turn can release synthetic history recovery.
    this.broadcast(message);

    if (lifecycle?.method === "turn/completed") {
      this.recordTurnCompleted(lifecycle.threadId, lifecycle.turnId);
    }
  }

  private recordTurnStarted(threadId: string, turnId: string): void {
    const activeTurns = this.activeTurnsByThread.get(threadId) ?? new Set();
    activeTurns.add(turnId);
    this.activeTurnsByThread.set(threadId, activeTurns);

    for (const waiting of this.waitingSessions.values()) {
      if (waiting.threadId === threadId) {
        waiting.turnIds.add(turnId);
      }
    }
  }

  private recordTurnCompleted(threadId: string, turnId: string): void {
    const activeTurns = this.activeTurnsByThread.get(threadId);
    activeTurns?.delete(turnId);
    if (activeTurns?.size === 0) {
      this.activeTurnsByThread.delete(threadId);
    }

    for (const [connectionId, waiting] of this.waitingSessions) {
      if (waiting.threadId !== threadId) {
        continue;
      }
      waiting.turnIds.delete(turnId);
      waiting.capturedTurnIds.delete(turnId);
      if (waiting.turnIds.size !== 0) {
        continue;
      }
      this.releaseWaitingSession(connectionId, waiting);
    }
  }

  private reconcileWaitingSession(
    connectionId: string,
    waiting: {
      threadId: string;
      turnIds: Set<string>;
      capturedTurnIds: Set<string>;
      retryTimer: ReturnType<typeof setTimeout> | null;
      deadlineTimer: ReturnType<typeof setTimeout>;
      readInFlight: boolean;
    },
  ): void {
    if (
      this.disposed ||
      waiting.readInFlight ||
      this.waitingSessions.get(connectionId) !== waiting
    ) {
      return;
    }
    waiting.readInFlight = true;
    Promise.resolve()
      .then(() => this.readThread(waiting.threadId))
      .then((inProgressTurnIds) => {
        if (
          this.disposed ||
          this.waitingSessions.get(connectionId) !== waiting
        ) {
          return;
        }
        for (const turnId of waiting.capturedTurnIds) {
          if (inProgressTurnIds.has(turnId)) {
            continue;
          }
          waiting.capturedTurnIds.delete(turnId);
          waiting.turnIds.delete(turnId);
          this.removeActiveTurn(waiting.threadId, turnId);
        }
        if (waiting.turnIds.size === 0) {
          this.releaseWaitingSession(connectionId, waiting);
        }
      })
      .catch(() => undefined)
      .finally(() => {
        if (
          this.disposed ||
          this.waitingSessions.get(connectionId) !== waiting
        ) {
          return;
        }
        waiting.readInFlight = false;
        waiting.retryTimer = this.setTimeoutImpl(() => {
          waiting.retryTimer = null;
          this.reconcileWaitingSession(connectionId, waiting);
        }, this.retryDelayMs);
        waiting.retryTimer.unref?.();
      });
  }

  private removeActiveTurn(threadId: string, turnId: string): void {
    const activeTurns = this.activeTurnsByThread.get(threadId);
    activeTurns?.delete(turnId);
    if (activeTurns?.size === 0) {
      this.activeTurnsByThread.delete(threadId);
    }
  }

  private cancelWaitingSession(
    connectionId: string,
    waiting: {
      retryTimer: ReturnType<typeof setTimeout> | null;
      deadlineTimer: ReturnType<typeof setTimeout>;
    },
  ): void {
    if (this.waitingSessions.get(connectionId) !== waiting) {
      return;
    }
    this.waitingSessions.delete(connectionId);
    this.clearTimeoutImpl(waiting.deadlineTimer);
    if (waiting.retryTimer !== null) {
      this.clearTimeoutImpl(waiting.retryTimer);
      waiting.retryTimer = null;
    }
  }

  private releaseWaitingSession(
    connectionId: string,
    waiting: {
      retryTimer: ReturnType<typeof setTimeout> | null;
      deadlineTimer: ReturnType<typeof setTimeout>;
    },
  ): void {
    if (this.waitingSessions.get(connectionId) !== waiting) {
      return;
    }
    this.cancelWaitingSession(connectionId, waiting);
    if (!this.disposed && this.readySessions.has(connectionId)) {
      this.recover(connectionId);
    }
  }
}
import {
  BACKEND_RESTART_RECOVERY_REASON,
  type RendererRecoveryReason,
} from "./restart-recovery-marker";
