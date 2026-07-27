import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { HttpsProxyAgent } from "https-proxy-agent";
import { getProxyForUrl } from "proxy-from-env";
import { WebSocket, WebSocketServer, type RawData } from "ws";

export const CHATGPT_PUBSUB_RELAY_PATH = "/__backend/chatgpt-pubsub";
export const CHATGPT_PUBSUB_RELAY_PROTOCOL_PREFIX = "codex-web-chatgpt-pubsub.";
export const CHATGPT_PUBSUB_UPSTREAM_HOSTS = [
  "chatgpt.com",
  "ws.chatgpt.com",
  "ws.chatgpt-staging.com",
] as const;

const allowedUpstreamHosts = new Set<string>(CHATGPT_PUBSUB_UPSTREAM_HOSTS);
const MAX_TARGET_URL_BYTES = 8 * 1024;
const MAX_FRAME_BYTES = 16 * 1024 * 1024;
const MAX_PENDING_UPSTREAM_BYTES = 1024 * 1024;
const UPSTREAM_HANDSHAKE_TIMEOUT_MS = 10_000;
const relayProtocolTokenPattern = /^[A-Za-z0-9_-]+$/;
const safeUpstreamErrorCodes: ReadonlySet<string> = new Set([
  "ABORT_ERR",
  "CERT_HAS_EXPIRED",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "EAI_AGAIN",
  "ECONNABORTED",
  "ECONNREFUSED",
  "ECONNRESET",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ENOTFOUND",
  "EPROTO",
  "ERR_HTTP_REQUEST_TIMEOUT",
  "ERR_SOCKET_CLOSED",
  "ERR_TLS_CERT_ALTNAME_INVALID",
  "ETIMEDOUT",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
]);

type UpstreamWebSocketFactory = (target: URL) => WebSocket;
type UpstreamDiagnostic =
  | { event: "open" }
  | { event: "unexpected-response"; statusCode: number | undefined }
  | { event: "error"; error: unknown }
  | { event: "close"; code: number };

export type ChatGptPubsubRelayLogger = {
  info(message: string): void;
  warn(message: string): void;
};

export type ChatGptPubsubRelayOptions = {
  createUpstreamWebSocket?: UpstreamWebSocketFactory;
  logger?: ChatGptPubsubRelayLogger;
};

function requestPath(requestUrl: string | undefined): string | null {
  try {
    return new URL(requestUrl ?? "/", "http://codex-web.invalid").pathname;
  } catch {
    return null;
  }
}

function canonicalBase64UrlDecode(value: string): string | null {
  if (!value || !relayProtocolTokenPattern.test(value)) {
    return null;
  }

  const bytes = Buffer.from(value, "base64url");
  if (
    bytes.length === 0 ||
    bytes.length > MAX_TARGET_URL_BYTES ||
    bytes.toString("base64url") !== value
  ) {
    return null;
  }

  const decoded = bytes.toString("utf8");
  return Buffer.from(decoded, "utf8").equals(bytes) ? decoded : null;
}

export function parseChatGptPubsubRelayTarget(
  protocolHeader: string | string[] | undefined,
): URL | null {
  // The browser sends exactly one private relay subprotocol. Reject any
  // additional protocol instead of letting it influence the upstream socket.
  if (typeof protocolHeader !== "string") {
    return null;
  }

  const protocols = protocolHeader.split(",").map((value) => value.trim());
  if (protocols.length !== 1) {
    return null;
  }

  const protocol = protocols[0]!;
  if (!protocol.startsWith(CHATGPT_PUBSUB_RELAY_PROTOCOL_PREFIX)) {
    return null;
  }

  const encodedTarget = protocol.slice(
    CHATGPT_PUBSUB_RELAY_PROTOCOL_PREFIX.length,
  );
  const rawTarget = canonicalBase64UrlDecode(encodedTarget);
  if (rawTarget === null) {
    return null;
  }

  let target: URL;
  try {
    target = new URL(rawTarget);
  } catch {
    return null;
  }

  if (
    target.protocol !== "wss:" ||
    target.port !== "" ||
    target.username !== "" ||
    target.password !== "" ||
    target.hash !== "" ||
    !allowedUpstreamHosts.has(target.hostname)
  ) {
    return null;
  }

  return target;
}

