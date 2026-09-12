import { createHash, randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import {
  AppServerConnection,
  DeliveryUnknownError,
  RpcError,
} from "./connection";
import { type Backend } from "./config";
import { SessionStore, type Session, type Command } from "./store";

function conflict(message: string): Error {
  return Object.assign(new Error(message), { statusCode: 409 });
}
function canonical(value: any): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`)
      .join(",")}}`;
  return JSON.stringify(value);
}
function fingerprint(value: any): string {
  return createHash("sha256").update(canonical(value)).digest("hex");
}
function validId(value: unknown): value is string {
  return typeof value === "string" && /^[a-zA-Z0-9_-]{1,128}$/.test(value);
}
function statusFromThread(thread: any): string {
  const active = thread?.turns?.find((t: any) => t.status === "inProgress");
  return active ? "running" : (thread?.turns?.at(-1)?.status ?? "ready");
}

/** Application commands and event ownership, independent of HTTP/WS viewers. */
export class SessionService extends EventEmitter {
  readonly connections = new Map<string, AppServerConnection>();
  private stopped = false;
  private closePromise: Promise<void> | null = null;
  private reconnectTimers = new Map<string, NodeJS.Timeout>();
  private attached = new Map<string, Promise<void>>();
  private running = new Set<Promise<void>>();
  private queued = new Map<string, Promise<void>>();
  constructor(
    readonly store: SessionStore,
    readonly backends: Backend[],
    factory = (backend: Backend) => new AppServerConnection(backend),
  ) {
    super();
    for (const backend of backends) {
      const connection = factory(backend);
      this.connections.set(backend.id, connection);
      connection.on("notification", (message) =>
        this.onNotification(backend.id, message),
      );
      connection.on("request", (message, epoch) =>
        this.onRequest(backend.id, message, epoch),
      );
      connection.on("disconnected", () => {
        for (const key of this.attached.keys())
          if (key.startsWith(connection.epoch + ":")) this.attached.delete(key);
        for (const session of this.store
          .list()
          .filter((s) => s.backendId === backend.id)) {
          this.store.staleApprovals(session.id);
          this.change(
            session.id,
            "backend.disconnected",
            {},
            { connection: "unavailable" },
          );
        }
        this.emit("backends");
        this.scheduleReconnect(backend.id);
      });
    }
  }
  backend(id: string): Backend {
    const backend = this.backends.find((b) => b.id === id);
    if (!backend)
      throw Object.assign(new Error("Backend not found"), { statusCode: 404 });
    return backend;
  }
  summaries(): any[] {
    return this.backends.map((b) => ({
      id: b.id,
      label: b.label,
      cwd: b.cwd,
      transport: b.transport.type,
      connected: this.connections.get(b.id)!.connected,
      runtimeOwnership: ["stdio", "ssh"].includes(b.transport.type)
        ? "gateway-channel"
        : "external",
      capabilities: {
        codex: this.connections.get(b.id)!.connected,
        chatgpt: false,
        computerUse: false,
        files: ["stdio", "ssh"].includes(b.transport.type),
        terminal: ["stdio", "ssh"].includes(b.transport.type),
      },
    }));
  }
  start(): void {
    for (const b of this.backends) this.track(this.warm(b.id));
  }
  private track(promise: Promise<void>): void {
    this.running.add(promise);
    void promise.catch(() => {}).finally(() => this.running.delete(promise));
  }
  private async warm(id: string): Promise<void> {
    if (this.stopped) return;
    try {
      await this.connections.get(id)!.connect();
      this.emit("backends");
      for (const session of this.store
        .list()
        .filter((s) => s.backendId === id && s.threadId)) {
        try {
          await this.attach(session.id);
        } catch {
          /* Preserve cached state until explicit reconciliation succeeds. */
        }
      }
    } catch {
      this.scheduleReconnect(id);
    }
  }
  private scheduleReconnect(id: string): void {
    if (this.stopped || this.reconnectTimers.has(id)) return;
    const timer = setTimeout(() => {
      this.reconnectTimers.delete(id);
      this.track(this.warm(id));
    }, 5000);
    timer.unref();
    this.reconnectTimers.set(id, timer);
  }
  private change(
    id: string,
    type: string,
    payload: unknown,
    patch: Partial<Session> = {},
  ): Session {
    const session = this.store.event(id, type, payload, patch);
    this.emit("session", id);
    return session;
  }
  private record(command: Command): void {
    this.store.putCommand(command);
    this.change(command.sessionId, "command.changed", command);
  }
  private existing(id: string, digest: string): Command | undefined {
    if (this.stopped)
      throw Object.assign(new Error("Gateway is shutting down"), {
        statusCode: 503,
      });
    if (!validId(id))
      throw Object.assign(
        new Error("A persistent clientCommandId is required"),
        { statusCode: 400 },
      );
    const existing = this.store.command(id);
    if (existing && existing.fingerprint !== digest)
      throw conflict("clientCommandId was already used for different input");
    if (!existing && this.running.size >= 64)
      throw Object.assign(new Error("Gateway command capacity exceeded"), {
        statusCode: 429,
      });
    return existing;
  }

