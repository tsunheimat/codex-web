type RuntimeTurnLifecycle = {
  method: "turn/started" | "turn/completed";
  threadId: string;
  turnId: string;
};

export type RendererBridgeReady = {
  type: "renderer-bridge-ready";
  currentThreadId: string | null;
};

type RendererRecoveryCoordinatorOptions<TMessage> = {
  broadcast: (message: TMessage) => void;
  recover: (connectionId: string) => void;
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
      !isValidRendererThreadId(ready.currentThreadId))
  ) {
    return null;
  }
  return {
    type: "renderer-bridge-ready",
    currentThreadId: ready.currentThreadId,
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
  private readonly activeTurnsByThread = new Map<string, Set<string>>();
  private readonly readySessions = new Set<string>();
  private readonly waitingSessions = new Map<
    string,
    { threadId: string; turnIds: Set<string> }
  >();
  private hasAcceptedReadySession = false;

  constructor(options: RendererRecoveryCoordinatorOptions<TMessage>) {
    this.broadcast = options.broadcast;
    this.recover = options.recover;
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
  ): void {
    if (this.readySessions.has(connectionId)) {
      return;
    }
    this.readySessions.add(connectionId);
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
    this.waitingSessions.set(connectionId, {
      threadId: currentThreadId,
      turnIds: new Set(activeTurns),
    });
  }

  disposeRenderer(connectionId: string): void {
    this.readySessions.delete(connectionId);
    this.waitingSessions.delete(connectionId);
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
      if (waiting.turnIds.size !== 0) {
        continue;
      }
      this.waitingSessions.delete(connectionId);
      if (this.readySessions.has(connectionId)) {
        this.recover(connectionId);
      }
    }
  }
}