export function chatGptPubsubOriginForTarget(target: URL): string {
  return target.hostname === "ws.chatgpt-staging.com"
    ? "https://chatgpt-staging.com"
    : "https://chatgpt.com";
}

function createUpstreamWebSocket(target: URL): WebSocket {
  // Proxy selection only needs the validated host and protocol. Keep the
  // signed path/query out of the proxy resolver as well as out of diagnostics.
  // Prefer an explicit WSS proxy, otherwise use HTTPS proxy semantics. This
  // keeps HTTPS_PROXY ahead of ALL_PROXY while still supporting WSS_PROXY.
  const hasExplicitWssProxy = Boolean(
    process.env.wss_proxy || process.env.WSS_PROXY,
  );
  const proxyLookupProtocol = hasExplicitWssProxy ? "wss" : "https";
  const proxyUrl = getProxyForUrl(`${proxyLookupProtocol}://${target.host}/`);
  const agent = proxyUrl ? new HttpsProxyAgent(proxyUrl) : undefined;

  return new WebSocket(target, {
    agent,
    followRedirects: false,
    handshakeTimeout: UPSTREAM_HANDSHAKE_TIMEOUT_MS,
    maxPayload: MAX_FRAME_BYTES,
    origin: chatGptPubsubOriginForTarget(target),
    perMessageDeflate: false,
  });
}

function safeUpstreamErrorCode(error: unknown): string {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return "unknown";
  }
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" && safeUpstreamErrorCodes.has(code)
    ? code
    : "unknown";
}

function safeHttpStatus(statusCode: number | undefined): string {
  if (
    typeof statusCode !== "number" ||
    !Number.isInteger(statusCode) ||
    statusCode < 100 ||
    statusCode > 999
  ) {
    return "unknown";
  }
  return String(statusCode);
}

function safeCloseCode(code: number): string {
  return Number.isInteger(code) && code >= 0 && code <= 65_535
    ? String(code)
    : "unknown";
}

function rawDataByteLength(data: RawData): number {
  return Array.isArray(data)
    ? data.reduce((total, item) => total + item.byteLength, 0)
    : data.byteLength;
}

function relayCloseCode(code: number): number | undefined {
  if (code === 1005) {
    return undefined;
  }
  if (
    code === 1000 ||
    (code >= 1001 &&
      code <= 1014 &&
      code !== 1004 &&
      code !== 1005 &&
      code !== 1006) ||
    (code >= 3000 && code <= 4999)
  ) {
    return code;
  }
  return 1011;
}

function closeWebSocket(socket: WebSocket, code?: number): void {
  try {
    if (socket.readyState === WebSocket.CONNECTING) {
      socket.terminate();
      return;
    }
    if (socket.readyState === WebSocket.OPEN) {
      if (code === undefined) {
        socket.close();
      } else {
        socket.close(code);
      }
    }
  } catch {
    socket.terminate();
  }
}

export class ChatGptPubsubRelay {
  private readonly createUpstream: UpstreamWebSocketFactory;
  private readonly logger: ChatGptPubsubRelayLogger;
  private readonly upstreamSockets = new Set<WebSocket>();
  private readonly websocketServer: WebSocketServer;
  private closePromise: Promise<void> | null = null;
  private closed = false;

  constructor(options: ChatGptPubsubRelayOptions = {}) {
    this.createUpstream =
      options.createUpstreamWebSocket ?? createUpstreamWebSocket;
    this.logger = options.logger ?? console;
    this.websocketServer = new WebSocketServer({
      maxPayload: MAX_FRAME_BYTES,
      noServer: true,
      perMessageDeflate: false,
    });
  }

  handleUpgrade(
    request: IncomingMessage,
    socket: Duplex,
    head: Buffer,
  ): boolean {
    if (this.closed || requestPath(request.url) !== CHATGPT_PUBSUB_RELAY_PATH) {
      return false;
    }

    const target = parseChatGptPubsubRelayTarget(
      request.headers["sec-websocket-protocol"],
    );
    if (target === null) {
      return false;
    }

    this.websocketServer.handleUpgrade(request, socket, head, (downstream) =>
      this.bridge(downstream, target),
    );
    return true;
  }