  create(input: {
    clientCommandId: string;
    backendId: string;
    threadId?: string;
  }): Command {
    const backend = this.backend(input.backendId);
    if (input.threadId !== undefined && !validId(input.threadId))
      throw Object.assign(new Error("Invalid thread ID"), { statusCode: 400 });
    const digest = fingerprint({ method: "session/create", ...input });
    const existing = this.existing(input.clientCommandId, digest);
    if (existing) return existing;
    const prior = input.threadId
      ? this.store.findThread(backend.id, input.threadId)
      : undefined;
    const sessionId = prior?.id ?? randomUUID();
    const command: Command = {
      id: input.clientCommandId,
      sessionId,
      method: input.threadId ? "thread/resume" : "thread/start",
      fingerprint: digest,
      state: "received",
    };
    this.store.transaction(() => {
      if (!prior)
        this.store.save({
          id: sessionId,
          backendId: backend.id,
          threadId: input.threadId ?? null,
          cwd: backend.cwd,
          title: "New conversation",
          status: "creating",
          seq: 0,
          updatedAt: Date.now(),
          thread: null,
          connection: "unavailable",
        });
      this.store.putCommand(command);
    });
    this.enqueue(sessionId, async () => {
      try {
        const connection = this.connections.get(backend.id)!;
        await connection.connect();
        this.record({ ...command, state: "dispatching" });
        const result = await connection.request(
          command.method,
          input.threadId ? { threadId: input.threadId } : { cwd: backend.cwd },
        );
        if (!validId(result?.thread?.id))
          throw new DeliveryUnknownError("Runtime returned no thread identity");
        this.change(
          sessionId,
          "session.created",
          {},
          {
            threadId: result.thread.id,
            thread: result.thread,
            status: statusFromThread(result.thread),
            connection: "connected",
            title:
              result.thread.name || result.thread.preview || "New conversation",
          },
        );
        this.attached.set(
          `${connection.epoch}:${sessionId}`,
          Promise.resolve(),
        );
        this.record({
          ...command,
          state: "accepted",
          result: { sessionId, threadId: result.thread.id },
        });
      } catch (error) {
        this.failed(command, error);
      }
    });
    return command;
  }

  submit(
    sessionId: string,
    input: { clientCommandId: string; method: string; params: any },
  ): Command {
    const session = this.store.get(sessionId);
    this.backend(session.backendId);
    if (!["turn/start", "turn/steer", "turn/interrupt"].includes(input.method))
      throw Object.assign(new Error("Unsupported command"), {
        statusCode: 400,
      });
    const params = input.params ?? {};
    if (!params || typeof params !== "object" || Array.isArray(params))
      throw Object.assign(new Error("Invalid command params"), {
        statusCode: 400,
      });
    if ("threadId" in params || "cwd" in params)
      throw Object.assign(
        new Error("Thread and cwd are selected by the session"),
        { statusCode: 400 },
      );
    // Do not expose arbitrary app-server configuration or policy overrides.
    const allowed =
      input.method === "turn/interrupt"
        ? ["turnId"]
        : input.method === "turn/steer"
          ? ["input", "expectedTurnId"]
          : ["input", "model"];
    if (Object.keys(params).some((k) => !allowed.includes(k)))
      throw Object.assign(new Error("Unsupported command parameter"), {
        statusCode: 400,
      });
    if (
      input.method !== "turn/interrupt" &&
      (!Array.isArray(params.input) ||
        params.input.length === 0 ||
        params.input.length > 32 ||
        params.input.some(
          (v: any) =>
            !v ||
            !(
              (v.type === "text" && typeof v.text === "string") ||
              (v.type === "localImage" && typeof v.path === "string")
            ),
        ))
    )
      throw Object.assign(new Error("Provide text or host-local image input"), {
        statusCode: 400,
      });
    const digest = fingerprint({ sessionId, method: input.method, params });
    const existing = this.existing(input.clientCommandId, digest);
    if (existing) return existing;
    if (!session.threadId)
      throw conflict("Wait for the runtime to create this conversation");
    const command: Command = {
      id: input.clientCommandId,
      sessionId,
      method: input.method,
      fingerprint: digest,
      state: "received",
    };
    this.record(command);
    this.enqueue(sessionId, async () => {
      try {
        const connection = this.connections.get(session.backendId)!;
        await connection.connect();
        await this.attach(sessionId);
        const current = this.store.get(sessionId);
        if (
          input.method === "turn/start" &&
          current.thread?.turns?.some((t: any) => t.status === "inProgress")
        )
          throw new RpcError(
            "A turn is already running; use steer or interrupt",
            -32600,
          );
        this.record({ ...command, state: "dispatching" });
        const result = await connection.request(input.method, {
          ...params,
          threadId: current.threadId,
        });
        if (input.method === "turn/start" && result?.turn) {
          // A completed notification may arrive before the start acknowledgement.
          const latest = this.store.get(sessionId);
          const thread = structuredClone(latest.thread);
          thread.turns ??= [];
          if (!thread.turns.some((t: any) => t.id === result.turn.id))
            thread.turns.push(result.turn);
          this.change(sessionId, "turn.accepted", result.turn, {
            thread,
            status: statusFromThread(thread),
            title:
              latest.title === "New conversation"
                ? params.input
                    .find((v: any) => v.type === "text")
                    ?.text.slice(0, 100) || latest.title
                : latest.title,
          });
        }
        this.record({ ...command, state: "accepted", result });
      } catch (error) {
        this.failed(command, error);
      }
    });
    return command;
  }

