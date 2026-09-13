export type BackendSummary = {
  id: string;
  label: string;
  cwd: string;
  transport: string;
  connected: boolean;
  runtimeOwnership: string;
  desktop?: { version: string; packageVersion?: string };
  capabilities: {
    codex: boolean;
    files: boolean;
    terminal: boolean;
    chatgpt: boolean;
    computerUse: boolean;
    remoteControl: boolean;
    attachments?: boolean;
    chatgptAttachments?: boolean;
    createConversation?: boolean;
  };
};

export class GatewayRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "GatewayRequestError";
  }
}

/** Shared by the independently deployed web app and bundled mobile shell. */
export class GatewayClient extends EventTarget {
  readonly base: URL;
  private socket: WebSocket | null = null;
  private retry: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  private delay = 500;
  private selected: { sessionId: string; afterSeq: number } | null = null;
  constructor(
    baseUrl: string,
    private readonly token: string,
  ) {
    super();
    this.base = new URL(baseUrl);
    if (
      !["https:", "http:"].includes(this.base.protocol) ||
      this.base.username ||
      this.base.password ||
      this.base.hash ||
      this.base.search
    )
      throw new Error("Enter an HTTP(S) server URL without credentials");
    if (
      this.base.protocol === "http:" &&
      !["localhost", "127.0.0.1", "[::1]"].includes(this.base.hostname)
    )
      throw new Error("Use HTTPS for a remote gateway");
    this.base.pathname = this.base.pathname.replace(/\/$/, "") + "/";
  }
  url(route: string): URL {
    return new URL(route.replace(/^\//, ""), this.base);
  }
  async request<T = any>(route: string, body?: unknown): Promise<T> {
    const response = await fetch(this.url(route), {
      method: body === undefined ? "GET" : "POST",
      headers: {
        Authorization: `Bearer ${this.token}`,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(45_000),
    });
    if (!response.ok) {
      const problem = await response.json().catch(() => null);
      throw new GatewayRequestError(
        problem?.error ?? `Server returned ${response.status}`,
        response.status,
      );
    }
    return response.json();
  }
  async login(): Promise<void> {
    const info = await this.request("api/v1");
    if (info.protocolVersion !== 1)
      throw new Error("This server uses an incompatible session protocol");
  }
  start(): void {
    this.connect();
  }
  private emit(type: string, detail: any): void {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }
  private connect(): void {
    if (this.stopped) return;
    const url = this.url("api/v1/events");
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    const socket = new WebSocket(url);
    this.socket = socket;
    const timeout = setTimeout(() => socket.close(), 10_000);
    socket.onopen = () =>
      socket.send(
        JSON.stringify({ type: "authenticate", version: 1, token: this.token }),
      );
    socket.onmessage = (event) => {
      if (socket !== this.socket) return;
      let message: any;
      try {
        message = JSON.parse(event.data);
      } catch {
        socket.close();
        return;
      }
      if (message.type === "ready") {
        clearTimeout(timeout);
        this.delay = 500;
        this.emit("connection", true);
        if (this.selected)
          socket.send(JSON.stringify({ type: "subscribe", ...this.selected }));
      }
      if (message.type === "sync") {
        if (!this.selected || this.selected.sessionId !== message.snapshot.id)
          return;
        this.selected.afterSeq = message.lastSeq;
      }
      this.emit("message", message);
    };
    socket.onclose = (event) => {
      clearTimeout(timeout);
      if (socket !== this.socket) return;
      this.emit("connection", false);
      if (event.code === 1008) {
        this.emit("error", "Connection authorization expired. Sign in again.");
        return;
      }
      if (this.stopped) return;
      this.retry = setTimeout(
        () => this.connect(),
        this.delay + Math.random() * 250,
      );
      this.delay = Math.min(this.delay * 2, 15_000);
    };
    socket.onerror = () => {}; // Close drives recovery; commands are never replayed here.
  }
  subscribe(sessionId: string, afterSeq = 0): void {
    this.selected = { sessionId, afterSeq };
    if (this.socket?.readyState === WebSocket.OPEN)
      this.socket.send(JSON.stringify({ type: "subscribe", ...this.selected }));
  }
  unsubscribe(): void {
    this.selected = null;
    if (this.socket?.readyState === WebSocket.OPEN)
      this.socket.send(JSON.stringify({ type: "unsubscribe" }));
  }
  terminal(
    backendId: string,
    cols: number,
    rows: number,
    sessionId?: string | null,
  ): WebSocket {
    const url = this.url("api/v1/terminal");
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    const socket = new WebSocket(url);
    socket.addEventListener("open", () =>
      socket.send(
        JSON.stringify({
          type: "authenticate",
          version: 1,
          token: this.token,
          backendId,
          ...(sessionId ? { sessionId } : {}),
          cols,
          rows,
        }),
      ),
    );
    return socket;
  }
  async upload(
    backendId: string,
    file: File,
    sessionId?: string | null,
    uploadId = crypto.randomUUID(),
  ): Promise<any> {
    if (file.size > 10 * 1024 * 1024)
      throw new Error("Maximum attachment size is 10 MiB");
    const data = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(new Error("Cannot read file"));
      reader.onload = () => resolve(String(reader.result).split(",")[1]!);
      reader.readAsDataURL(file);
    });
    return this.request(
      `api/v1/backends/${encodeURIComponent(backendId)}/uploads`,
      { name: file.name, data, uploadId, ...(sessionId ? { sessionId } : {}) },
    );
  }
  async download(
    backendId: string,
    path: string,
    sessionId?: string | null,
  ): Promise<Blob> {
    const url = this.url(
      `api/v1/backends/${encodeURIComponent(backendId)}/download`,
    );
    url.searchParams.set("path", path);
    if (sessionId) url.searchParams.set("sessionId", sessionId);
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${this.token}` },
    });
    if (!response.ok) throw new Error("Download failed");
    return response.blob();
  }
  close(): void {
    this.stopped = true;
    if (this.retry) clearTimeout(this.retry);
    this.socket?.close();
    this.socket = null;
  }
}
