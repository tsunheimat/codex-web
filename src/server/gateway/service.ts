import { createHash, randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import {
  AppServerConnection,
  DeliveryUnknownError,
  RpcError,
} from "./connection";
import { type Backend } from "./config";
import { SessionStore, type Session, type Command } from "./store";
import { DesktopConnection } from "./desktop";

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
function nativeStatus(conversation: any): string {
  if (conversation?.thread?.status?.type === "active") return "running";
  if (conversation?.thread?.status?.type === "systemError") return "failed";
  return statusFromThread({ turns: conversation?.turns });
}

/** Application commands and event ownership, independent of HTTP/WS viewers. */
export class SessionService extends EventEmitter {
  readonly connections = new Map<
    string,
    AppServerConnection | DesktopConnection
  >();
  private stopped = false;
  private closePromise: Promise<void> | null = null;
  private reconnectTimers = new Map<string, NodeJS.Timeout>();
  private attached = new Map<string, Promise<void>>();
  private running = new Set<Promise<void>>();
  private queued = new Map<string, Promise<void>>();
  readonly captures = new Map<string, any>();
  readonly captureStatuses = new Map<string, any>();
  /**
   * Renderer clients attached through the app-server endpoint answer runtime
   * server requests themselves; a handler returning true owns the request.
   */
  readonly requestHandlers = new Map<
    string,
    Set<(message: any, epoch: string) => boolean>
  >();
  constructor(
    readonly store: SessionStore,
    readonly backends: Backend[],
    factory = (backend: Backend): AppServerConnection | DesktopConnection =>
      backend.transport.type === "desktop"
        ? new DesktopConnection(backend)
        : new AppServerConnection(backend),
  ) {
    super();
    for (const backend of backends) {
      const connection = factory(backend);
      this.connections.set(backend.id, connection);
      connection.on("connected", () => this.emit("backends"));
      connection.on("capabilities", () => this.emit("backends"));
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
  /** Return a backend view rooted at the selected session's execution project. */
  backendForSession(id: string): Backend {
    const session = this.store.get(id);
    const backend = this.backend(session.backendId);
    return { ...backend, cwd: session.cwd };
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
        : b.transport.type === "desktop"
          ? "desktop"
          : b.transport.type === "companion"
            ? "companion"
            : "external",
      capabilities: {
        codex: this.connections.get(b.id)!.connected,
        remoteControl: this.connections.get(b.id)!.connected,
        chatgpt: false,
        computerUse: false,
        files: ["stdio", "ssh", "companion"].includes(b.transport.type),
        terminal: ["stdio", "ssh"].includes(b.transport.type),
        ...(b.transport.type === "desktop"
          ? {
              ...(this.connections.get(b.id) as DesktopConnection).info
                ?.capabilities,
              codex: this.connections.get(b.id)!.connected,
              chatgpt:
                this.connections.get(b.id)!.connected &&
                (this.connections.get(b.id) as DesktopConnection).info
                  ?.capabilities?.chatgpt === true,
              attachments: this.connections.get(b.id)!.connected,
              files: false,
              terminal: false,
              remoteControl: false,
            }
          : {}),
      },
      ...(b.transport.type === "desktop"
        ? {
            desktop: (this.connections.get(b.id) as DesktopConnection).info
              ?.desktop,
          }
        : {}),
    }));
  }
  start(): void {
    for (const b of this.backends)
      if (!["companion", "desktop"].includes(b.transport.type))
        this.track(this.warm(b.id));
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
    if (["companion", "desktop"].includes(this.backend(id).transport.type))
      return;
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
    conversationKind?: "codex" | "chatgpt";
    conversationId?: string;
  }): Command {
    const backend = this.backend(input.backendId);
    const kind = input.conversationKind ?? "codex";
    if (
      !["codex", "chatgpt"].includes(kind) ||
      (kind === "chatgpt" &&
        (backend.transport.type !== "desktop" ||
          !validId(input.conversationId) ||
          input.threadId !== undefined))
    )
      throw Object.assign(
        new Error(
          "Use a Desktop backend and native conversationId for ChatGPT",
        ),
        { statusCode: 400 },
      );
    if (kind === "codex" && input.conversationId !== undefined)
      throw Object.assign(new Error("Use threadId for a Codex conversation"), {
        statusCode: 400,
      });
    if (
      backend.transport.type === "desktop" &&
      kind === "codex" &&
      !input.threadId
    )
      throw Object.assign(
        new Error(
          "Select an existing Desktop conversation. The follower interface does not create conversations.",
        ),
        { statusCode: 409 },
      );
    if (input.threadId !== undefined && !validId(input.threadId))
      throw Object.assign(new Error("Invalid thread ID"), { statusCode: 400 });
    const digest = fingerprint({ method: "session/create", ...input });
    const existing = this.existing(input.clientCommandId, digest);
    if (existing) return existing;
    const identity = kind === "chatgpt" ? input.conversationId : input.threadId;
    const prior = identity
      ? this.store.findConversation(backend.id, identity, kind)
      : undefined;
    const sessionId = prior?.id ?? randomUUID();
    const command: Command = {
      id: input.clientCommandId,
      sessionId,
      method:
        kind === "chatgpt"
          ? "chatgpt/attach"
          : input.threadId
            ? "thread/resume"
            : "thread/start",
      fingerprint: digest,
      state: "received",
    };
    this.store.transaction(() => {
      if (!prior)
        this.store.save({
          id: sessionId,
          backendId: backend.id,
          threadId: input.threadId ?? null,
          conversationKind: kind,
          ...(kind === "chatgpt"
            ? { conversationId: input.conversationId }
            : {}),
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
          kind === "chatgpt"
            ? { conversationId: input.conversationId }
            : input.threadId
              ? { threadId: input.threadId }
              : { cwd: backend.cwd },
        );
        if (kind === "chatgpt") {
          if (result?.conversationId !== input.conversationId)
            throw new DeliveryUnknownError(
              "Desktop returned the wrong native conversation identity",
            );
          this.change(
            sessionId,
            "session.created",
            {},
            {
              nativeConversation: result.conversation,
              status: nativeStatus(result.conversation),
              connection: "connected",
              title:
                result.conversation?.title ??
                result.conversation?.thread?.title ??
                "ChatGPT conversation",
            },
          );
          this.attached.set(
            `${connection.epoch}:${sessionId}`,
            Promise.resolve(),
          );
          this.record({
            ...command,
            state: "accepted",
            result: {
              sessionId,
              conversationKind: kind,
              conversationId: input.conversationId,
            },
          });
          return;
        }
        if (!validId(result?.thread?.id))
          throw new DeliveryUnknownError("Runtime returned no thread identity");
        this.change(
          sessionId,
          "session.created",
          {},
          {
            threadId: result.thread.id,
            thread: result.thread,
            cwd:
              typeof result.thread.cwd === "string"
                ? result.thread.cwd
                : backend.cwd,
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
    const native = session.conversationKind === "chatgpt";
    const stopComputer = input.method === "computerUse/stop";
    if (
      !(
        native
          ? ["chatgpt/send", "computerUse/stop"]
          : ["turn/start", "turn/steer", "turn/interrupt", "computerUse/stop"]
      ).includes(input.method)
    )
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
    const allowed = stopComputer
      ? ["ownerId", "turnId"]
      : native
        ? ["prompt", "attachmentIds"]
        : input.method === "turn/interrupt"
          ? ["turnId"]
          : input.method === "turn/steer"
            ? ["input", "expectedTurnId"]
            : ["input", "model"];
    if (Object.keys(params).some((k) => !allowed.includes(k)))
      throw Object.assign(new Error("Unsupported command parameter"), {
        statusCode: 400,
      });
    if (
      !native &&
      !stopComputer &&
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
    if (
      native &&
      !stopComputer &&
      (typeof params.prompt !== "string" ||
        (!params.prompt.trim() && !params.attachmentIds?.length) ||
        params.prompt.length > 200000)
    )
      throw Object.assign(new Error("Provide a native ChatGPT text prompt"), {
        statusCode: 400,
      });
    if (
      native &&
      params.attachmentIds !== undefined &&
      (!Array.isArray(params.attachmentIds) ||
        params.attachmentIds.length > 16 ||
        params.attachmentIds.some((id: any) => !validId(id)))
    )
      throw Object.assign(new Error("Invalid native attachment identities"), {
        statusCode: 400,
      });
    if (
      stopComputer &&
      (this.backend(session.backendId).transport.type !== "desktop" ||
        params.ownerId !== session.computerUse?.ownerId ||
        params.turnId !== session.computerUse?.turnId)
    )
      throw conflict("Computer Use owner changed; attach again");
    const digest = fingerprint({ sessionId, method: input.method, params });
    const existing = this.existing(input.clientCommandId, digest);
    if (existing) return existing;
    if (!session.threadId && !session.conversationId)
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
        const requestParams = {
          ...params,
          ...(native
            ? { conversationId: current.conversationId }
            : { threadId: current.threadId }),
        };
        const result =
          connection instanceof DesktopConnection
            ? await connection.request(input.method, requestParams, command.id)
            : await connection.request(input.method, requestParams);
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
        if (native) this.track(this.reconcile(sessionId));
      } catch (error) {
        this.failed(command, error);
      }
    });
    return command;
  }

  private failed(command: Command, error: unknown): void {
    const current = this.store.command(command.id)!;
    const unknown =
      error instanceof DeliveryUnknownError && current.state === "dispatching";
    this.record({
      ...command,
      state: unknown ? "unknown" : "failed",
      error: error instanceof Error ? error.message : "Request failed",
    });
    this.change(
      command.sessionId,
      unknown ? "command.unknown" : "command.failed",
      { commandId: command.id },
      { status: unknown ? "delivery_unknown" : "failed" },
    );
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

  /** Attach (or re-attach) a stored session to its runtime conversation. */
  attachSession(id: string): Promise<void> {
    return this.attach(id);
  }
  private async attach(id: string): Promise<void> {
    const session = this.store.get(id);
    if (!session.threadId && !session.conversationId) return;
    const connection = this.connections.get(session.backendId)!;
    await connection.connect();
    const key = `${connection.epoch}:${id}`;
    const previous = this.attached.get(key);
    if (previous) return previous;
    const operation = (async () => {
      const seq = this.store.get(id).seq;
      const native = session.conversationKind === "chatgpt";
      const result = await connection.request(
        native ? "chatgpt/attach" : "thread/resume",
        native
          ? { conversationId: session.conversationId }
          : { threadId: session.threadId },
      );
      if (native) {
        if (result?.conversationId !== session.conversationId)
          throw new Error("Wrong native conversation returned by Desktop");
        this.change(
          id,
          "session.attached",
          {},
          { connection: "connected", nativeConversation: result.conversation },
        );
        return;
      }
      if (result?.thread?.id !== session.threadId)
        throw new Error("Wrong thread returned by runtime");
      const patch: Partial<Session> = {
        connection: "connected",
        ...(typeof result.thread.cwd === "string"
          ? { cwd: result.thread.cwd }
          : {}),
      };
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
    if (!session.threadId && !session.conversationId) return;
    const connection = this.connections.get(session.backendId)!;
    if (connection instanceof DesktopConnection)
      for (const command of this.store
        .commands(id)
        .filter(
          (c) =>
            c.state === "unknown" &&
            ["chatgpt/send", "computerUse/stop"].includes(c.method),
        )) {
        try {
          const receipt = await connection.request("native/operation/read", {
            commandId: command.id,
          });
          if (receipt.state === "complete")
            this.record({
              ...command,
              state: "accepted",
              result: receipt.result,
              error: undefined,
            });
        } catch {
          /* Preserve unknown; never replay. */
        }
      }
    if (session.conversationKind === "chatgpt") {
      const result = await connection.request("chatgpt/read", {
        conversationId: session.conversationId,
      });
      if (result?.conversationId !== session.conversationId)
        throw new Error("Wrong native conversation returned by Desktop");
      this.change(
        id,
        "session.reconciled",
        {},
        {
          nativeConversation: result.conversation,
          connection: "connected",
          status: nativeStatus(result.conversation),
        },
      );
      return;
    }
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
          ...(typeof result.thread.cwd === "string"
            ? { cwd: result.thread.cwd }
            : {}),
          status: statusFromThread(result.thread),
          connection: "connected",
        },
      );
      return;
    }
    // The viewer already has the newer projection; completion will reconcile.
  }

  async listThreads(id: string, kind = "codex"): Promise<any> {
    this.backend(id);
    if (!["codex", "chatgpt"].includes(kind))
      throw Object.assign(new Error("Invalid conversation kind"), {
        statusCode: 400,
      });
    return this.connections
      .get(id)!
      .request(kind === "chatgpt" ? "chatgpt/list" : "thread/list", {
        limit: 30,
      });
  }
  /** Account identity held by the Windows Desktop's own credential store. */
  async desktopAccount(id: string, includeToken = false): Promise<any> {
    const connection = this.connections.get(id);
    if (!(connection instanceof DesktopConnection))
      throw conflict("Backend is not a Desktop transport");
    return connection.request("account/read", { includeToken });
  }
  /** Read an image the bridge staged or that a followed conversation shows. */
  async desktopReadFile(id: string, filePath: string): Promise<any> {
    const connection = this.connections.get(id);
    if (!(connection instanceof DesktopConnection))
      throw conflict("Backend is not a Desktop transport");
    if (typeof filePath !== "string" || filePath.length > 4096)
      throw Object.assign(new Error("Invalid path"), { statusCode: 400 });
    return connection.request("file/read", { path: filePath });
  }

  /** Projects and projectless-thread bookkeeping the Windows Desktop stores. */
  async desktopGlobalState(id: string): Promise<any> {
    const connection = this.connections.get(id);
    if (!(connection instanceof DesktopConnection))
      throw conflict("Backend is not a Desktop transport");
    return connection.request("globalState/read", {});
  }
  /** Existence and kind of paths on the Desktop host (no contents). */
  async desktopFileMetadata(id: string, paths: string[]): Promise<any> {
    const connection = this.connections.get(id);
    if (!(connection instanceof DesktopConnection))
      throw conflict("Backend is not a Desktop transport");
    if (
      !Array.isArray(paths) ||
      paths.length > 64 ||
      paths.some((p) => typeof p !== "string" || p.length > 4096)
    )
      throw Object.assign(new Error("Invalid paths"), { statusCode: 400 });
    return connection.request("fs/metadata", { paths });
  }

  desktopToken(id: string): string | null {
    const t = this.backends.find((b) => b.id === id)?.transport;
    if (t?.type !== "desktop") return null;
    const token = process.env[t.agentTokenEnv];
    return token && token.length >= 32 ? token : null;
  }
  async attachDesktop(
    id: string,
    socket: import("ws").WebSocket,
    info: any,
  ): Promise<void> {
    const connection = this.connections.get(id);
    if (!(connection instanceof DesktopConnection))
      throw new Error("Backend is not Desktop");
    connection.attachDesktop(socket, info);
    this.emit("backends");
    for (const session of this.store
      .list()
      .filter((s) => s.backendId === id && (s.threadId || s.conversationId))) {
      try {
        await this.attach(session.id);
      } catch {
        /* Keep cached history. */
      }
    }
  }
  async desktopUpload(
    id: string,
    sessionId: string,
    params: any,
  ): Promise<any> {
    const session = this.store.get(sessionId),
      connection = this.connections.get(id);
    if (session.backendId !== id || !(connection instanceof DesktopConnection))
      throw conflict("Select a Desktop session before uploading");
    if (session.conversationKind === "chatgpt") {
      if (connection.info?.capabilities?.chatgptAttachments !== true)
        throw conflict(
          "Native ChatGPT uploadChatGptConversationFile binding awaits the approved Desktop adapter installation",
        );
      if (!validId(params.uploadId))
        throw Object.assign(new Error("A stable native uploadId is required"), {
          statusCode: 400,
        });
      return connection.request(
        "chatgpt/upload",
        { ...params, conversationId: session.conversationId },
        params.uploadId,
      );
    }
    if (
      typeof params.data !== "string" ||
      params.data.length > Math.ceil((5 * 1024 * 1024) / 3) * 4
    )
      throw Object.assign(new Error("Desktop image upload exceeds 5 MiB"), {
        statusCode: 400,
      });
    return connection.request("attachment/upload", params);
  }
  async nativeUploads(id: string): Promise<any> {
    const session = this.store.get(id),
      connection = this.connections.get(session.backendId);
    if (
      !(connection instanceof DesktopConnection) ||
      session.conversationKind !== "chatgpt"
    )
      throw conflict("Select a native ChatGPT session");
    const result = await connection.request("chatgpt/uploads", {
      conversationId: session.conversationId,
    });
    this.change(id, "native.uploads", {}, { nativeUploads: result.uploads });
    return result;
  }
  async computerUse(
    id: string,
    action: "attach" | "read" | "stop",
    params: any = {},
  ): Promise<any> {
    const session = this.store.get(id),
      connection = this.connections.get(session.backendId);
    if (
      !(connection instanceof DesktopConnection) ||
      connection.info?.capabilities?.computerUse !== true
    )
      throw conflict(
        "Computer Use awaits the approved Desktop adapter installation",
      );
    if (action === "attach")
      return connection.request("computerUse/attach", {
        conversationId: session.conversationId ?? session.threadId,
        conversationKind: session.conversationKind ?? "codex",
      });
    const owner = session.computerUse;
    if (
      !owner ||
      params.ownerId !== owner.ownerId ||
      params.turnId !== owner.turnId
    )
      throw conflict("Computer Use owner changed; attach again");
    if (action === "stop" && !validId(params.clientCommandId))
      throw Object.assign(new Error("A stable stop command ID is required"), {
        statusCode: 400,
      });
    if (action === "stop")
      return this.submit(id, {
        clientCommandId: params.clientCommandId,
        method: "computerUse/stop",
        params: { ownerId: owner.ownerId, turnId: owner.turnId },
      });
    return connection.request("computerUse/read", {
      ownerId: owner.ownerId,
      turnId: owner.turnId,
    });
  }

  async remoteControl(
    id: string,
    action:
      | "status/read"
      | "enable"
      | "disable"
      | "pairing/start"
      | "pairing/status"
      | "client/list"
      | "client/revoke",
    params: any = null,
  ): Promise<any> {
    this.backend(id);
    const allowed: Record<string, string[]> = {
      "status/read": [],
      enable: ["ephemeral"],
      disable: ["ephemeral"],
      "pairing/start": ["manualCode"],
      "pairing/status": ["pairingCode", "manualPairingCode"],
      "client/list": ["environmentId", "cursor", "limit", "order"],
      "client/revoke": ["environmentId", "clientId"],
    };
    const value = params ?? {};
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw Object.assign(new Error("Invalid remote-control parameters"), {
        statusCode: 400,
      });
    if (
      Object.keys(value).some((key) => !(allowed[action] ?? []).includes(key))
    )
      throw Object.assign(new Error("Unsupported remote-control parameter"), {
        statusCode: 400,
      });
    return this.connections.get(id)!.request(`remoteControl/${action}`, value);
  }

  async companionControl(
    id: string,
    action: "list" | "read" | "upload",
    params: Record<string, unknown>,
  ): Promise<any> {
    const backend = this.backend(id);
    if (backend.transport.type !== "companion")
      throw Object.assign(new Error("Backend is not a companion target"), {
        statusCode: 409,
      });
    return this.connections.get(id)!.control(action, params);
  }

  companionToken(id: string): string | null {
    const backend = this.backends.find((entry) => entry.id === id);
    if (!backend) return null;
    const transport = backend.transport;
    if (transport.type !== "companion") return null;
    const token = process.env[transport.agentTokenEnv];
    return token && token.length >= 32 ? token : null;
  }

  async attachCompanion(
    id: string,
    socket: import("ws").WebSocket,
    initialize = true,
  ): Promise<void> {
    const connection = this.connections.get(id);
    if (
      !(connection instanceof AppServerConnection) ||
      this.backend(id).transport.type !== "companion"
    )
      throw Object.assign(new Error("Backend is not a companion target"), {
        statusCode: 409,
      });
    await connection.attachCompanion(socket, initialize);
    this.emit("backends");
    for (const session of this.store
      .list()
      .filter((s) => s.backendId === id && s.threadId)) {
      try {
        await this.attach(session.id);
      } catch {
        // Keep the cached projection until the next authoritative read.
      }
    }
  }

  answer(id: string, result: any): void | Promise<void> {
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
      let acknowledgement;
      if (approval.method === "desktop/computerUse/requestApproval") {
        if (
          !(connection instanceof DesktopConnection) ||
          session.computerUse?.ownerId !== approval.params.ownerId ||
          session.computerUse?.turnId !== approval.params.turnId
        )
          throw conflict("Computer Use approval owner changed");
        acknowledgement = connection
          .request(
            "computerUse/answer",
            {
              ownerId: approval.params.ownerId,
              turnId: approval.params.turnId,
              approvalId: approval.requestId,
              result: { action: result.decision },
            },
            approval.id,
          )
          .then((receipt) => {
            if (receipt.resolved) {
              this.store.putApproval({ ...approval, state: "answered" });
              this.change(session.id, "approval.answered", { id });
            }
          });
      } else acknowledgement = connection.respond(approval.requestId, result);
      // Wait for serverRequest/resolved before declaring it answered.
      this.change(session.id, "approval.responding", { id });
      if (acknowledgement instanceof Promise)
        return acknowledgement.catch((error) => {
          this.store.putApproval({ ...approval, state: "stale" });
          this.change(session.id, "approval.stale", { id });
          throw error;
        });
    } catch (error) {
      this.store.putApproval({ ...approval, state: "stale" });
      this.change(session.id, "approval.stale", { id });
      throw error;
    }
  }

  private onRequest(backendId: string, message: any, epoch: string): void {
    if (this.stopped) return;
    for (const handler of this.requestHandlers.get(backendId) ?? [])
      if (handler(message, epoch)) return;
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
    if (
      message.method === "desktop/capture/status" &&
      this.backend(backendId).transport.type === "desktop"
    ) {
      this.captureStatuses.set(backendId, p);
      this.emit("captureStatus", backendId, p);
      return;
    }
    if (
      message.method.startsWith("desktop/computerUse/") &&
      this.backend(backendId).transport.type === "desktop"
    ) {
      const session = this.store.findConversation(
        backendId,
        p.conversationId,
        p.conversationKind === "chatgpt" ? "chatgpt" : "codex",
      );
      if (!session) return;
      if (message.method.endsWith("/capture")) {
        if (
          session.computerUse?.status === "active" &&
          session.computerUse?.ownerId === p.ownerId &&
          session.computerUse?.turnId === p.turnId &&
          typeof p.dataUrl === "string" &&
          p.dataUrl.length <= 1024 * 1024 &&
          /^data:image\/(jpeg|png|webp);base64,/.test(p.dataUrl)
        ) {
          this.captures.set(session.id, p);
          this.emit("capture", session.id, p);
        }
        return;
      }
      if (message.method.endsWith("/state")) {
        if (p.status !== "active") this.captures.delete(session.id);
        const offered = p.approvals ?? [],
          current = this.store
            .approvals(session.id)
            .filter((a) => a.method === "desktop/computerUse/requestApproval");
        for (const old of current)
          if (
            old.params.ownerId !== p.ownerId ||
            !offered.some((a: any) => a.approvalId === old.requestId)
          )
            this.store.putApproval({
              ...old,
              state:
                old.params.ownerId === p.ownerId &&
                p.resolvedApprovals?.some(
                  (a: any) => a.approvalId === old.requestId,
                )
                  ? "answered"
                  : "stale",
            });
        for (const a of offered)
          if (
            !current.some(
              (old) =>
                old.params.ownerId === p.ownerId &&
                old.requestId === a.approvalId,
            )
          )
            this.store.putApproval({
              id: randomUUID(),
              sessionId: session.id,
              epoch: this.connections.get(backendId)!.epoch,
              requestId: a.approvalId,
              method: "desktop/computerUse/requestApproval",
              params: {
                ownerId: p.ownerId,
                turnId: p.turnId,
                codexTurnMetadata: a.codexTurnMetadata ?? p.codexTurnMetadata,
                nativeContext: a.params,
                reason: a.params?.message ?? "Computer Use needs your approval",
                availableDecisions: ["accept", "decline", "cancel"],
              },
              state: "pending",
            });
        this.change(session.id, message.method, {}, { computerUse: p });
      }
      return;
    }
    if (message.method === "desktop/chatgpt/uploads") {
      const session = this.store.findConversation(
        backendId,
        p.conversationId,
        "chatgpt",
      );
      if (session)
        this.change(
          session.id,
          message.method,
          {},
          { nativeUploads: p.uploads },
        );
      return;
    }
    if (message.method === "desktop/chatgpt/snapshot") {
      const native = this.store.findConversation(
        backendId,
        p.conversationId,
        "chatgpt",
      );
      if (native)
        this.change(
          native.id,
          message.method,
          {},
          {
            nativeConversation: p.conversation,
            connection: "connected",
            status: nativeStatus(p.conversation),
          },
        );
      return;
    }
    const threadId = p.threadId ?? p.thread?.id;
    if (typeof threadId !== "string") return;
    const session = this.store.findThread(backendId, threadId);
    if (!session) return;
    if (message.method === "desktop/unavailable") {
      this.store.staleApprovals(session.id);
      this.change(
        session.id,
        message.method,
        {},
        { connection: "unavailable" },
      );
      return;
    }
    if (message.method === "desktop/snapshot") {
      this.change(
        session.id,
        message.method,
        {},
        {
          thread: p.thread,
          status: statusFromThread(p.thread),
          connection: "connected",
        },
      );
      return;
    }
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
