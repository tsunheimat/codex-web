import { createHash, randomUUID } from "node:crypto";
import { WebSocket } from "ws";
import { SessionService } from "./service";
import { DesktopConnection } from "./desktop";
import {
  AppServerConnection,
  DeliveryUnknownError,
  RpcError,
} from "./connection";
import { type Command, type Session } from "./store";
import {
  COLLABORATION_MODES,
  PERMISSION_PROFILES,
  defaultConfig,
  defaultModelList,
} from "./desktop-defaults";

/**
 * The original Codex Desktop renderer talks to its shell, and the shell talks
 * app-server JSON-RPC. This endpoint lets that shell connect to the gateway
 * (`CODEX_APP_SERVER_WS_URL`) instead of a local `codex app-server`.
 *
 * - App-server backends are proxied: the gateway already owns the runtime
 *   connection; the shell's requests, notifications and approval requests
 *   pass through it.
 * - The Windows Desktop backend has no app-server. `DesktopRendererClient`
 *   answers the app-server subset the renderer needs from gateway sessions,
 *   which the Desktop bridge keeps synchronized with the running Desktop.
 *   Commands and approvals go through the gateway journal, so persistent
 *   ownership, deduplication and reconnect semantics are unchanged.
 */

const TERMINAL_COMMAND_STATES = new Set(["accepted", "failed", "unknown"]);
const COMMAND_TIMEOUT_MS = 90_000;
const EMPTY_PAGE = { data: [], nextCursor: null };
const DATA_URL = /^data:(image\/(?:png|jpeg|gif|webp));base64,([A-Za-z0-9+/=]+)$/;

function seconds(ms: number | undefined): number {
  return Math.floor((ms ?? Date.now()) / 1000);
}
function rpcError(error: unknown): { code: number; message: string } {
  if (error instanceof RpcError)
    return { code: error.code, message: error.message };
  if (error instanceof DeliveryUnknownError)
    return { code: -32001, message: error.message };
  return {
    code: -32603,
    message: error instanceof Error ? error.message : "Request failed",
  };
}
function commandError(command: Command): { code: number; message: string } {
  return {
    code: command.state === "unknown" ? -32001 : -32603,
    message:
      command.error ??
      (command.state === "unknown"
        ? "Desktop acknowledgement was lost; reconcile before resubmitting"
        : "Desktop rejected the request"),
  };
}

abstract class RendererClient {
  protected closed = false;
  constructor(
    protected readonly service: SessionService,
    readonly backendId: string,
    protected readonly socket: WebSocket,
  ) {
    socket.on("message", (raw, binary) => {
      if (this.closed) return;
      let message: any;
      try {
        if (binary) throw new Error("binary");
        message = JSON.parse(String(raw));
        if (!message || typeof message !== "object" || Array.isArray(message))
          throw new Error("shape");
      } catch {
        socket.close(1008, "Invalid app-server frame");
        return;
      }
      void this.receive(message);
    });
    socket.on("close", () => this.dispose());
    socket.on("error", () => this.dispose());
  }
  protected send(message: unknown): void {
    if (this.closed || this.socket.readyState !== WebSocket.OPEN) return;
    const frame = JSON.stringify(message);
    if (this.socket.bufferedAmount > 32 * 1024 * 1024) {
      this.socket.close(1013, "Renderer is too slow");
      return;
    }
    this.socket.send(frame);
  }
  protected notify(method: string, params: unknown): void {
    this.send({ method, params });
  }
  protected reply(id: string | number, result: unknown): void {
    this.send({ id, result: result === undefined ? null : result });
  }
  protected fail(id: string | number, error: unknown): void {
    this.send({ id, error: rpcError(error) });
  }
  private async receive(message: any): Promise<void> {
    if (message.method !== undefined) {
      if (typeof message.method !== "string") return;
      if (message.id === undefined || message.id === null) {
        await this.onNotification(message.method, message.params);
        return;
      }
      if (typeof message.id !== "string" && typeof message.id !== "number")
        return;
      try {
        this.reply(
          message.id,
          await this.onRequest(message.id, message.method, message.params),
        );
      } catch (error) {
        this.fail(message.id, error);
      }
      return;
    }
    if (typeof message.id === "string" || typeof message.id === "number")
      await this.onResponse(message.id, message.result, message.error);
  }
  dispose(): void {
    if (this.closed) return;
    this.closed = true;
    this.onDispose();
  }
  protected abstract onRequest(
    id: string | number,
    method: string,
    params: any,
  ): Promise<unknown>;
  protected abstract onNotification(
    method: string,
    params: any,
  ): Promise<void>;
  protected abstract onResponse(
    id: string | number,
    result: any,
    error: any,
  ): Promise<void>;
  protected abstract onDispose(): void;
}

