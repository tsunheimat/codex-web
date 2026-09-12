import { timingSafeEqual } from "node:crypto";
import Fastify from "fastify";
import fastifyStatic from "@fastify/static";
import { WebSocketServer, WebSocket } from "ws";
import { type IncomingMessage } from "node:http";
import { type GatewayConfig } from "./config";
import { SessionService } from "./service";
import { fileOperation, MAX_UPLOAD_BYTES } from "./files";
import { TerminalService } from "./terminal";
import { originAllowed } from "../http-origins";
export { originAllowed } from "../http-origins";

export function tokenMatches(expected: string, actual: unknown): boolean {
  if (typeof actual !== "string") return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(actual);
  return a.length === b.length && timingSafeEqual(a, b);
}
export async function createGateway(
  config: GatewayConfig,
  service: SessionService,
) {
  const app = Fastify({ logger: false, bodyLimit: 15 * 1024 * 1024 });
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: 64 * 1024,
    perMessageDeflate: false,
  });
  const terminals = new TerminalService();
  const sockets = new Set<WebSocket>();
  app.setErrorHandler((error: any, _request, reply) => {
    const status = error.statusCode ?? 500;
    reply.code(status).send({
      error:
        status >= 500
          ? "Backend request failed; check backend availability"
          : error.message,
    });
  });
  app.addHook("onRequest", async (request, reply) => {
    if (!request.url.startsWith("/api/")) return;
    const origin = request.headers.origin;
    if (!originAllowed(origin, request.headers.host, config.allowedOrigins))
      return reply.code(403).send({ error: "Origin not allowed" });
    if (origin) {
      reply
        .header("Access-Control-Allow-Origin", origin)
        .header("Vary", "Origin")
        .header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        .header("Access-Control-Allow-Headers", "Authorization, Content-Type");
    }
    reply.header("Cache-Control", "no-store");
    if (request.method === "OPTIONS") return reply.code(204).send();
    const auth = request.headers.authorization;
    if (
      !auth?.startsWith("Bearer ") ||
      !tokenMatches(config.token, auth.slice(7))
    )
      return reply.code(401).send({ error: "Authentication required" });
  });
  app.get("/healthz", async () => ({ ok: true }));
  app.get("/api/v1", async () => ({
    protocolVersion: 1,
    name: "codex-web-gateway",
  }));
  app.get("/api/v1/backends", async () => service.summaries());
  app.get("/api/v1/backends/:id/threads", async (request: any) =>
    service.listThreads(request.params.id),
  );
  app.get("/api/v1/sessions", async () =>
    service.store
      .list()
      .filter((s) => service.backends.some((b) => b.id === s.backendId))
      .map(({ thread, ...summary }) => summary),
  );
  app.get("/api/v1/sessions/:id", async (request: any) => {
    const session = service.store.get(request.params.id);
    service.backend(session.backendId);
    const after = Number(request.query.afterSeq ?? 0);
    if (!Number.isSafeInteger(after) || after < 0)
      throw Object.assign(new Error("Invalid event cursor"), {
        statusCode: 400,
      });
    return service.store.sync(session.id, after);
  });
  app.post(
    "/api/v1/sessions",
    { bodyLimit: 16 * 1024 },
    async (request: any, reply) =>
      reply.code(202).send(service.create(request.body ?? {})),
  );
  app.post(
    "/api/v1/sessions/:id/commands",
    { bodyLimit: 256 * 1024 },
    async (request: any, reply) =>
      reply
        .code(202)
        .send(service.submit(request.params.id, request.body ?? {})),
  );
  app.post("/api/v1/sessions/:id/reconcile", async (request: any) => {
    await service.reconcile(request.params.id);
    return service.store.sync(request.params.id, 0);
  });
  app.post("/api/v1/approvals/:id", async (request: any) => {
    service.answer(request.params.id, request.body);
    return { ok: true };
  });
  app.get("/api/v1/backends/:id/files", async (request: any) =>
    fileOperation(service.backend(request.params.id), {
      action: "list",
      path: request.query.path ?? ".",
    }),
  );
  app.post("/api/v1/backends/:id/uploads", async (request: any, reply) => {
    const b = request.body;
    if (
      !b ||
      typeof b.name !== "string" ||
      b.name.length > 255 ||
      typeof b.data !== "string" ||
      b.data.length > Math.ceil(MAX_UPLOAD_BYTES / 3) * 4 ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
        b.data,
      )
    )
      return reply.code(400).send({ error: "Invalid upload (maximum 10 MiB)" });
    return fileOperation(service.backend(request.params.id), {
      action: "upload",
      name: b.name,
      data: b.data,
    });
  });
  app.get("/api/v1/backends/:id/download", async (request: any, reply) => {
    const result = await fileOperation(service.backend(request.params.id), {
      action: "read",
      path: request.query.path,
    });
    reply
      .type("application/octet-stream")
      .header("X-Content-Type-Options", "nosniff")
      .header(
        "Content-Disposition",
        `attachment; filename*=UTF-8''${encodeURIComponent(result.name)}`,
      );
    return Buffer.from(result.data, "base64");
  });

  function send(socket: WebSocket, data: unknown): void {
    if (socket.readyState !== WebSocket.OPEN) return;
    if (socket.bufferedAmount > 1024 * 1024) {
      socket.close(1013, "Viewer is too slow; synchronize again");
      return;
    }
    socket.send(JSON.stringify(data));
  }
  app.server.on("upgrade", (request, socket, head) => {
    const pathname = new URL(request.url ?? "/", "http://localhost").pathname;
    if (
      !["/api/v1/events", "/api/v1/terminal"].includes(pathname) ||
      !originAllowed(
        request.headers.origin,
        request.headers.host,
        config.allowedOrigins,
      ) ||
      sockets.size >= 64
    ) {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(request, socket, head, (ws) =>
      wss.emit("connection", ws, request),
    );
  });
  wss.on("connection", (socket: WebSocket, request: IncomingMessage) => {
    sockets.add(socket);
    const handshake = setTimeout(
      () => socket.close(1008, "Authentication timed out"),
      5000,
    );
    handshake.unref();
    let subscribed: string | null = null;
    let cursor = 0;
    let scheduled: NodeJS.Timeout | null = null;
    let alive = true;
    const heartbeat = setInterval(() => {
      if (!alive) socket.terminate();
      else {
        alive = false;
        socket.ping();
      }
    }, 15_000);
    heartbeat.unref();
    socket.on("pong", () => {
      alive = true;
    });
    const update = (id: string) => {
      send(socket, { type: "sessions.changed" });
      if (id !== subscribed || scheduled) return;
      scheduled = setTimeout(() => {
        scheduled = null;
        if (!subscribed) return;
        const data = service.store.sync(subscribed, cursor);
        cursor = data.lastSeq;
        send(socket, data);
      }, 50);
    };
    const backends = () =>
      send(socket, { type: "backends", backends: service.summaries() });
    socket.on("error", () => {});
    socket.on("close", () => {
      clearTimeout(handshake);
      clearInterval(heartbeat);
      if (scheduled) clearTimeout(scheduled);
      service.off("session", update);
      service.off("backends", backends);
      sockets.delete(socket);
      // Detaching a viewer never closes a backend or interrupts a turn.
    });
    socket.once("message", (raw) => {
      clearTimeout(handshake);
      let hello: any;
      try {
        hello = JSON.parse(String(raw));
      } catch {
        socket.close(1008, "Invalid handshake");
        return;
      }
      if (
        hello?.type !== "authenticate" ||
        hello.version !== 1 ||
        !tokenMatches(config.token, hello.token)
      ) {
        socket.close(1008, "Authentication or protocol mismatch");
        return;
      }
      if (request.url?.split("?")[0] === "/api/v1/terminal") {
        try {
          terminals.attach(
            service.backend(hello.backendId),
            socket,
            hello.cols,
            hello.rows,
          );
        } catch {
          send(socket, {
            type: "error",
            error: "Terminal unavailable; check node-pty, tmux and SSH access",
          });
          socket.close(1011);
        }
        return;
      }
      send(socket, { type: "ready", version: 1 });
      service.on("session", update);
      service.on("backends", backends);
      socket.on("message", (data) => {
        try {
          const message = JSON.parse(String(data));
          if (message.type === "unsubscribe") {
            subscribed = null;
            return;
          }
          if (
            message.type !== "subscribe" ||
            !Number.isSafeInteger(message.afterSeq) ||
            message.afterSeq < 0
          )
            throw new Error("Invalid subscription");
          const session = service.store.get(message.sessionId);
          service.backend(session.backendId);
          subscribed = session.id;
          const state = service.store.sync(subscribed, message.afterSeq);
          cursor = state.lastSeq;
          send(socket, state);
        } catch {
          send(socket, {
            type: "error",
            error: "Invalid or unavailable session",
          });
        }
      });
    });
  });
  if (config.webRoot) {
    await app.register(fastifyStatic, {
      root: config.webRoot,
      prefix: "/",
      setHeaders: (res) => {
        res.setHeader("Cache-Control", "no-cache");
        res.setHeader("X-Content-Type-Options", "nosniff");
      },
    });
    app.get("/", async (_request, reply) => reply.sendFile("index.html"));
  }
  app.addHook("onClose", async () => {
    terminals.close();
    for (const socket of sockets) socket.terminate();
    wss.close();
    await service.close();
  });
  return app;
}