  private failed(command: Command, error: unknown): void {
    const current = this.store.command(command.id)!;
    this.record({
      ...command,
      state:
        error instanceof DeliveryUnknownError && current.state === "dispatching"
          ? "unknown"
          : "failed",
      error: error instanceof Error ? error.message : "Request failed",
    });
  }
  private enqueue(id: string, work: () => Promise<void>): void {
    const task = (this.queued.get(id) ?? Promise.resolve())
      .catch(() => {})
      .then(work);
    this.queued.set(id, task);
    this.track(
      task.finally(() => {
        if (this.queued.get(id) === task) this.queued.delete(id);
      }),
    );
  }

  private async attach(id: string): Promise<void> {
    const session = this.store.get(id);
    if (!session.threadId) return;
    const connection = this.connections.get(session.backendId)!;
    await connection.connect();
    const key = `${connection.epoch}:${id}`;
    const previous = this.attached.get(key);
    if (previous) return previous;
    const operation = (async () => {
      const seq = this.store.get(id).seq;
      const result = await connection.request("thread/resume", {
        threadId: session.threadId,
      });
      if (result?.thread?.id !== session.threadId)
        throw new Error("Wrong thread returned by runtime");
      const patch: Partial<Session> = { connection: "connected" };
      // Never replace newer streaming state with an older in-flight read.
      if (this.store.get(id).seq === seq) {
        patch.thread = result.thread;
        patch.status = statusFromThread(result.thread);
      }
      this.change(id, "session.attached", {}, patch);
    })();
    this.attached.set(key, operation);
    try {
      await operation;
    } catch (error) {
      this.attached.delete(key);
      throw error;
    }
  }

  async reconcile(id: string): Promise<void> {
    const session = this.store.get(id);
    if (!session.threadId) return;
    const connection = this.connections.get(session.backendId)!;
    for (let attempt = 0; attempt < 3; attempt++) {
      const seq = this.store.get(id).seq;
      const result = await connection.request("thread/read", {
        threadId: session.threadId,
        includeTurns: true,
      });
      if (result?.thread?.id !== session.threadId)
        throw new Error("Wrong thread returned by runtime");
      if (this.store.get(id).seq !== seq) continue;
      this.change(
        id,
        "session.reconciled",
        {},
        {
          thread: result.thread,
          status: statusFromThread(result.thread),
          connection: "connected",
        },
      );
      return;
    }
    // The viewer already has the newer projection; completion will reconcile.
  }

  async listThreads(id: string): Promise<any> {
    this.backend(id);
    return this.connections.get(id)!.request("thread/list", { limit: 30 });
  }

