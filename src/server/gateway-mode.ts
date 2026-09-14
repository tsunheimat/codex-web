import { Readable } from "node:stream";
import { MCP_REQUEST_CHANNEL } from "./mcp-request-path-sanitizer";
import type { WorkspaceFileAuthority } from "./workspace-files";

/**
 * Gateway mode points the original Desktop renderer's shell at a codex-web
 * gateway backend instead of a local `codex app-server`. The shell keeps the
 * Desktop UI; the gateway keeps session ownership; the Windows bridge keeps
 * the running Desktop as the execution host.
 */
export type GatewayMode = {
  /** Gateway origin, for example https://codex.example.com */
  url: URL;
  token: string;
  backendId: string;
};

const BACKEND_ID = /^[a-zA-Z0-9_-]{1,64}$/;
const TURN_METHODS = new Set(["turn/start", "turn/steer"]);
const MAX_STAGED_IMAGE_BYTES = 5 * 1024 * 1024;
const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp"]);
const GLOBAL_STATE_TTL_MS = 10_000;
const GLOBAL_STATE_REQUEST_URL = "vscode://codex/get-global-state";
const RESPONSE_CHANNEL = "codex_desktop:message-for-view";
/** Keys where Desktop's sidebar bookkeeping is overlaid on the local store. */
const OBJECT_KEYS = new Set([
  "local-projects",
  "thread-projectless-output-directories",
  "thread-project-assignments",
  "thread-workspace-root-hints",
]);
const LIST_KEYS = new Set([
  "projectless-thread-ids",
  "project-order",
  "pinned-project-ids",
  "pinned-thread-ids",
]);

export function readGatewayMode(env: NodeJS.ProcessEnv): GatewayMode | null {
  const raw = env.CODEX_WEB_GATEWAY_URL?.trim();
  if (!raw) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("CODEX_WEB_GATEWAY_URL must be an absolute http(s) URL");
  }
  if (!["http:", "https:"].includes(url.protocol))
    throw new Error("CODEX_WEB_GATEWAY_URL must use http or https");
  if (url.username || url.password || url.search || url.hash)
    throw new Error(
      "CODEX_WEB_GATEWAY_URL must not contain credentials, a query or a fragment",
    );
  const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
  const inCluster = env.CODEX_WEB_GATEWAY_ALLOW_PLAIN_HTTP === "true";
  if (url.protocol === "http:" && !loopback && !inCluster)
    throw new Error(
      "CODEX_WEB_GATEWAY_URL must use https unless it is loopback or CODEX_WEB_GATEWAY_ALLOW_PLAIN_HTTP=true for a private cluster network",
    );
  const token = env.CODEX_WEB_GATEWAY_TOKEN ?? "";
  if (token.length < 32)
    throw new Error(
      "CODEX_WEB_GATEWAY_TOKEN must be the gateway access token (at least 32 characters)",
    );
  const backendId = env.CODEX_WEB_GATEWAY_BACKEND?.trim() ?? "";
  if (!BACKEND_ID.test(backendId))
    throw new Error("CODEX_WEB_GATEWAY_BACKEND must name a configured backend");
  url.pathname = url.pathname.replace(/\/$/, "");
  return { url, token, backendId };
}

function apiUrl(mode: GatewayMode, route: string): URL {
  // A root pathname is "/", so strip it to avoid a protocol-relative "//api".
  const prefix = mode.url.pathname.replace(/\/$/, "");
  return new URL(`${prefix}${route}`, mode.url);
}

export function appServerWebSocketUrl(mode: GatewayMode): string {
  const url = apiUrl(mode, `/api/v1/backends/${mode.backendId}/app-server`);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}

/**
 * Configure the Desktop shell's environment before the bundle loads. The
 * shell honours CODEX_APP_SERVER_WS_URL for its local host and the patched
 * transport adds the Authorization header from the companion variable.
 */
export function configureShellEnvironment(
  mode: GatewayMode,
  env: NodeJS.ProcessEnv,
): void {
  env.CODEX_APP_SERVER_WS_URL = appServerWebSocketUrl(mode);
  env.CODEX_APP_SERVER_WS_AUTHORIZATION = `Bearer ${mode.token}`;
  env.CODEX_WEB_RUNTIME_OWNERSHIP = "external";
  delete env.CODEX_APP_SERVER_FORCE_CLI;
}

