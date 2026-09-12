#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { createHash } = require("node:crypto");
const { WebSocket } = require("ws");
const { DatabaseSync } = require("node:sqlite");
const { DesktopIpc, DesktopError } = require("./desktop/ipc.cjs");
const { discoverDesktop } = require("./desktop/discovery.cjs");
const {
  DesktopSession,
  approvalId,
  validId,
  projectThread,
} = require("./desktop/session.cjs");
const {
  discoverNativeTools,
  NativeTools,
} = require("./desktop/native-tools.cjs");

const MUTATIONS = new Set([
  "desktop/turn/start",
  "desktop/turn/steer",
  "desktop/turn/interrupt",
  "desktop/approval/respond",
  "desktop/upload",
  "desktop/chatgpt/send",
]);
const METHODS = new Set([
  ...MUTATIONS,
  "desktop/list",
  "desktop/attach",
  "desktop/read",
  "desktop/chatgpt/list",
  "desktop/chatgpt/read",
]);
const NATIVE_GAPS = {
  chatgptAttachments:
    "uploadChatGptConversationFile -> createChatGptFile (/files) -> uploadChatGptFileBytes -> processChatGptFileUploadStream (/files/process_upload_stream) runs in the Desktop renderer. Neither codex-ipc nor the app-tools catalog exposes this upload operation.",
  computerUse:
    "Desktop Computer Use is dispatched through its renderer/app-host services and the local computer-use helper. The follower bus and app-tools catalog expose no remote Computer Use session/control subscription. Continue Computer Use approvals and presentation in Desktop.",
};
class CommandJournal {
  constructor(filename) {
    if (filename !== ":memory:")
      fs.mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(filename);
    this.db.exec(
      "PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS commands (id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, reply TEXT); UPDATE commands SET reply='{" +
        '"error":{"message":"Bridge restarted before acknowledgement; reconcile before submitting again","deliveryUnknown":true}' +
        "}' WHERE reply IS NULL;",
    );
  }
  async run(message, action) {
    if (!MUTATIONS.has(message.method)) return action();
    const fingerprint = createHash("sha256")
      .update(JSON.stringify([message.method, message.params]))
      .digest("hex");
    const old = this.db
      .prepare("SELECT fingerprint,reply FROM commands WHERE id=?")
      .get(message.id);
    if (old) {
      if (old.fingerprint !== fingerprint)
        throw new DesktopError(
          "COMMAND_CONFLICT",
          "Command ID was used for different input",
        );
      if (old.reply == null)
        throw new DesktopError(
          "COMMAND_UNKNOWN",
          "Command is already dispatching; reconcile before submitting again",
          true,
        );
      const reply = JSON.parse(old.reply);
      if (reply.error)
        throw Object.assign(new Error(reply.error.message), reply.error);
      return reply.result;
    }
    this.db
      .prepare("INSERT INTO commands VALUES (?,?,NULL)")
      .run(message.id, fingerprint);
    try {
      const result = await action();
      this.db
        .prepare("UPDATE commands SET reply=? WHERE id=?")
        .run(JSON.stringify({ result: result ?? null }), message.id);
      return result;
    } catch (error) {
      this.db.prepare("UPDATE commands SET reply=? WHERE id=?").run(
        JSON.stringify({
          error: {
            message: error.message,
            deliveryUnknown: error.deliveryUnknown === true,
          },
        }),
        message.id,
      );
      throw error;
    }
  }
  close() {
    this.db.close();
  }
}
function gatewayUrl(value) {
  const url = new URL(value);
  if (
    !["wss:", "ws:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.protocol === "ws:" &&
      !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname))
  )
    throw new Error(
      "Use an authenticated wss:// gateway URL; ws:// is allowed only for loopback verification",
    );
  url.pathname = url.pathname.replace(/\/$/, "") + "/api/v1/desktop";
  return url;
}
function nativeRows(result) {
  return [...(result.pinnedThreads ?? []), ...(result.threads ?? [])];
}
function nativeIdentity(row) {
  return row.threadId ?? row.id;
}
function isChatGpt(row) {
  return row.kind === "chatgpt" || row.backingKind === "chatgpt";
}
function projectNative(id, result) {
  // Preserve native identity and the native read result; do not invent Codex turn IDs.
  return {
    conversationId: id,
    conversationKind: "chatgpt",
    conversation: result,
  };
}
class DesktopBridge {
  constructor({
    session,
    info,
    url,
    backendId,
    token,
    journal,
    retryMs = 1000,
    tlsCa,
    rediscover,
  }) {
    Object.assign(this, {
      session,
      info,
      url,
      backendId,
      token,
      journal,
      retryMs,
      tlsCa,
      rediscover,
    });
    this.socket = null;
    this.stopped = false;
    this.ready = false;
    this.inflight = 0;
    this.session.on("notification", (message) => this.send(message));
    this.session.on("request", (message) => this.send(message));
    this.session.on("unavailable", (threadId) =>
      this.send({ method: "desktop/unavailable", params: { threadId } }),
    );
    this.session.ipc.on("disconnected", () => {
      this.send({ method: "desktop/connection", params: { available: false } });
      this.reconnectDesktop();
    });
    this.session.ipc.on("versionMismatch", () => this.session.ipc.close());
  }
  capabilities() {
    return {
      codex: true,
      chatgpt: !!this.session.nativeTools?.originThreadId,
      attachments: true,
      chatgptAttachments: false,
      computerUse: false,
      nativeChatgptText: !!this.session.nativeTools?.originThreadId,
      terminal: false,
      files: false,
      remoteControl: false,
      createConversation: false,
      gaps: NATIVE_GAPS,
    };
  }
  start() {
    this.open();
    this.nativePoll = setInterval(() => void this.refreshNative(), 3000);
  }
  async refreshNative() {
    if (this.stopped || this.pollingNative || !this.session.nativeTools) return;
    this.pollingNative = true;
    try {
      for (const id of [...this.session.chatgpt.keys()].slice(0, 8)) {
        if (this.stopped) break;
        try {
          const conversation = await this.native().call("read_thread", {
            threadId: id,
            turnLimit: 10,
            includeOutputs: false,
            maxOutputCharsPerItem: 20000,
          });
          if (conversation?.thread?.kind !== "chatgpt") continue;
          const digest = createHash("sha256")
            .update(JSON.stringify(conversation))
            .digest("hex");
          if (this.session.chatgpt.get(id) !== digest) {
            this.session.chatgpt.set(id, digest);
            this.send({
              method: "desktop/chatgpt/snapshot",
              params: projectNative(id, conversation),
            });
          }
        } catch {
          /* Native Desktop retains the active completion. Reconcile on the next read. */
        }
      }
    } finally {
      this.pollingNative = false;
    }
  }
  open() {
    if (this.stopped) return;
    const socket = new WebSocket(this.url, {
      handshakeTimeout: 15000,
      maxPayload: 8 * 1024 * 1024,
      perMessageDeflate: false,
      followRedirects: false,
      ...(this.tlsCa ? { ca: this.tlsCa } : {}),
    });
    this.socket = socket;
    this.ready = false;
    let alive = true;
    const heartbeat = setInterval(() => {
      if (!alive) socket.terminate();
      else if (socket.readyState === WebSocket.OPEN) {
        alive = false;
        socket.ping();
      }
    }, 15000);
    socket.on("pong", () => {
      alive = true;
    });
    socket.on("open", () =>
      socket.send(
        JSON.stringify({
          type: "desktop-authenticate",
          version: 1,
          backendId: this.backendId,
          token: this.token,
          desktop: {
            version: this.info.version,
            packageVersion: this.info.packageVersion,
          },
          capabilities: this.capabilities(),
        }),
      ),
    );
    socket.on("message", async (raw, binary) => {
      if (socket !== this.socket) return;
      let message;
      try {
        if (binary) throw new Error();
        message = JSON.parse(String(raw));
      } catch {
        socket.close(1008, "Invalid bridge frame");
        return;
      }
      if (message.type === "desktop-ready") {
        this.ready = true;
        if (!this.session.ipc.clientId)
          this.send({
            method: "desktop/connection",
            params: { available: false },
          });
        for (const [threadId, entry] of this.session.followed)
          if (entry.owner && entry.state) {
            this.send({
              method: "desktop/snapshot",
              params: {
                threadId,
                thread: projectThread(threadId, entry.state),
              },
            });
            for (const request of entry.requests.values())
              this.send({
                id: approvalId(threadId, entry.owner, request.id),
                method: request.method,
                params: { ...request.params, threadId },
              });
          }
        return;
      }
      if (
        !this.ready ||
        typeof message.id !== "string" ||
        !/^[\w-]{1,128}$/.test(message.id) ||
        !METHODS.has(message.method) ||
        this.inflight >= 32
      ) {
        if (message.id)
          socket.send(
            JSON.stringify({
              id: message.id,
              error: {
                message: "Unsupported bridge request or capacity exceeded",
              },
            }),
          );
        return;
      }
      this.inflight++;
      try {
        const result = await this.journal.run(message, () =>
          this.dispatch(message.method, message.params ?? {}),
        );
        if (this.socket === socket)
          this.send({ id: message.id, result: result ?? null });
      } catch (error) {
        if (this.socket === socket)
          this.send({
            id: message.id,
            error: {
              message: error.message,
              code: error.code,
              deliveryUnknown: error.deliveryUnknown === true,
            },
          });
      } finally {
        this.inflight--;
      }
    });
    socket.on("error", () => {});
    socket.on("close", (code) => {
      clearInterval(heartbeat);
      if (this.socket !== socket) return;
      this.ready = false;
      this.socket = null;
      if (code === 1008) {
        console.error(
          "Desktop bridge authentication/configuration rejected; check the backend ID, protocol and agent token",
        );
        return;
      }
      if (!this.stopped)
        this.retry = setTimeout(
          () => this.open(),
          this.retryMs + Math.random() * 500,
        );
    });
  }
  send(message) {
    if (!this.ready || this.socket?.readyState !== WebSocket.OPEN) return;
    const raw = JSON.stringify(message);
    if (
      Buffer.byteLength(raw) > 8 * 1024 * 1024 ||
      this.socket.bufferedAmount > 8 * 1024 * 1024
    ) {
      this.socket.close(1013, "Reconcile after reconnect");
      return;
    }
    this.socket.send(raw);
  }
  async dispatch(method, p) {
    if (!p || typeof p !== "object" || Array.isArray(p))
      throw new DesktopError("INVALID_INPUT", "Invalid Desktop parameters");
    switch (method) {
      case "desktop/list":
        return this.session.list();
      case "desktop/attach":
        return this.session.attach(validId(p.threadId));
      case "desktop/read":
        return this.session.read(validId(p.threadId));
      case "desktop/turn/start":
        return this.session.turn("start", p);
      case "desktop/turn/steer":
        return this.session.turn("steer", p);
      case "desktop/turn/interrupt":
        return this.session.turn("interrupt", p);
      case "desktop/approval/respond":
        return this.session.answer(String(p.requestId), p.result);
      case "desktop/upload":
        return this.session.upload(p);
      case "desktop/chatgpt/list": {
        const result = await this.native().call("list_threads", { limit: 50 });
        return {
          data: nativeRows(result)
            .filter(isChatGpt)
            .map((row) => ({
              id: nativeIdentity(row),
              name: row.title,
              conversationKind: "chatgpt",
            })),
          nextCursor: null,
        };
      }
      case "desktop/chatgpt/read": {
        const id = validId(p.conversationId);
        if (!this.session.chatgpt.has(id)) {
          const catalog = await this.native().call("list_threads", {
            limit: 50,
          });
          if (
            !nativeRows(catalog).some(
              (row) => isChatGpt(row) && nativeIdentity(row) === id,
            )
          )
            throw new DesktopError(
              "NATIVE_IDENTITY",
              "Select a native ChatGPT conversation returned by Desktop; Codex thread IDs are not interchangeable",
            );
          if (this.session.chatgpt.size >= 8)
            throw new DesktopError(
              "CAPACITY",
              "This bridge supports eight attached native ChatGPT conversations",
            );
        }
        const result = await this.native().call("read_thread", {
          threadId: id,
          turnLimit: 10,
          includeOutputs: false,
          maxOutputCharsPerItem: 20000,
          ...(p.cursor ? { cursor: String(p.cursor) } : {}),
        });
        if (result?.thread?.kind !== "chatgpt" || result.thread.id !== id)
          throw new DesktopError(
            "NATIVE_IDENTITY",
            "Desktop resolved this ID to a different conversation kind; native ChatGPT requests cannot target a Codex thread",
          );
        if (!p.cursor)
          this.session.chatgpt.set(
            id,
            createHash("sha256").update(JSON.stringify(result)).digest("hex"),
          );
        return projectNative(id, result);
      }
      case "desktop/chatgpt/send": {
        const id = validId(p.conversationId);
        if (!this.session.chatgpt.has(id))
          throw new DesktopError(
            "NATIVE_IDENTITY",
            "Attach and reconcile the native ChatGPT conversation first",
          );
        if (
          typeof p.prompt !== "string" ||
          !p.prompt.trim() ||
          p.prompt.length > 200000 ||
          Object.keys(p).some((k) => !["conversationId", "prompt"].includes(k))
        )
          throw new DesktopError(
            "INVALID_INPUT",
            "Native ChatGPT currently accepts text only. " +
              NATIVE_GAPS.chatgptAttachments,
          );
        const target = await this.native().call("read_thread", {
          threadId: id,
          turnLimit: 1,
          includeOutputs: false,
          maxOutputCharsPerItem: 0,
        });
        if (target?.thread?.kind !== "chatgpt" || target.thread.id !== id)
          throw new DesktopError(
            "NATIVE_IDENTITY",
            "Desktop no longer resolves this ID to a native ChatGPT conversation",
          );
        if (target.thread.status?.type === "active")
          throw new DesktopError(
            "NATIVE_BUSY",
            "This native ChatGPT conversation is already responding",
          );
        return this.native().call("send_message_to_thread", {
          threadId: id,
          prompt: p.prompt,
        });
      }
      default:
        throw new DesktopError("UNSUPPORTED", "Unsupported Desktop operation");
    }
  }
  native() {
    if (!this.session.nativeTools)
      throw new DesktopError(
        "NATIVE_INTERFACE",
        "Desktop app-tools pipe with list_threads/read_thread/send_message_to_thread was not found",
      );
    return this.session.nativeTools;
  }
  reconnectDesktop() {
    if (this.localRetry || this.stopped) return;
    this.localRetry = setTimeout(async () => {
      this.localRetry = null;
      try {
        if (this.rediscover) await this.rediscover();
        await this.session.ipc.connect();
        for (const id of this.session.followed.keys())
          await this.session.attach(id).catch(() => {});
        this.send({
          method: "desktop/connection",
          params: { available: true, desktopVersion: this.info.version },
        });
      } catch (error) {
        console.error(`Desktop reconnection: ${error.message}`);
        this.reconnectDesktop();
      }
    }, 3000);
  }
  async close() {
    this.stopped = true;
    clearTimeout(this.retry);
    clearTimeout(this.localRetry);
    clearInterval(this.nativePoll);
    this.socket?.close(1000);
    this.session.close();
    while (this.inflight || this.pollingNative)
      await new Promise((resolve) => setTimeout(resolve, 25));
    this.journal.close();
  }
}
async function main() {
  const args = process.argv.slice(2),
    options = {};
  for (let i = 0; i < args.length; i += 2) {
    if (
      !["--gateway", "--backend", "--token-env", "--state"].includes(args[i]) ||
      !args[i + 1]
    )
      throw new Error(
        "Usage: codex-web-desktop-bridge --gateway wss://gateway.example --backend windows-desktop [--token-env CODEX_WEB_DESKTOP_AGENT_TOKEN] [--state absolute.sqlite]",
      );
    options[args[i]] = args[i + 1];
  }
  const token =
    process.env[options["--token-env"] ?? "CODEX_WEB_DESKTOP_AGENT_TOKEN"];
  if (!token || token.length < 32)
    throw new Error(
      "Set the Desktop agent token environment variable to at least 32 characters",
    );
  validId(options["--backend"]);
  const url = gatewayUrl(options["--gateway"]);
  const info = await discoverDesktop(),
    ipc = new DesktopIpc(info);
  await ipc.connect();
  let launched = false;
  try {
    const native = await discoverNativeTools();
    const session = new DesktopSession(ipc, {
      nativeTools: native
        ? new NativeTools(
            native.endpoint,
            process.env.CODEX_WEB_DESKTOP_CONTEXT_THREAD ??
              process.env.CODEX_THREAD_ID,
          )
        : null,
    });
    if (session.nativeTools && !session.nativeTools.originThreadId) {
      const rows = await session.list();
      if (rows.data[0]) session.nativeTools.originThreadId = rows.data[0].id;
    }
    const journal = new CommandJournal(
      options["--state"] ??
        path.join(
          os.homedir(),
          ".codex",
          "codex-web-desktop",
          options["--backend"] + ".sqlite",
        ),
    );
    const bridge = new DesktopBridge({
      session,
      info,
      url,
      backendId: options["--backend"],
      token,
      journal,
      rediscover: async () => {
        const next = await discoverDesktop();
        Object.assign(info, next);
        ipc.versions = next.versions;
        ipc.endpoint = next.endpoint;
        const tools = await discoverNativeTools();
        session.nativeTools = tools
          ? new NativeTools(tools.endpoint, session.nativeTools?.originThreadId)
          : null;
      },
    });
    console.log(
      `Attached to Codex Desktop ${info.version} (Windows package ${info.packageVersion ?? "unpackaged"}) at ${info.endpoint}`,
    );
    bridge.start();
    launched = true;
    for (const signal of ["SIGINT", "SIGTERM"])
      process.once(signal, () => void bridge.close());
  } finally {
    if (!launched) ipc.close();
  }
}
if (require.main === module)
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
module.exports = {
  DesktopBridge,
  CommandJournal,
  gatewayUrl,
  nativeRows,
  isChatGpt,
  NATIVE_GAPS,
};