/** Proxy the shell to a runtime the gateway already owns. */
export class PassthroughRendererClient extends RendererClient {
  private readonly pendingRequests = new Map<string, string | number>();
  private readonly onNotify = (message: any) =>
    this.notify(message.method, message.params);
  private readonly onServerRequest = (message: any): boolean => {
    if (this.closed || this.socket.readyState !== WebSocket.OPEN) return false;
    const key = randomUUID();
    this.pendingRequests.set(key, message.id);
    this.send({ id: `sr:${key}`, method: message.method, params: message.params });
    return true;
  };
  constructor(
    service: SessionService,
    backendId: string,
    socket: WebSocket,
    private readonly connection: AppServerConnection,
  ) {
    super(service, backendId, socket);
    connection.on("notification", this.onNotify);
    let handlers = service.requestHandlers.get(backendId);
    if (!handlers) {
      handlers = new Set();
      service.requestHandlers.set(backendId, handlers);
    }
    handlers.add(this.onServerRequest);
  }
  protected async onRequest(
    _id: string | number,
    method: string,
    params: any,
  ): Promise<unknown> {
    if (method === "initialize") {
      await this.connection.connect();
      return this.connection.initializeResult ?? {};
    }
    await this.connection.connect();
    return this.connection.request(method, params);
  }
  protected async onNotification(): Promise<void> {
    /* `initialized` and client notifications need no runtime action. */
  }
  protected async onResponse(
    id: string | number,
    result: any,
    error: any,
  ): Promise<void> {
    if (typeof id !== "string" || !id.startsWith("sr:")) return;
    const runtimeId = this.pendingRequests.get(id.slice(3));
    if (runtimeId === undefined) return;
    this.pendingRequests.delete(id.slice(3));
    if (error)
      this.connection.respondError(runtimeId, {
        code: typeof error.code === "number" ? error.code : -32603,
        message: String(error.message ?? "Rejected by renderer"),
      });
    else this.connection.respond(runtimeId, result ?? null);
  }
  protected onDispose(): void {
    this.connection.off("notification", this.onNotify);
    this.service.requestHandlers.get(this.backendId)?.delete(this.onServerRequest);
    for (const runtimeId of this.pendingRequests.values())
      this.connection.rejectRequest(runtimeId);
    this.pendingRequests.clear();
  }
}

type TrackedThread = {
  sessionId: string;
  projected: any | null;
  running: boolean;
  approvals: Set<string>;
};

/** Serve the renderer's app-server needs from Desktop-backed gateway sessions. */
export class DesktopRendererClient extends RendererClient {
  private readonly threads = new Map<string, TrackedThread>();
  private readonly connectionId = randomUUID();
  private readonly onSession = (sessionId: string) => this.syncSession(sessionId);
  private account: any = null;
  constructor(
    service: SessionService,
    backendId: string,
    socket: WebSocket,
    private readonly connection: DesktopConnection,
  ) {
    super(service, backendId, socket);
    service.on("session", this.onSession);
  }
  protected onDispose(): void {
    this.service.off("session", this.onSession);
    this.threads.clear();
  }
  protected async onNotification(): Promise<void> {}

