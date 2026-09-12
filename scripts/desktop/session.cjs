const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { randomUUID } = require("node:crypto");
const { EventEmitter } = require("node:events");
const { DesktopError } = require("./ipc.cjs");

const BAD_KEYS = new Set(["__proto__", "prototype", "constructor"]);
const ID = /^[a-zA-Z0-9_-]{1,128}$/;
function approvalId(threadId, owner, requestId) {
  return `${threadId}:${owner}:${requestId}`;
}
function validId(id) {
  if (typeof id !== "string" || !ID.test(id))
    throw new DesktopError("INVALID_INPUT", "Invalid conversation identity");
  return id;
}
function applyPatches(state, patches) {
  const next = structuredClone(state);
  for (const patch of patches) {
    if (
      !Array.isArray(patch.path) ||
      !patch.path.length ||
      patch.path.some((k) => BAD_KEYS.has(String(k)))
    )
      throw new Error("Invalid patch path");
    let parent = next;
    for (const key of patch.path.slice(0, -1)) {
      if (!parent || !Object.hasOwn(parent, key))
        throw new Error("Missing patch parent");
      parent = parent[key];
    }
    const key = patch.path.at(-1);
    if (!parent || typeof parent !== "object")
      throw new Error("Invalid patch parent");
    if (Array.isArray(parent)) {
      if (
        !Number.isInteger(key) ||
        key < 0 ||
        key > parent.length ||
        (patch.op !== "add" && key === parent.length)
      )
        throw new Error("Invalid patch index");
      if (patch.op === "add") parent.splice(key, 0, patch.value);
      else if (patch.op === "remove") parent.splice(key, 1);
      else if (patch.op === "replace") parent[key] = patch.value;
      else throw new Error("Unknown patch operation");
    } else if (patch.op === "remove") delete parent[key];
    else if (patch.op === "replace" || patch.op === "add")
      parent[key] = patch.value;
    else throw new Error("Unknown patch operation");
  }
  return next;
}
function orderedTurns(state) {
  const h = state.turnHistory?.history,
    result = [],
    seen = new Set();
  const append = (turn) => {
    const id = turn?.turnId ?? turn?.id;
    if (id && !seen.has(id)) {
      seen.add(id);
      result.push(turn);
    }
  };
  for (const island of h?.islands ?? [])
    for (const entry of island.entries ?? []) {
      const entity = h.entitiesByKey?.[entry.value];
      // Live turns use tail:<generation>:local:<uuid> keys in this Desktop build.
      if (
        entity &&
        (entity.turnId || String(entry.value).startsWith("turn:")) &&
        Array.isArray(entity.items)
      )
        append(entity);
    }
  if (!result.length)
    for (const [key, value] of Object.entries(h?.entitiesByKey ?? {}))
      if (
        (value?.turnId || key.startsWith("turn:")) &&
        Array.isArray(value?.items)
      )
        append(value);
  for (const turn of state.turns ?? []) append(turn);
  return result;
}
function projectThread(id, state) {
  let historyTruncated = false;
  const clip = (value) => {
    if (typeof value !== "string") return value;
    if (value.length <= 20000) return value;
    historyTruncated = true;
    return value.slice(0, 20000) + "…";
  };
  const turns = orderedTurns(state).map((turn) => {
    const turnId = turn.turnId ?? turn.id;
    const items = (turn.items ?? []).flatMap((item) => {
      if (
        ![
          "agentMessage",
          "userMessage",
          "commandExecution",
          "fileChange",
          "mcpToolCall",
          "imageGeneration",
          "webSearch",
        ].includes(item.type)
      )
        return [];
      // Do not send opaque runtime settings, credentials, or hidden model context.
      if (item.type === "agentMessage")
        return [{ id: item.id, type: item.type, text: clip(item.text ?? "") }];
      if (item.type === "userMessage")
        return [
          {
            id: item.id,
            type: item.type,
            content: (item.content ?? [])
              .filter((v) => v.type === "text")
              .map((v) => ({ type: "text", text: clip(v.text) })),
          },
        ];
      return [
        {
          id: item.id,
          type: item.type,
          status: item.status,
          ...(item.type === "commandExecution"
            ? {
                command: clip(item.command),
                aggregatedOutput: clip(item.aggregatedOutput),
              }
            : {}),
          ...(item.type === "mcpToolCall"
            ? { server: item.server, tool: item.tool }
            : {}),
        },
      ];
    });
    if (!items.some((i) => i.type === "userMessage") && turn.params?.input)
      items.unshift({
        id: "user-" + turnId,
        type: "userMessage",
        content: turn.params.input
          .filter((i) => i.type === "text")
          .map((i) => ({ type: "text", text: clip(i.text) })),
      });
    return { id: turnId, status: turn.status, items };
  });
  const retained = [];
  let bytes = 0;
  for (const turn of turns.reverse()) {
    let length = Buffer.byteLength(JSON.stringify(turn));
    while (length > 5 * 1024 * 1024 && turn.items.length > 1) {
      turn.items.shift();
      historyTruncated = true;
      length = Buffer.byteLength(JSON.stringify(turn));
    }
    if (bytes + length > 6 * 1024 * 1024) {
      historyTruncated = true;
      break;
    }
    bytes += length;
    retained.unshift(turn);
  }
  return {
    id,
    name: state.title ?? state.generatedTitle ?? "",
    cwd: state.cwd,
    turns: retained,
    historyTruncated,
    historyComplete:
      !historyTruncated &&
      (state.turnHistory?.history?.isComplete ??
        state.turnsPagination?.hasLoadedOldest ??
        false),
  };
}