  close(): Promise<void> {
    if (this.closePromise) {
      return this.closePromise;
    }
    this.closed = true;

    for (const upstream of this.upstreamSockets) {
      upstream.terminate();
    }
    this.upstreamSockets.clear();
    for (const downstream of this.websocketServer.clients) {
      downstream.terminate();
    }

    this.closePromise = new Promise<void>((resolve, reject) => {
      this.websocketServer.close((error) => {
        if (error) {
          reject(error);
        } else {
          resolve();
        }
      });
    });
    return this.closePromise;
  }

  private bridge(downstream: WebSocket, target: URL): void {
    let upstream: WebSocket;
    try {
      upstream = this.createUpstream(target);
    } catch (error) {
      this.logUpstream(target, { event: "error", error });
      closeWebSocket(downstream, 1011);
      return;
    }

    this.upstreamSockets.add(upstream);
    const pending: Array<{ data: RawData; isBinary: boolean }> = [];
    let pendingBytes = 0;
    let finished = false;
    let receivedUnexpectedResponse = false;

    const finish = (): boolean => {
      if (finished) {
        return false;
      }
      finished = true;
      pending.length = 0;
      pendingBytes = 0;
      this.upstreamSockets.delete(upstream);
      return true;
    };

    const fail = (downstreamCode = 1011): void => {
      if (!finish()) {
        return;
      }
      closeWebSocket(downstream, downstreamCode);
      closeWebSocket(upstream, 1011);
    };

    const send = (
      destination: WebSocket,
      data: RawData,
      isBinary: boolean,
    ): void => {
      if (destination.readyState !== WebSocket.OPEN) {
        fail();
        return;
      }
      try {
        destination.send(data, { binary: isBinary }, (error) => {
          if (error) {
            fail();
          }
        });
      } catch {
        fail();
      }
    };

    downstream.on("message", (data, isBinary) => {
      if (finished) {
        return;
      }
      if (upstream.readyState === WebSocket.OPEN) {
        send(upstream, data, isBinary);
        return;
      }
      if (upstream.readyState !== WebSocket.CONNECTING) {
        fail();
        return;
      }

      const byteLength = rawDataByteLength(data);
      if (pendingBytes + byteLength > MAX_PENDING_UPSTREAM_BYTES) {
        fail(1009);
        return;
      }
      pending.push({ data, isBinary });
      pendingBytes += byteLength;
    });

    downstream.once("close", (code) => {
      if (!finish()) {
        return;
      }
      closeWebSocket(upstream, relayCloseCode(code));
    });
    downstream.once("error", () => fail());

    upstream.once("open", () => {
      this.logUpstream(target, { event: "open" });
      if (finished) {
        closeWebSocket(upstream, 1000);
        return;
      }
      for (const frame of pending) {
        send(upstream, frame.data, frame.isBinary);
        if (finished) {
          return;
        }
      }
      pending.length = 0;
      pendingBytes = 0;
    });
    upstream.on("message", (data, isBinary) => {
      if (!finished) {
        send(downstream, data, isBinary);
      }
    });
    upstream.once("unexpected-response", (_request, response) => {
      receivedUnexpectedResponse = true;
      this.logUpstream(target, {
        event: "unexpected-response",
        statusCode: response.statusCode,
      });
      fail();
    });
    upstream.once("close", (code) => {
      this.logUpstream(target, { event: "close", code });
      if (!finish()) {
        return;
      }
      closeWebSocket(downstream, relayCloseCode(code));
    });
    upstream.once("error", (error) => {
      if (!receivedUnexpectedResponse) {
        this.logUpstream(target, { event: "error", error });
      }
      fail();
    });
  }

  private logUpstream(target: URL, diagnostic: UpstreamDiagnostic): void {
    const level =
      diagnostic.event === "error" || diagnostic.event === "unexpected-response"
        ? "warn"
        : "info";
    let detail = "";
    if (diagnostic.event === "error") {
      detail = ` code=${safeUpstreamErrorCode(diagnostic.error)}`;
    } else if (diagnostic.event === "unexpected-response") {
      detail = ` status=${safeHttpStatus(diagnostic.statusCode)}`;
    } else if (diagnostic.event === "close") {
      detail = ` code=${safeCloseCode(diagnostic.code)}`;
    }

    try {
      this.logger[level](
        `[chatgpt-pubsub-relay] upstream ${diagnostic.event} host=${target.hostname}${detail}`,
      );
    } catch {
      // Diagnostics must never disrupt relay cleanup or frame forwarding.
    }
  }
}