  answer(id: string, result: any): void {
    const approval = this.store.approval(id);
    if (!approval || approval.state !== "pending")
      throw conflict("This request is no longer pending");
    const session = this.store.get(approval.sessionId);
    const connection = this.connections.get(session.backendId)!;
    if (!connection.connected || connection.epoch !== approval.epoch) {
      this.store.putApproval({ ...approval, state: "stale" });
      throw conflict("This request belongs to a disconnected runtime");
    }
    if (approval.method.endsWith("/requestApproval")) {
      if (
        !result ||
        !["accept", "decline", "cancel"].includes(result.decision) ||
        Object.keys(result).length !== 1
      )
        throw Object.assign(new Error("Choose accept, decline or cancel"), {
          statusCode: 400,
        });
      if (
        Array.isArray(approval.params.availableDecisions) &&
        !approval.params.availableDecisions.includes(result.decision)
      )
        throw conflict("Decision is not offered by the runtime");
    } else {
      if (!result?.answers || typeof result.answers !== "object")
        throw Object.assign(new Error("Provide answers"), { statusCode: 400 });
    }
    // Claim synchronously before any I/O: only one device can answer.
    this.store.putApproval({ ...approval, state: "responding" });
    try {
      connection.respond(approval.requestId, result);
      // Wait for serverRequest/resolved before declaring it answered.
      this.change(session.id, "approval.responding", { id });
    } catch (error) {
      this.store.putApproval({ ...approval, state: "stale" });
      this.change(session.id, "approval.stale", { id });
      throw error;
    }
  }

  private onRequest(backendId: string, message: any, epoch: string): void {
    if (this.stopped) return;
    const connection = this.connections.get(backendId)!;
    const session = this.store.findThread(backendId, message.params?.threadId);
    if (
      !session ||
      ![
        "item/commandExecution/requestApproval",
        "item/fileChange/requestApproval",
        "item/tool/requestUserInput",
      ].includes(message.method)
    ) {
      connection.rejectRequest(message.id);
      return;
    }
    const duplicate = this.store
      .approvals(session.id)
      .find((a) => a.epoch === epoch && a.requestId === message.id);
    if (duplicate) return;
    const approval = {
      id: randomUUID(),
      sessionId: session.id,
      epoch,
      requestId: message.id,
      method: message.method,
      params: message.params,
      state: "pending" as const,
    };
    this.store.putApproval(approval);
    this.change(
      session.id,
      "approval.pending",
      { id: approval.id },
      { status: "awaiting_approval" },
    );
  }

  private onNotification(backendId: string, message: any): void {
    if (this.stopped) return;
    const p = message.params ?? {};
    const threadId = p.threadId ?? p.thread?.id;
    if (typeof threadId !== "string") return;
    const session = this.store.findThread(backendId, threadId);
    if (!session) return;
    if (message.method === "serverRequest/resolved") {
      for (const a of this.store.approvals(session.id))
        if (a.requestId === p.requestId)
          this.store.putApproval({ ...a, state: "answered" });
    }
    const thread = structuredClone(
      session.thread ?? { id: threadId, turns: [] },
    );
    thread.turns ??= [];
    const turnId = p.turnId ?? p.turn?.id;
    let turn = thread.turns.find((t: any) => t.id === turnId);
    if (p.turn) {
      if (turn)
        Object.assign(turn, p.turn, {
          items: p.turn.items?.length ? p.turn.items : (turn.items ?? []),
        });
      else {
        turn = { ...p.turn, items: p.turn.items ?? [] };
        thread.turns.push(turn);
      }
    }
    if (!turn && turnId && (p.item || typeof p.delta === "string")) {
      turn = { id: turnId, status: "inProgress", items: [] };
      thread.turns.push(turn);
    }
    if (turn) {
      turn.items ??= [];
      if (p.item) {
        const index = turn.items.findIndex((i: any) => i.id === p.item.id);
        if (index === -1) turn.items.push(p.item);
        else turn.items[index] = p.item;
      }
      if (message.method === "item/agentMessage/delta") {
        let item = turn.items.find((i: any) => i.id === p.itemId);
        if (!item) {
          item = { id: p.itemId, type: "agentMessage", text: "" };
          turn.items.push(item);
        }
        item.text = (item.text ?? "") + (p.delta ?? "");
      }
    }
    if (message.method === "turn/completed")
      this.store.staleApprovals(session.id);
    this.change(session.id, message.method, p, {
      thread,
      connection: "connected",
      status: this.store.approvals(session.id).length
        ? "awaiting_approval"
        : statusFromThread(thread),
    });
    if (message.method === "turn/completed")
      this.track(this.reconcile(session.id));
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.stopped = true;
    for (const timer of this.reconnectTimers.values()) clearTimeout(timer);
    for (const connection of this.connections.values()) connection.close();
    this.closePromise = Promise.allSettled([...this.running]).then(() =>
      this.store.close(),
    );
    return this.closePromise;
  }
}