  private clientCommandId(id: string | number, kind: string): string {
    return (
      "renderer-" +
      createHash("sha256")
        .update(`${this.connectionId}:${kind}:${String(id)}`)
        .digest("hex")
        .slice(0, 48)
    );
  }
  private async readAccount(includeToken: boolean): Promise<any> {
    try {
      const result = await this.connection.request("account/read", {
        includeToken,
      });
      if (result && typeof result === "object") {
        this.account = { ...this.account, ...result };
        return result;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "Desktop account/read failed";
      throw new RpcError(
        `Windows Codex Desktop account unavailable: ${message}. Upgrade the bridge if account/read is unsupported, or sign in on Desktop.`,
        -32002,
      );
    }
    if (this.account) return this.account;
    throw new RpcError("Windows Codex Desktop returned no account identity", -32002);
  }

  protected async onRequest(
    id: string | number,
    method: string,
    params: any,
  ): Promise<unknown> {
    const p = params && typeof params === "object" ? params : {};
    switch (method) {
      case "initialize": {
        const account = await this.readAccount(false).catch(() => null);
        return {
          userAgent: `Codex Web Gateway/1.0 (Windows Codex Desktop ${this.connection.info?.desktop?.version ?? "unknown"})`,
          codexHome:
            typeof account?.codexHome === "string"
              ? account.codexHome
              : this.service.backend(this.backendId).cwd,
          platformFamily: "windows",
          platformOs: "windows",
        };
      }
      case "ping":
        return {};
      case "getAuthStatus": {
        const account = await this.readAccount(p.includeToken === true);
        return {
          authMethod:
            account.account?.type === "chatgpt"
              ? "chatgpt"
              : account.account?.type === "apiKey"
                ? "apikey"
                : null,
          authToken:
            typeof account.authToken === "string" ? account.authToken : null,
          requiresOpenaiAuth: account.requiresOpenaiAuth !== false,
        };
      }
      case "account/read": {
        const account = await this.readAccount(false);
        return {
          account: account.account ?? null,
          requiresOpenaiAuth: account.requiresOpenaiAuth !== false,
        };
      }
      case "account/login/start":
        throw new RpcError(
          "Sign in on the Windows Codex Desktop; the gateway uses the Desktop's account",
          -32601,
        );
      case "config/read":
        return defaultConfig(this.knownModel());
      case "config/batchWrite":
      case "config/value/write":
        return {
          status: "ok",
          version: null,
          filePath: null,
          overriddenMetadata: null,
        };
      case "configRequirements/read":
        return { requirements: null };
      case "model/list":
        return defaultModelList(this.knownModels());
      case "modelProvider/capabilities/read":
        return { capabilities: {} };
      case "experimentalFeature/list":
      case "app/list":
      case "mcpServerStatus/list":
      case "hooks/list":
      case "interactive/liveSessions/list":
      case "interactive/sessionSandbox/list":
        return EMPTY_PAGE;
      case "experimentalFeature/enablement/set":
        return { enablement: p.enablement ?? {} };
      case "skills/list":
        return { data: [] };
      case "plugin/list":
        return { marketplaces: [], marketplaceLoadErrors: [], featuredPluginIds: [] };
      case "plugin/installed":
        return { marketplaces: [] };
      case "permissionProfile/list":
        return PERMISSION_PROFILES;
      case "collaborationMode/list":
        return COLLABORATION_MODES;
      case "remoteControl/status/read":
        return {
          status: "disabled",
          serverName: "Windows Codex Desktop",
          installationId: null,
          environmentId: null,
        };
      case "windowsSandbox/readiness":
        return { status: "unavailable" };
      case "thread/list":
        return this.listThreads(p);
      case "chatgpt/list":
        return this.listThreads({ ...p, conversationKind: "chatgpt" });
      case "chatgpt/read": {
        const id = typeof p.conversationId === "string" ? p.conversationId : p.threadId;
        if (!id) throw new RpcError("conversationId is required", -32602);
        const session = await this.importConversation(id, "chatgpt");
        return { conversation: session.nativeConversation ?? session.thread, conversationId: id };
      }
      case "chatgpt/send": {
        const conversationId = typeof p.conversationId === "string" ? p.conversationId : p.threadId;
        if (!conversationId) throw new RpcError("conversationId is required", -32602);
        const session = await this.importConversation(conversationId, "chatgpt");
        const { conversationId: _conversationId, threadId: _threadId, ...sendParams } = p;
        const command = this.service.submit(session.id, { clientCommandId: this.clientCommandId(id, method), method: "chatgpt/send", params: sendParams });
        const done = await this.waitForCommand(command);
        if (done.state !== "accepted") throw new RpcError(commandError(done).message, commandError(done).code);
        return done.result ?? {};
      }
      case "thread/read":
        return { thread: await this.readThread(p.threadId, p.includeTurns !== false) };
      case "thread/resume":
        return { thread: await this.readThread(p.threadId, true) };
      case "thread/turns/list": {
        const thread = await this.readThread(p.threadId, true);
        return { data: thread.turns, nextCursor: null, backwardsCursor: null };
      }
      case "thread/unsubscribe":
        if (typeof p.threadId === "string") this.threads.delete(p.threadId);
        return {};
      case "thread/start":
      case "thread/fork":
        throw new RpcError(
          "Windows Codex Desktop does not create conversations remotely. Start the conversation in Desktop, then open it here.",
          -32601,
        );
      case "fs/getMetadata": {
        // The shell checks project roots with this before it lists them.
        if (typeof p.path !== "string")
          throw new RpcError("path is required", -32602);
        const result = await this.service.desktopFileMetadata(this.backendId, [p.path]);
        const entry = result?.entries?.[0];
        if (!entry || entry.missing)
          throw new RpcError(`No such file or directory: ${p.path}`, -32602);
        return {
          isDirectory: entry.isDirectory === true,
          isFile: entry.isFile === true,
          isSymlink: entry.isSymlink === true,
          size: entry.size ?? 0,
          createdAtMs: entry.createdAtMs ?? 0,
          modifiedAtMs: entry.modifiedAtMs ?? 0,
        };
      }
      case "turn/start":
        return this.submitTurn(id, "turn/start", p);
      case "turn/steer":
        return this.submitTurn(id, "turn/steer", p);
      case "turn/interrupt":
        return this.submitTurn(id, "turn/interrupt", p);
      default:
        throw new RpcError(
          `${method} is not available for a Windows Codex Desktop backend`,
          -32601,
        );
    }
  }

  private knownModel(): string | null {
    for (const tracked of this.threads.values())
      if (typeof tracked.projected?.model === "string")
        return tracked.projected.model;
    return null;
  }
  private knownModels(): string[] {
    const ids = new Set<string>();
    for (const tracked of this.threads.values())
      if (typeof tracked.projected?.model === "string")
        ids.add(tracked.projected.model);
    return [...ids];
  }

  private async listThreads(p: any): Promise<any> {
    const kind = p.conversationKind === "chatgpt" ? "chatgpt" : "codex";
    const backend = this.service.backend(this.backendId);
    const listed = await this.service.listThreads(this.backendId, kind, p.cursor);
    const rows: any[] = Array.isArray(listed?.data) ? listed.data : [];
    const data = rows
      .filter((row) => typeof row?.id === "string")
      .map((row) => {
        const session = this.service.store.findThread(this.backendId, row.id);
        const name =
          (typeof row.name === "string" && row.name !== row.id ? row.name : "") ||
          (session && session.title !== "New conversation" ? session.title : "") ||
          "";
        return kind === "chatgpt"
          ? { id: row.id, conversationId: row.id, title: row.name ?? row.id, conversationKind: kind, preview: row.name ?? row.id }
          : this.toThread(
          row.id,
          session ?? null,
          { name, cwd: session?.cwd ?? backend.cwd },
          false,
            );
      });
    return { data, nextCursor: listed?.nextCursor ?? null, backwardsCursor: listed?.backwardsCursor ?? null };
  }

  private async importConversation(id: string, kind: "chatgpt" | "codex"): Promise<Session> {
    const existing = this.service.store.findThread(this.backendId, id);
    if (existing) { await this.service.attachSession(existing.id); return this.service.store.get(existing.id); }
    const command = this.service.create({ clientCommandId: `renderer-import-${randomUUID()}`, backendId: this.backendId, conversationId: id, conversationKind: kind });
    const done = await this.waitForCommand(command);
    if (done.state !== "accepted") throw new RpcError(commandError(done).message, commandError(done).code);
    return this.service.store.get(command.sessionId);
  }

  private async importThread(threadId: string): Promise<Session> {
    const existing = this.service.store.findThread(this.backendId, threadId);
    if (existing) {
      await this.service.attachSession(existing.id);
      return this.service.store.get(existing.id);
    }
    const command = this.service.create({
      clientCommandId: `renderer-import-${randomUUID()}`,
      backendId: this.backendId,
      threadId,
    });
    const done = await this.waitForCommand(command);
    if (done.state !== "accepted") throw new RpcError(commandError(done).message, commandError(done).code);
    return this.service.store.get(command.sessionId);
  }
  private async readThread(threadId: unknown, includeTurns: boolean): Promise<any> {
    if (typeof threadId !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(threadId))
      throw new RpcError("Invalid thread ID", -32602);
    const session = await this.importThread(threadId);
    let tracked = this.threads.get(threadId);
    if (!tracked) {
      tracked = {
        sessionId: session.id,
        projected: null,
        running: false,
        approvals: new Set(),
      };
      this.threads.set(threadId, tracked);
    }
    const thread = this.toThread(threadId, session, {}, includeTurns);
    tracked.projected = session.thread;
    tracked.running = session.status === "running";
    this.publishApprovals(session, tracked);
    return thread;
  }

  private toThread(
    threadId: string,
    session: Session | null,
    overrides: { name?: string; cwd?: string },
    includeTurns: boolean,
  ): any {
    const projected = session?.thread ?? null;
    const running = session?.status === "running";
    const name =
      overrides.name ||
      (typeof projected?.name === "string" ? projected.name : "") ||
      (session && session.title !== "New conversation" ? session.title : "") ||
      "";
    const turns = includeTurns
      ? (projected?.turns ?? []).map((turn: any) =>
          this.toTurn(turn, projected?.cwd ?? session?.cwd ?? overrides.cwd),
        )
      : [];
    const firstText = turns
      .flatMap((t: any) => t.items)
      .find((i: any) => i.type === "userMessage")
      ?.content?.find((c: any) => c.type === "text")?.text;
    const preview = name || (typeof firstText === "string" ? firstText : "");
    return {
      id: threadId,
      extra: null,
      sessionId: threadId,
      forkedFromId: null,
      parentThreadId: null,
      preview: typeof preview === "string" ? preview.slice(0, 200) : "",
      ephemeral: false,
      section: null,
      sectionEnteredAt: null,
      projectId: null,
      // Legacy history: the renderer reads the whole conversation with
      // thread/read instead of paging through app-server cursors the
      // Desktop follower snapshot does not have.
      historyMode: "legacy",
      modelProvider: "openai",
      model: projected?.model ?? null,
      reasoningEffort: projected?.reasoningEffort ?? null,
      createdAt: seconds(projected?.createdAt ?? session?.updatedAt),
      updatedAt: seconds(projected?.updatedAt ?? session?.updatedAt),
      recencyAt: seconds(projected?.updatedAt ?? session?.updatedAt),
      status: session
        ? running
          ? { type: "active", activeFlags: [] }
          : { type: "idle" }
        : { type: "notLoaded" },
      path: "",
      cwd: projected?.cwd ?? session?.cwd ?? overrides.cwd ?? "",
      cliVersion: "",
      source: "vscode",
      canAcceptDirectInput: null,
      threadSource: null,
      agentNickname: null,
      agentRole: null,
      gitInfo: null,
      name,
      turns,
    };
  }
  private toTurn(turn: any, cwd: string | undefined): any {
    return {
      id: turn.id,
      itemsView: "full",
      status: turn.status ?? "completed",
      error: turn.error ?? null,
      startedAt: turn.startedAt ?? null,
      completedAt: turn.completedAt ?? null,
      durationMs: turn.durationMs ?? null,
      items: (turn.items ?? []).map((item: any) => this.toItem(item, cwd)),
    };
  }
  private toItem(item: any, cwd: string | undefined): any {
    if (item.type === "userMessage")
      return { clientId: null, ...item };
    if (item.type === "agentMessage")
      return {
        phase: "final_answer",
        memoryCitation: null,
        delivery: null,
        questions: null,
        ...item,
        text: typeof item.text === "string" ? item.text : "",
      };
    if (item.type === "commandExecution")
      return {
        cwd: cwd ?? "",
        parsedCmd: [],
        commandActions: [],
        exitCode: null,
        durationMs: null,
        source: "agent",
        processId: null,
        aggregatedOutput: "",
        status: "completed",
        ...item,
      };
    if (item.type === "fileChange")
      return { changes: [], status: "completed", ...item };
    if (item.type === "mcpToolCall")
      return {
        server: "",
        tool: "",
        arguments: null,
        result: null,
        error: null,
        durationMs: null,
        status: "completed",
        ...item,
      };
    return item;
  }

  private stageInput(sessionId: string, input: unknown): Promise<any[]> {
    if (!Array.isArray(input)) return Promise.resolve([]);
    return Promise.all(
      input.map(async (item: any) => {
        if (item?.type === "text" && typeof item.text === "string")
          return { type: "text", text: item.text };
        if (item?.type === "localImage" && typeof item.path === "string")
          return { type: "localImage", path: item.path };
        if (item?.type === "image" && typeof item.url === "string") {
          const match = DATA_URL.exec(item.url);
          if (!match) throw new RpcError("Unsupported image input", -32602);
          const extension = match[1]!.split("/")[1];
          const staged = await this.service.desktopUpload(
            this.backendId,
            sessionId,
            { name: `pasted.${extension === "jpeg" ? "jpg" : extension}`, data: match[2]! },
          );
          return { type: "localImage", path: staged.path };
        }
        throw new RpcError("Unsupported input item", -32602);
      }),
    );
  }
  private async submitTurn(
    id: string | number,
    method: "turn/start" | "turn/steer" | "turn/interrupt",
    p: any,
  ): Promise<any> {
    const session = await this.importThread(p.threadId);
    const tracked = this.threads.get(p.threadId);
    if (!tracked) await this.readThread(p.threadId, true);
    let params: any;
    if (method === "turn/interrupt") {
      const active = session.thread?.turns?.find(
        (t: any) => t.status === "inProgress",
      );
      params = { turnId: p.turnId ?? active?.id };
      if (typeof params.turnId !== "string")
        throw new RpcError("No turn is running", -32600);
    } else {
      params = { input: await this.stageInput(session.id, p.input) };
      if (method === "turn/start" && typeof p.model === "string")
        params.model = p.model;
      if (method === "turn/steer") {
        const active = session.thread?.turns?.find(
          (t: any) => t.status === "inProgress",
        );
        params.expectedTurnId = p.expectedTurnId ?? active?.id;
      }
    }
    const command = this.service.submit(session.id, {
      clientCommandId: this.clientCommandId(id, method),
      method,
      params,
    });
    const done = await this.waitForCommand(command);
    if (done.state !== "accepted") {
      const error = commandError(done);
      throw new RpcError(error.message, error.code);
    }
    if (method === "turn/interrupt") return {};
    const latest = this.service.store.get(session.id);
    const turn =
      done.result?.turn ??
      latest.thread?.turns?.find((t: any) => t.status === "inProgress") ??
      latest.thread?.turns?.at(-1);
    if (!turn) throw new RpcError("Desktop did not report the started turn", -32603);
    return { turn: this.toTurn(turn, latest.cwd) };
  }
  private waitForCommand(command: Command): Promise<Command> {
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (value: Command) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.service.off("session", onSession);
        resolve(value);
      };
      const check = () => {
        const current = this.service.store.command(command.id);
        if (current && TERMINAL_COMMAND_STATES.has(current.state)) finish(current);
      };
      const onSession = (sessionId: string) => {
        if (sessionId === command.sessionId) check();
      };
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        this.service.off("session", onSession);
        reject(
          new DeliveryUnknownError(
            "Timed out waiting for the Desktop acknowledgement; reconcile before resubmitting",
          ),
        );
      }, COMMAND_TIMEOUT_MS);
      timer.unref();
      this.service.on("session", onSession);
      check();
    });
  }

  protected async onResponse(
    id: string | number,
    result: any,
    error: any,
  ): Promise<void> {
    if (typeof id !== "string") return;
    const approval = this.service.store.approval(id);
    if (!approval) return;
    if (error) {
      // The renderer declined to answer (for example it closed the request);
      // the request stays owned by Desktop.
      return;
    }
    try {
      await this.service.answer(id, result);
    } catch {
      /* Already answered elsewhere or stale; nothing to relay. */
    }
  }

  private syncSession(sessionId: string): void {
    for (const [threadId, tracked] of this.threads)
      if (tracked.sessionId === sessionId) {
        let session: Session;
        try {
          session = this.service.store.get(sessionId);
        } catch {
          return;
        }
        this.emitThreadChanges(threadId, tracked, session);
        this.publishApprovals(session, tracked);
      }
  }
  private publishApprovals(session: Session, tracked: TrackedThread): void {
    for (const approval of this.service.store.approvals(session.id)) {
      if (approval.state !== "pending" || tracked.approvals.has(approval.id))
        continue;
      if (
        ![
          "item/commandExecution/requestApproval",
          "item/fileChange/requestApproval",
          "item/tool/requestUserInput",
        ].includes(approval.method)
      )
        continue;
      tracked.approvals.add(approval.id);
      this.send({ id: approval.id, method: approval.method, params: approval.params });
    }
  }
  private emitThreadChanges(
    threadId: string,
    tracked: TrackedThread,
    session: Session,
  ): void {
    const next = session.thread;
    const previous = tracked.projected;
    tracked.projected = next;
    if (!next) return;
    const cwd = next.cwd ?? session.cwd;
    const previousTurns = new Map<string, any>(
      (previous?.turns ?? []).map((t: any) => [t.id, t]),
    );
    for (const turn of next.turns ?? []) {
      const before = previousTurns.get(turn.id);
      const converted = this.toTurn(turn, cwd);
      const inProgress = turn.status === "inProgress";
      if (!before) {
        this.notify("turn/started", {
          threadId,
          turn: { ...converted, items: [] },
        });
        for (const item of converted.items)
          this.emitItem(threadId, turn.id, null, item, inProgress);
        if (!inProgress)
          this.notify("turn/completed", { threadId, turn: converted });
        continue;
      }
      const beforeItems = new Map<string, any>(
        (before.items ?? []).map((i: any) => [i.id, this.toItem(i, cwd)]),
      );
      const finishing = before.status === "inProgress" && !inProgress;
      for (const item of converted.items)
        this.emitItem(
          threadId,
          turn.id,
          beforeItems.get(item.id) ?? null,
          item,
          inProgress,
          finishing,
        );
      if (finishing)
        this.notify("turn/completed", { threadId, turn: converted });
    }
    const running = session.status === "running";
    if (running !== tracked.running) {
      tracked.running = running;
      this.notify("thread/status/changed", {
        threadId,
        status: running ? { type: "active", activeFlags: [] } : { type: "idle" },
      });
    }
  }
  private emitItem(
    threadId: string,
    turnId: string,
    before: any,
    item: any,
    turnInProgress: boolean,
    finishing = false,
  ): void {
    const terminal = this.isTerminal(item, turnInProgress);
    if (!before) {
      this.notify("item/started", { threadId, turnId, item });
      if (terminal) this.notify("item/completed", { threadId, turnId, item });
      return;
    }
    if (JSON.stringify(before) === JSON.stringify(item)) {
      // A turn that just finished settles every streamed item.
      if (finishing) this.notify("item/completed", { threadId, turnId, item });
      return;
    }
    if (
      item.type === "agentMessage" &&
      typeof before.text === "string" &&
      typeof item.text === "string" &&
      item.text.startsWith(before.text) &&
      !terminal
    ) {
      this.notify("item/agentMessage/delta", {
        threadId,
        turnId,
        itemId: item.id,
        delta: item.text.slice(before.text.length),
      });
      return;
    }
    if (
      item.type === "commandExecution" &&
      typeof before.aggregatedOutput === "string" &&
      typeof item.aggregatedOutput === "string" &&
      item.aggregatedOutput.startsWith(before.aggregatedOutput) &&
      item.status === before.status &&
      item.status === "inProgress"
    ) {
      this.notify("item/commandExecution/outputDelta", {
        threadId,
        turnId,
        itemId: item.id,
        delta: item.aggregatedOutput.slice(before.aggregatedOutput.length),
      });
      return;
    }
    this.notify(terminal ? "item/completed" : "item/started", {
      threadId,
      turnId,
      item,
    });
  }
  private isTerminal(item: any, turnInProgress: boolean): boolean {
    if (item.type === "userMessage") return true;
    if (item.type === "agentMessage") return !turnInProgress;
    if (typeof item.status === "string") return item.status !== "inProgress";
    return !turnInProgress;
  }
}

/** Hand an authenticated renderer socket to the adapter for its backend. */
export function attachRendererClient(
  service: SessionService,
  backendId: string,
  socket: WebSocket,
): PassthroughRendererClient | DesktopRendererClient {
  const connection = service.connections.get(backendId);
  if (!connection) throw new Error("Backend not found");
  if (connection instanceof DesktopConnection)
    return new DesktopRendererClient(service, backendId, socket, connection);
  return new PassthroughRendererClient(
    service,
    backendId,
    socket,
    connection as AppServerConnection,
  );
}