class DesktopSession extends EventEmitter {
  constructor(
    ipc,
    {
      codexHome = process.env.CODEX_HOME || path.join(os.homedir(), ".codex"),
      uploadRoot = path.join(
        os.homedir(),
        ".codex",
        "codex-web-desktop-uploads",
      ),
      nativeTools = null,
    } = {},
  ) {
    super();
    this.ipc = ipc;
    this.codexHome = codexHome;
    this.uploadRoot = uploadRoot;
    this.nativeTools = nativeTools;
    this.followed = new Map();
    this.chatgpt = new Map();
    this.recovering = new Map();
    this.uploads = new Map();
    ipc.on("broadcast", (m) => this.onBroadcast(m));
    ipc.on("disconnected", () => {
      for (const entry of this.followed.values()) entry.owner = null;
    });
  }
  async owner(id) {
    const response = await this.ipc.request("thread-owner-discovery", {
      hostId: "local",
      conversationId: validId(id),
    });
    if (!response.handledByClientId)
      throw new DesktopError(
        "OWNER_UNAVAILABLE",
        "No Desktop owner was found; open this conversation in Desktop and reconnect",
      );
    return response.handledByClientId;
  }
  async attach(id) {
    validId(id);
    await this.ipc.connect();
    if (this.recovering.has(id)) return this.recovering.get(id);
    const task = (async () => {
      const owner = await this.owner(id);
      const entry = this.followed.get(id) ?? {
        state: null,
        revision: -1,
        requests: new Map(),
      };
      if (entry.owner !== owner) {
        if (entry.owner) this.emit("unavailable", id);
        entry.revision = -1;
        entry.requests.clear();
      }
      entry.owner = owner;
      this.followed.set(id, entry);
      let cleanupSnapshot;
      const snapshot = new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          this.off("snapshot", onSnapshot);
          reject(
            new DesktopError(
              "SNAPSHOT_TIMEOUT",
              "Desktop owner did not provide a snapshot; open the conversation in Desktop and reconnect",
            ),
          );
        }, 15000);
        const onSnapshot = (threadId) => {
          if (threadId === id) {
            clearTimeout(timer);
            this.off("snapshot", onSnapshot);
            resolve();
          }
        };
        const disconnected = () =>
          reject(
            new DesktopError(
              "IPC_DISCONNECTED",
              "Desktop disconnected while loading history",
            ),
          );
        this.on("snapshot", onSnapshot);
        this.ipc.once("disconnected", disconnected);
        cleanupSnapshot = () => {
          clearTimeout(timer);
          this.off("snapshot", onSnapshot);
          this.ipc.off("disconnected", disconnected);
        };
      });
      try {
        this.ipc.broadcast(
          "thread-stream-following-changed",
          { conversationId: id, hostId: "local", following: true },
          [owner],
        );
        // Re-announcing an existing subscription may be a no-op. This read-only
        // handler explicitly hydrates and publishes the owner's snapshot.
        await Promise.all([
          snapshot,
          this.ipc.request(
            "thread-follower-load-complete-history",
            { conversationId: id },
            owner,
          ),
        ]);
      } finally {
        cleanupSnapshot();
      }
      if (this.nativeTools && !this.nativeTools.originThreadId)
        this.nativeTools.originThreadId = id;
      return { thread: projectThread(id, entry.state) };
    })();
    this.recovering.set(id, task);
    try {
      return await task;
    } finally {
      this.recovering.delete(id);
    }
  }
  onBroadcast(message) {
    const p = message.params ?? {},
      id = p.conversationId,
      entry = this.followed.get(id);
    if (
      message.method === "thread-stream-following-status-requested" &&
      entry &&
      p.hostId === "local"
    ) {
      this.ipc.broadcast(
        "thread-stream-following-changed",
        { conversationId: id, hostId: "local", following: true },
        [message.sourceClientId],
      );
      return;
    }
    if (
      message.method === "client-status-changed" &&
      p.status === "disconnected"
    ) {
      for (const [id, entry] of this.followed)
        if (entry.owner === p.clientId) {
          entry.owner = null;
          this.emit("unavailable", id);
        }
      return;
    }
    if (
      message.method !== "thread-stream-state-changed" ||
      !entry ||
      p.hostId !== "local" ||
      message.sourceClientId !== entry.owner
    )
      return;
    const change = p.change;
    if (change?.type === "snapshot") {
      if (change.revision < entry.revision) return;
      entry.state = change.conversationState;
      entry.revision = change.revision;
    } else if (
      change?.type === "patches" &&
      entry.state &&
      change.baseRevision === entry.revision
    ) {
      try {
        entry.state = applyPatches(entry.state, change.patches);
        entry.revision = change.revision;
      } catch {
        this.resync(id);
        return;
      }
    } else {
      this.resync(id);
      return;
    }
    if (change.type === "snapshot") this.emit("snapshot", id);
    this.emit("notification", {
      method: "desktop/snapshot",
      params: {
        threadId: id,
        thread: projectThread(id, entry.state),
        revision: entry.revision,
      },
    });
    const pending = new Map();
    for (const request of entry.state.requests ?? []) {
      if (request.completed === true) continue;
      if (
        ![
          "item/commandExecution/requestApproval",
          "item/fileChange/requestApproval",
          "item/tool/requestUserInput",
        ].includes(request.method)
      )
        continue;
      pending.set(String(request.id), request);
      if (!entry.requests.has(String(request.id)))
        this.emit("request", {
          id: approvalId(id, entry.owner, request.id),
          method: request.method,
          params: { ...request.params, threadId: id },
        });
    }
    for (const requestId of entry.requests.keys())
      if (!pending.has(requestId))
        this.emit("notification", {
          method: "serverRequest/resolved",
          params: {
            threadId: id,
            requestId: approvalId(id, entry.owner, requestId),
          },
        });
    entry.requests = pending;
  }
  resync(id) {
    if (!this.recovering.has(id))
      void this.attach(id).catch(() => this.emit("unavailable", id));
  }
  async list() {
    let lines = [];
    try {
      lines = (
        await fs.readFile(
          path.join(this.codexHome, "session_index.jsonl"),
          "utf8",
        )
      )
        .trim()
        .split("\n")
        .slice(-100)
        .reverse();
    } catch {}
    const candidates = [...this.followed.keys()];
    const titles = new Map();
    for (const line of lines) {
      try {
        const row = JSON.parse(line);
        if (ID.test(row.id)) {
          candidates.push(row.id);
          titles.set(row.id, row.thread_name);
        }
      } catch {}
    }
    const data = [];
    for (const id of [...new Set(candidates)].slice(0, 30)) {
      try {
        await this.owner(id);
        data.push({
          id,
          name: titles.get(id) ?? id,
          conversationKind: "codex",
        });
      } catch {}
    }
    return { data, nextCursor: null };
  }
  async read(id) {
    const entry = this.followed.get(id);
    if (!entry?.owner) return this.attach(id);
    // The owner hydrates history and broadcasts its authoritative revision.
    const reply = await this.ipc.request(
      "thread-follower-load-complete-history",
      { conversationId: id },
      entry.owner,
    );
    const revision = reply.result?.revision;
    if (revision != null && entry.revision < revision) return this.attach(id);
    return { thread: projectThread(id, entry.state) };
  }
  async turn(action, params) {
    const id = validId(params.threadId),
      entry = this.followed.get(id);
    if (!entry?.owner)
      throw new DesktopError(
        "OWNER_UNAVAILABLE",
        "Desktop ownership changed; reconcile the conversation before submitting",
      );
    if ((await this.owner(id)) !== entry.owner)
      throw new DesktopError(
        "OWNER_CHANGED",
        "Desktop ownership changed; reconcile before submitting",
      );
    let method, payload;
    if (action === "interrupt") {
      method = "thread-follower-interrupt-turn";
      payload = {
        conversationId: id,
        mode: "user-stop",
        expectedTurnId: validId(params.turnId),
      };
    } else {
      if (
        !Array.isArray(params.input) ||
        !params.input.length ||
        params.input.length > 32
      )
        throw new DesktopError(
          "INVALID_INPUT",
          "Provide text or uploaded image input",
        );
      const input = params.input.map((value) => {
        if (
          value.type === "text" &&
          typeof value.text === "string" &&
          value.text.length <= 200000
        )
          return { type: "text", text: value.text, text_elements: [] };
        if (value.type === "localImage" && this.uploads.has(value.path))
          return { type: "localImage", path: value.path };
        throw new DesktopError(
          "INVALID_INPUT",
          "Images must be uploaded through this bridge; arbitrary host paths are not accepted",
        );
      });
      if (action === "start") {
        method = "thread-follower-start-turn";
        const request = {
          threadId: id,
          input,
          ...(typeof params.model === "string" ? { model: params.model } : {}),
        };
        payload = {
          conversationId: id,
          turnStart: { request, context: { inheritThreadSettings: true } },
        };
      } else if (action === "steer") {
        const active = orderedTurns(entry.state).find(
          (t) => t.status === "inProgress",
        );
        if ((active?.turnId ?? active?.id) !== params.expectedTurnId)
          throw new DesktopError(
            "TURN_CHANGED",
            "The active Desktop turn changed; reconcile before steering",
          );
        method = "thread-follower-steer-turn";
        payload = { conversationId: id, input };
      } else throw new DesktopError("UNSUPPORTED", "Unknown turn action");
    }
    const reply = await this.ipc.request(method, payload, entry.owner);
    return reply.result?.result ?? reply.result;
  }
  async answer(id, result) {
    const split = id.indexOf(":"),
      threadId = id.slice(0, split),
      ownerEnd = id.indexOf(":", split + 1),
      approvalOwner = id.slice(split + 1, ownerEnd),
      requestId = id.slice(ownerEnd + 1);
    const entry = this.followed.get(threadId),
      request = entry?.requests.get(requestId);
    if (!request || !entry.owner || entry.owner !== approvalOwner)
      throw new DesktopError(
        "STALE_APPROVAL",
        "Desktop approval is no longer pending",
      );
    if ((await this.owner(threadId)) !== entry.owner)
      throw new DesktopError(
        "OWNER_CHANGED",
        "Approval owner changed; reconcile before answering",
      );
    const names = {
      "item/commandExecution/requestApproval":
        "thread-follower-command-approval-decision",
      "item/fileChange/requestApproval":
        "thread-follower-file-approval-decision",
      "item/tool/requestUserInput": "thread-follower-submit-user-input",
    };
    const payload = { conversationId: threadId, requestId: request.id };
    if (request.method === "item/tool/requestUserInput") {
      if (
        !result?.answers ||
        typeof result.answers !== "object" ||
        Array.isArray(result.answers)
      )
        throw new DesktopError("INVALID_INPUT", "Provide answers");
      payload.response = { answers: result.answers };
    } else {
      if (!["accept", "decline", "cancel"].includes(result?.decision))
        throw new DesktopError(
          "INVALID_INPUT",
          "Choose an offered approval decision",
        );
      if (
        request.params?.availableDecisions &&
        !request.params.availableDecisions.includes(result.decision)
      )
        throw new DesktopError(
          "INVALID_INPUT",
          "Decision was not offered by Desktop",
        );
      payload.decision = result.decision;
    }
    const reply = await this.ipc.request(
      names[request.method],
      payload,
      entry.owner,
    );
    return reply.result;
  }
  upload(params) {
    const work = (this.uploadTail ?? Promise.resolve()).then(() =>
      this.storeUpload(params),
    );
    this.uploadTail = work.catch(() => {});
    return work;
  }
  async storeUpload({ name, data }) {
    if (
      typeof name !== "string" ||
      name.length > 255 ||
      !/\.(png|jpe?g|gif|webp)$/i.test(name) ||
      typeof data !== "string" ||
      data.length > 7 * 1024 * 1024 ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
        data,
      )
    )
      throw new DesktopError(
        "INVALID_INPUT",
        "Upload a PNG, JPEG, GIF or WebP image up to 5 MiB",
      );
    const bytes = Buffer.from(data, "base64");
    if (!bytes.length || bytes.length > 5 * 1024 * 1024)
      throw new DesktopError("INVALID_INPUT", "Image exceeds 5 MiB");
    await fs.mkdir(this.uploadRoot, { recursive: true, mode: 0o700 });
    const root = await fs.lstat(this.uploadRoot);
    if (!root.isDirectory() || root.isSymbolicLink())
      throw new DesktopError(
        "UPLOAD_ROOT",
        "The bridge upload directory must be a regular directory",
      );
    const files = await fs.readdir(this.uploadRoot);
    const sizes = await Promise.all(
      files.map(
        async (name) => (await fs.lstat(path.join(this.uploadRoot, name))).size,
      ),
    );
    if (sizes.reduce((a, b) => a + b, 0) + bytes.length > 100 * 1024 * 1024)
      throw new DesktopError(
        "UPLOAD_QUOTA",
        "Desktop bridge upload quota (100 MiB) reached; remove unneeded staged files on Windows",
      );
    const filename = path.join(
      this.uploadRoot,
      randomUUID() + path.extname(name).toLowerCase(),
    );
    await fs.writeFile(filename, bytes, { flag: "wx", mode: 0o600 });
    this.uploads.set(filename, Date.now());
    return { path: filename, name: path.basename(name), size: bytes.length };
  }
  close() {
    this.ipc.close();
  }
}
module.exports = {
  approvalId,
  DesktopSession,
  validId,
  applyPatches,
  projectThread,
  orderedTurns,
};