export class GatewayFileClient {
  constructor(
    private readonly mode: GatewayMode,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}
  private headers(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.mode.token}`,
      "Content-Type": "application/json",
    };
  }
  /** Stage an image on the Desktop host for a thread the renderer opened. */
  async stageImage(
    threadId: string,
    name: string,
    bytes: Buffer,
  ): Promise<{ path: string }> {
    const response = await this.fetchImpl(
      apiUrl(this.mode, `/api/v1/backends/${this.mode.backendId}/uploads`),
      {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify({
          name,
          data: bytes.toString("base64"),
          threadId,
        }),
        signal: AbortSignal.timeout(60_000),
      },
    );
    const body: any = await response.json().catch(() => ({}));
    if (!response.ok || typeof body?.path !== "string")
      throw new Error(
        typeof body?.error === "string"
          ? body.error
          : `Gateway upload failed (${response.status})`,
      );
    return { path: body.path };
  }
  private globalStateCache: { at: number; values: Promise<Record<string, unknown>> } | null = null;
  /**
   * Sidebar bookkeeping the Desktop keeps (projects, projectless threads,
   * pins). Cached briefly: the renderer asks for each key separately.
   */
  readGlobalState(): Promise<Record<string, unknown>> {
    const now = Date.now();
    if (this.globalStateCache && now - this.globalStateCache.at < GLOBAL_STATE_TTL_MS)
      return this.globalStateCache.values;
    const values = (async () => {
      const response = await this.fetchImpl(
        apiUrl(this.mode, `/api/v1/backends/${this.mode.backendId}/global-state`),
        {
          headers: { Authorization: `Bearer ${this.mode.token}` },
          signal: AbortSignal.timeout(15_000),
        },
      );
      if (!response.ok) throw new Error(`Gateway global state failed (${response.status})`);
      const body: any = await response.json();
      return body?.values && typeof body.values === "object" ? body.values : {};
    })();
    this.globalStateCache = { at: now, values };
    values.catch(() => {
      // Let the next read retry instead of serving a rejected promise.
      if (this.globalStateCache?.values === values) this.globalStateCache = null;
    });
    return values;
  }
  /** Read an image shown by a Desktop conversation. */
  async readImage(
    filePath: string,
  ): Promise<{ contentType: string; bytes: Buffer } | null> {
    const url = apiUrl(
      this.mode,
      `/api/v1/backends/${this.mode.backendId}/files/image`,
    );
    url.searchParams.set("path", filePath);
    const response = await this.fetchImpl(url, {
      headers: { Authorization: `Bearer ${this.mode.token}` },
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) return null;
    const contentType = response.headers.get("content-type") ?? "";
    if (!contentType.startsWith("image/")) return null;
    return { contentType, bytes: Buffer.from(await response.arrayBuffer()) };
  }
}

async function readBounded(stream: Readable, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of stream) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > limit) {
      stream.destroy();
      throw new Error("Image exceeds the 5 MiB Desktop upload limit");
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

/** Looks like a Windows drive or UNC path rather than a compat-server path. */
export function isWindowsPath(value: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(value) || value.startsWith("\\\\");
}

/**
 * Before a turn is forwarded to the shell, copy every renderer-local image
 * (file picker uploads and clipboard pastes) to the Desktop host and rewrite
 * the input item to the staged Windows path.
 */
export async function stageRendererImages(
  message: { channel: string; args: unknown[] },
  authority: Pick<WorkspaceFileAuthority, "openAllowedFile">,
  client: GatewayFileClient,
): Promise<void> {
  if (message.channel !== MCP_REQUEST_CHANNEL || message.args.length !== 1)
    return;
  const envelope = message.args[0] as any;
  if (envelope?.type !== "mcp-request") return;
  const request = envelope.request;
  if (
    !request ||
    typeof request !== "object" ||
    !TURN_METHODS.has(request.method) ||
    !Array.isArray(request.params?.input)
  )
    return;
  const threadId = request.params.threadId;
  if (typeof threadId !== "string") return;
  for (const item of request.params.input) {
    if (item?.type !== "localImage" || typeof item.path !== "string") continue;
    if (isWindowsPath(item.path)) continue;
    const extension = item.path.slice(item.path.lastIndexOf(".")).toLowerCase();
    if (!IMAGE_EXTENSIONS.has(extension))
      throw new Error("Only PNG, JPEG, GIF or WebP images can be sent to Desktop");
    const file = await authority.openAllowedFile(item.path);
    const bytes = await readBounded(file.stream, MAX_STAGED_IMAGE_BYTES);
    const staged = await client.stageImage(threadId, file.downloadName, bytes);
    item.path = staged.path;
  }
}

/**
 * Combine the local shell's value for a sidebar key with the Desktop's. The
 * local value wins for entries both hold so pins and reorders made here stick;
 * everything Desktop knows and this shell does not is added.
 */
export function mergeGlobalStateValue(
  key: string,
  local: unknown,
  desktop: unknown,
): unknown {
  if (OBJECT_KEYS.has(key)) {
    const base = desktop && typeof desktop === "object" && !Array.isArray(desktop) ? desktop : {};
    const own = local && typeof local === "object" && !Array.isArray(local) ? local : {};
    if (!Object.keys(base).length) return local;
    return { ...base, ...own };
  }
  if (LIST_KEYS.has(key)) {
    const extra = Array.isArray(desktop) ? desktop : [];
    if (!extra.length) return local;
    const own = Array.isArray(local) ? local : [];
    return [...own, ...extra.filter((v) => !own.includes(v))];
  }
  return local;
}

type RendererInvoke = { type: string; requestId?: string; channel?: string; args?: unknown[] };
type MainEvent = { type: string; channel?: string; args?: unknown[] };

/**
 * The renderer places threads in the sidebar from global state the shell
 * stores locally. In gateway mode the threads live on the Desktop, so answer
 * those reads with the Desktop's projects and projectless threads merged in.
 */
export class GatewayGlobalStateOverlay {
  private readonly pending = new Map<string, { key: string; at: number }>();
  constructor(private readonly client: Pick<GatewayFileClient, "readGlobalState">) {}
  /** Note a renderer host request for one of the overlaid keys. */
  observeInvoke(message: RendererInvoke): void {
    if (message.channel !== MCP_REQUEST_CHANNEL || message.args?.length !== 1) return;
    const envelope = message.args[0] as any;
    if (
      envelope?.type !== "fetch" ||
      envelope.url !== GLOBAL_STATE_REQUEST_URL ||
      typeof envelope.requestId !== "string"
    )
      return;
    let key: unknown;
    try {
      key = JSON.parse(envelope.body ?? "{}")?.key;
    } catch {
      return;
    }
    if (typeof key !== "string" || !(OBJECT_KEYS.has(key) || LIST_KEYS.has(key))) return;
    const now = Date.now();
    for (const [id, entry] of this.pending)
      if (now - entry.at > 60_000) this.pending.delete(id);
    this.pending.set(envelope.requestId, { key, at: now });
    // Warm the cache so the response can usually be answered immediately.
    void this.client.readGlobalState().catch(() => {});
  }
  /** Whether this shell event answers a tracked global-state request. */
  claims(message: MainEvent): boolean {
    if (message.type !== "ipc-main-event" || message.channel !== RESPONSE_CHANNEL) return false;
    const response = message.args?.[0] as any;
    return (
      response?.type === "fetch-response" &&
      typeof response.requestId === "string" &&
      this.pending.has(response.requestId)
    );
  }
  /** Return the event with the Desktop's value merged into the shell's answer. */
  async rewrite<T extends MainEvent>(message: T): Promise<T> {
    const response = (message.args as any[])[0];
    const entry = this.pending.get(response.requestId);
    this.pending.delete(response.requestId);
    if (!entry || response.responseType !== "success" || typeof response.bodyJsonString !== "string")
      return message;
    let body: any;
    try {
      body = JSON.parse(response.bodyJsonString);
    } catch {
      return message;
    }
    let desktop: Record<string, unknown>;
    try {
      desktop = await this.client.readGlobalState();
    } catch {
      return message;
    }
    if (!Object.hasOwn(desktop, entry.key)) return message;
    const merged = mergeGlobalStateValue(entry.key, body?.value, desktop[entry.key]);
    if (merged === body?.value) return message;
    return {
      ...message,
      args: [{ ...response, bodyJsonString: JSON.stringify({ ...body, value: merged }) }],
    };
  }
}
