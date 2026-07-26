#!/usr/bin/env node

declare global {
  var __CODEX_SHIM_VALUES__: {
    version: string;
    browseRoot: string;
  };
}

import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parseArgs as parseCliArgs } from "node:util";
import { WebSocket, WebSocketServer } from "ws";
import Fastify, { type FastifyInstance } from "fastify";
import fastifyStatic from "@fastify/static";
import { installModuleAliasHook } from "./module";
import { glob } from "glob";
import { cacheControlForResponse } from "./cache-policy";
import {
  createAuthoritativeThreadReader,
  type DesktopInvoke,
} from "./authoritative-thread-reader";
import {
  invokeRendererRequest,
  rendererInvokeErrorMessage,
  syntheticMcpErrorEventForRejectedInvoke,
  type RendererInvokeMessage,
} from "./ipc-renderer-invoke";
import {
  parseReliableBridgeHello,
  ReliableBridgeCapacity,
  ReliableBridgeSession,
} from "./reliable-bridge";
import {
  parseRendererBridgeReady,
  RendererRecoveryCoordinator,
} from "./renderer-recovery";
import { registerWorkspaceFileRoutes } from "./workspace-file-routes";
import {
  parseAllowAnyProject,
  parseUploadQuotaBytes,
  resolveConfiguredBrowseRoot,
  resolveProjectBrowseRoot,
  WorkspaceFileAuthority,
  type WorkspaceDirectoryEntries,
} from "./workspace-files";

type ServerOptions = {
  host: string;
  port: number;
};

type RendererToMainMessage =
  | {
      type: "renderer-bridge-ready";
      currentThreadId: string | null;
    }
  | RendererInvokeMessage
  | {
      type: "ipc-renderer-send";
      channel: string;
      args: unknown[];
      sourceUrl: string;
    }
  | {
      type: "ipc-renderer-post-message";
      channel: string;
      message: unknown;
      portIds: string[];
      sourceUrl?: string;
    }
  | {
      type: "message-port-message";
      portId: string;
      data: unknown;
    }
  | {
      type: "message-port-close";
      portId: string;
    }
  | {
      type: "workspace-directory-entries-request";
      requestId: string;
      directoryPath: string | null;
      directoriesOnly: boolean;
      scope?: "browse" | "project";
    };

type MainToRendererMessage =
  | {
      type: "ipc-main-event";
      channel: string;
      args: unknown[];
    }
  | {
      type: "ipc-renderer-invoke-result";
      requestId: string;
      ok: true;
      result: unknown;
    }
  | {
      type: "ipc-renderer-invoke-result";
      requestId: string;
      ok: false;
      errorMessage: string;
    }
  | {
      type: "workspace-directory-entries-result";
      requestId: string;
      ok: true;
      result: WorkspaceDirectoryEntries;
    }
  | {
      type: "workspace-directory-entries-result";
      requestId: string;
      ok: false;
      errorMessage: string;
    }
  | {
      type: "message-port-message";
      portId: string;
      data: unknown;
    }
  | {
      type: "message-port-close";
      portId: string;
    };

type MessagePortListener = (...args: unknown[]) => void;

type BridgedMessagePort = {
  close: () => void;
  on: (event: string, listener: MessagePortListener) => unknown;
  postMessage: (message: unknown) => void;
  start: () => void;
};

class WebSocketMessagePort implements BridgedMessagePort {
  private closed = false;
  private readonly listeners = new Map<string, Set<MessagePortListener>>();

  constructor(
    private readonly portId: string,
    private readonly sendToRenderer: (message: MainToRendererMessage) => void,
    private readonly onClosed: () => void,
  ) {}

  on(event: string, listener: MessagePortListener): this {
    const listeners = this.listeners.get(event) ?? new Set();
    listeners.add(listener);
    this.listeners.set(event, listeners);

    return this;
  }

  postMessage(data: unknown): void {
    if (this.closed) {
      return;
    }
    this.sendToRenderer({
      type: "message-port-message",
      portId: this.portId,
      data,
    });
  }

  start(): void {}

  close(): void {
    if (!this.markClosed()) {
      return;
    }
    this.sendToRenderer({
      type: "message-port-close",
      portId: this.portId,
    });
  }

  receiveMessage(data: unknown): void {
    if (this.closed) {
      return;
    }
    const listeners = this.listeners.get("message");
    if (!listeners || listeners.size === 0) {
      return;
    }
    for (const listener of listeners) {
      listener({ data });
    }
  }

  disconnect(): void {
    if (!this.markClosed()) {
      return;
    }
    this.emit("close");
  }

  private emit(event: string, ...args: unknown[]): void {
    for (const listener of this.listeners.get(event) ?? []) {
      listener(...args);
    }
  }

  private markClosed(): boolean {
    if (this.closed) {
      return false;
    }
    this.closed = true;
    this.onClosed();
    return true;
  }
}

type IpcMainBridgeState = {
  broadcastToRenderer?: (message: MainToRendererMessage) => void;
  handleRendererInvoke?: (
    channel: string,
    args: unknown[],
    responseSink?: (channel: string, args: unknown[]) => void,
  ) => Promise<unknown>;
  handleRendererPostMessage?: (
    channel: string,
    message: unknown,
    ports: BridgedMessagePort[],
    sourceUrl?: string,
  ) => void;
  handleRendererSend?: (channel: string, args: unknown[]) => void;
  shutdownDesktopApp?: () => Promise<void>;
};

type ServerCleanupAuthority = {
  cleanup: () => Promise<void>;
};

function closeActiveHttpConnections(app: FastifyInstance): void {
  const server = app.server as typeof app.server & {
    closeAllConnections?: () => void;
  };
  server.closeAllConnections?.();
}

function printUsage(): void {
  console.log(
    [
      "Usage:",
      "  server [--host <host>] [--port <port>]",
      "",
      "Defaults:",
      "  --host 127.0.0.1",
      "  --port 8214",
      "",
      "Examples:",
      "  yarn server",
      "  yarn server --port 9000",
    ].join("\n"),
  );
}

function parsePort(raw: string): number {
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 65535) {
    throw new Error(`Invalid port: ${raw}`);
  }
  return parsed;
}

function parseServerArgs(args: string[]): ServerOptions {
  const parsed = parseCliArgs({
    args,
    allowPositionals: false,
    options: {
      help: {
        short: "h",
        type: "boolean",
      },
      host: {
        type: "string",
      },
      port: {
        type: "string",
      },
    },
    strict: true,
  });

  if (parsed.values.help) {
    printUsage();
    process.exit(0);
  }

  return {
    host: parsed.values.host ?? "127.0.0.1",
    port: parsed.values.port ? parsePort(parsed.values.port) : 8214,
  };
}

function getIpcMainBridgeState(): IpcMainBridgeState {
  const globals = globalThis as typeof globalThis & {
    __codexElectronIpcBridge?: IpcMainBridgeState;
  };
  if (!globals.__codexElectronIpcBridge) {
    globals.__codexElectronIpcBridge = {};
  }
  return globals.__codexElectronIpcBridge;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.stack ?? error.message;
  }
  return String(error);
}

function ensureElectronLikeProcessContext(): void {
  process.env.BUILD_FLAVOR = "prod";

  const versions = process.versions as NodeJS.ProcessVersions & {
    electron?: string;
  };
  if (!versions.electron) {
    Object.defineProperty(versions, "electron", {
      value: "41.2.0",
      configurable: true,
      enumerable: true,
      writable: false,
    });
  }

  const processWithElectronFields = process as NodeJS.Process & {
    resourcesPath?: string;
    type?: string;
  };
  processWithElectronFields.resourcesPath ??= path.resolve(
    __dirname,
    "../../scratch/asar",
  );
  processWithElectronFields.type ??= "browser";
}

function sendBridgeReset(socket: WebSocket, reason: string): void {
  if (socket.readyState === WebSocket.OPEN) {
    try {
      socket.send(JSON.stringify({ type: "bridge-reset", reason }));
    } catch {
      socket.terminate();
      return;
    }
  }
  socket.close(1008, reason);
}

function createServerCleanupAuthority({
  app,
  bridgeState,
  sessions,
  websocketServer,
  workspaceFileAuthority,
  disposeRendererRecovery,
}: {
  app: FastifyInstance;
  bridgeState: IpcMainBridgeState;
  sessions: Map<
    string,
    ReliableBridgeSession<RendererToMainMessage, MainToRendererMessage>
  >;
  websocketServer: WebSocketServer;
  workspaceFileAuthority: WorkspaceFileAuthority;
  disposeRendererRecovery: () => void;
}): ServerCleanupAuthority {
  let cleanupPromise: Promise<void> | null = null;
  let exitPromise: Promise<void> | null = null;

  const removeSignalHandlers = (): void => {
    process.off("SIGINT", handleSignal);
    process.off("SIGTERM", handleSignal);
  };

  const cleanup = (): Promise<void> => {
    if (cleanupPromise) {
      return cleanupPromise;
    }

    cleanupPromise = (async () => {
      const cleanupErrors: unknown[] = [];
      for (const session of [...sessions.values()]) {
        try {
          session.dispose("server shutdown");
        } catch (error) {
          cleanupErrors.push(error);
        }
      }
      for (const client of websocketServer.clients) {
        try {
          client.terminate();
        } catch (error) {
          cleanupErrors.push(error);
        }
      }

      try {
        await new Promise<void>((resolve) => {
          websocketServer.close((error) => {
            if (error) cleanupErrors.push(error);
            resolve();
          });
        });
      } catch (error) {
        cleanupErrors.push(error);
      }

      const authorityCleanupPromise = Promise.resolve()
        .then(() => workspaceFileAuthority.cleanup())
        .finally(() => closeActiveHttpConnections(app));
      const [appCloseResult, desktopShutdownResult, authorityCleanupResult] =
        await Promise.allSettled([
          Promise.resolve().then(() => app.close()),
          Promise.resolve().then(() => bridgeState.shutdownDesktopApp?.()),
          authorityCleanupPromise,
        ]);

      if (appCloseResult.status === "rejected") {
        cleanupErrors.push(appCloseResult.reason);
      }
      if (desktopShutdownResult.status === "rejected") {
        cleanupErrors.push(desktopShutdownResult.reason);
      }
      if (authorityCleanupResult.status === "rejected") {
        cleanupErrors.push(authorityCleanupResult.reason);
      }

      bridgeState.broadcastToRenderer = undefined;
      bridgeState.handleRendererInvoke = undefined;
      bridgeState.handleRendererPostMessage = undefined;
      bridgeState.handleRendererSend = undefined;
      bridgeState.shutdownDesktopApp = undefined;
      disposeRendererRecovery();

      removeSignalHandlers();
      if (cleanupErrors.length > 0) {
        throw new AggregateError(cleanupErrors, "Server cleanup failed");
      }
    })();
    return cleanupPromise;
  };

  const exitAfterCleanup = (exitCode: number): void => {
    if (exitPromise) {
      return;
    }
    exitPromise = cleanup()
      .catch((error) => {
        console.error(errorMessage(error));
        exitCode = 1;
      })
      .then(() => process.exit(exitCode));
  };

  const handleSignal = (): void => exitAfterCleanup(0);
  process.on("SIGINT", handleSignal);
  process.on("SIGTERM", handleSignal);

  return { cleanup };
}

async function startIpcBridgeServer(options: ServerOptions): Promise<void> {
  const allowAnyProject = parseAllowAnyProject(
    process.env.CODEX_WEBUI_ALLOW_ANY_PROJECT,
  );
  const configuredBrowseRoot = resolveConfiguredBrowseRoot(
    process.env.CODEX_WEBUI_BROWSE_ROOT,
    os.homedir(),
  );
  const projectBrowseRoot = resolveProjectBrowseRoot(
    process.env.CODEX_WEBUI_BROWSE_ROOT,
    os.homedir(),
    allowAnyProject,
  );
  const uploadQuotaBytes = parseUploadQuotaBytes(
    process.env.CODEX_WEBUI_UPLOAD_QUOTA_BYTES,
  );
  const workspaceFileAuthority = await WorkspaceFileAuthority.create(
    configuredBrowseRoot,
    os.tmpdir(),
    uploadQuotaBytes,
    projectBrowseRoot,
  );
  const ownsAppServerRuntime = !process.env.CODEX_UNIX_SOCKET?.trim();
  const bridgeState = getIpcMainBridgeState();
  const app = Fastify({ logger: false });
  const websocketServer = new WebSocketServer({ noServer: true });
  const serverEpoch = randomUUID();
  const bridgeCapacity = new ReliableBridgeCapacity();
  const sessions = new Map<
    string,
    ReliableBridgeSession<RendererToMainMessage, MainToRendererMessage>
  >();
  const messagePortsByConnection = new Map<
    string,
    Map<string, WebSocketMessagePort>
  >();
  function sendRendererHistoryRecovery(
    session: ReliableBridgeSession<
      RendererToMainMessage,
      MainToRendererMessage
    >,
  ): void {
    // The official renderer already has a loss-recovery path for a
    // WebSocket-backed host. A fresh Browser execution context has the same
    // state gap even though the server-owned local app-server remains stdio,
    // so enter that renderer-only recovery path after its IPC listener is
    // ready. This re-reads/resumes official app-server thread state; it does
    // not replay the retired page transport or restart the runtime.
    session.send({
      type: "ipc-main-event",
      channel: "codex_desktop:message-for-view",
      args: [
        {
          type: "codex-app-server-connection-changed",
          error: null,
          hostId: "local",
          progress: null,
          state: "connected",
          transport: "websocket",
        },
      ],
    });
  }

  const rendererRecovery =
    new RendererRecoveryCoordinator<MainToRendererMessage>({
      broadcast: (message) => {
        for (const session of sessions.values()) {
          session.send(message);
        }
      },
      recover: (connectionId) => {
        const session = sessions.get(connectionId);
        if (session) {
          sendRendererHistoryRecovery(session);
        }
      },
      readThread: createAuthoritativeThreadReader(((
        channel,
        args,
        responseSink,
      ) => {
        const handler = bridgeState.handleRendererInvoke as
          | DesktopInvoke
          | undefined;
        if (!handler) {
          return Promise.reject(
            new Error(
              `[ipc-bridge] no ipcMain.handle for authoritative thread/read`,
            ),
          );
        }
        return handler(channel, args, responseSink);
      }) satisfies DesktopInvoke),
    });
  const cleanupAuthority = createServerCleanupAuthority({
    app,
    bridgeState,
    sessions,
    websocketServer,
    workspaceFileAuthority,
    disposeRendererRecovery: () => rendererRecovery.dispose(),
  });
  const startupStep = async <T>(
    operation: () => T | Promise<T>,
  ): Promise<T> => {
    try {
      return await operation();
    } catch (startupError) {
      try {
        await cleanupAuthority.cleanup();
      } catch (cleanupError) {
        console.error(errorMessage(cleanupError));
      }
      throw startupError;
    }
  };

  app.addHook("onSend", async (request, reply) => {
    if (request.method === "GET" || request.method === "HEAD") {
      const contentType = reply.getHeader("content-type");
      reply.header(
        "cache-control",
        cacheControlForResponse(
          request.url,
          reply.statusCode,
          contentType === undefined ? undefined : String(contentType),
        ),
      );
    }
  });

  await startupStep(() =>
    registerWorkspaceFileRoutes(app, workspaceFileAuthority, {
      cleanupOnClose: false,
    }),
  );

  await startupStep(() =>
    app.register(fastifyStatic, {
      root: path.resolve(__dirname, "../../scratch/asar/webview"),
      prefix: "/",
    }),
  );

  app.get("/", async (_request, reply) => {
    return reply.sendFile("index.html");
  });

  app.setNotFoundHandler((request, reply) => {
    if (request.url.startsWith("/@fs/")) {
      return reply.code(404).send({ error: "Not Found" });
    }

    if (request.method === "GET") {
      return reply.sendFile("index.html");
    }
    return reply.code(404).send({ error: "Not Found" });
  });

  app.server.on("upgrade", (request, socket, head) => {
    const requestUrl = request.url ?? "/";
    const host = request.headers.host ?? "localhost";
    const url = new URL(requestUrl, `http://${host}`);
    if (url.pathname !== "/__backend/ipc") {
      socket.destroy();
      return;
    }

    websocketServer.handleUpgrade(request, socket, head, (upgradedSocket) => {
      websocketServer.emit("connection", upgradedSocket, request);
    });
  });

  bridgeState.broadcastToRenderer = (message: MainToRendererMessage): void => {
    rendererRecovery.broadcastRuntimeMessage(message);
  };

  websocketServer.on("connection", (socket) => {
    const handshakeTimeout = setTimeout(() => {
      socket.close(1008, "reliable bridge handshake timed out");
    }, 10_000);
    handshakeTimeout.unref?.();
    socket.once("close", () => clearTimeout(handshakeTimeout));

    socket.once("message", (rawData) => {
      clearTimeout(handshakeTimeout);
      let value: unknown;
      try {
        value = JSON.parse(String(rawData));
      } catch {
        sendBridgeReset(socket, "invalid reliable bridge handshake");
        return;
      }

      const hello = parseReliableBridgeHello(value);
      if (!hello) {
        sendBridgeReset(socket, "invalid reliable bridge handshake");
        return;
      }
      if (hello.serverEpoch !== null && hello.serverEpoch !== serverEpoch) {
        sendBridgeReset(socket, "backend restarted");
        return;
      }

      let session = sessions.get(hello.connectionId);
      if (!session) {
        // A non-null epoch identifies a reconnect. If its page-scoped session
        // is gone, do not pretend that a new session is durable recovery.
        if (hello.serverEpoch !== null) {
          sendBridgeReset(socket, "reconnection session expired");
          return;
        }
        if (!bridgeCapacity.retainSession(hello.connectionId)) {
          sendBridgeReset(socket, "reliable bridge session capacity exceeded");
          return;
        }
        session = new ReliableBridgeSession({
          connectionId: hello.connectionId,
          serverEpoch,
          capacity: bridgeCapacity,
          onDispose: () => {
            sessions.delete(hello.connectionId);
            const messagePorts = messagePortsByConnection.get(
              hello.connectionId,
            );
            for (const port of messagePorts?.values() ?? []) {
              port.disconnect();
            }
            messagePortsByConnection.delete(hello.connectionId);
            rendererRecovery.disposeRenderer(hello.connectionId);
            bridgeCapacity.releaseSession(hello.connectionId);
          },
          onMessage: (message) => handleRendererMessage(session!, message),
        });
        sessions.set(hello.connectionId, session);
        messagePortsByConnection.set(hello.connectionId, new Map());
      }
      session.attach(socket);
    });
  });

  function handleRendererMessage(
    session: ReliableBridgeSession<
      RendererToMainMessage,
      MainToRendererMessage
    >,
    message: RendererToMainMessage,
  ): void {
    if (message.type === "renderer-bridge-ready") {
      const ready = parseRendererBridgeReady(message);
      if (!ready) {
        throw new Error("invalid renderer bridge readiness");
      }
      // Readiness applies only to this page-scoped transport. Other ready
      // renderer sessions may be live Browser tabs and must remain retained
      // under the existing process-wide session and byte bounds.
      rendererRecovery.acceptRendererReady(
        session.connectionId,
        ready.currentThreadId,
        ready.recoveryReason,
      );
      return;
    }

    if (message.type === "ipc-renderer-post-message") {
      if (new Set(message.portIds).size !== message.portIds.length) {
        console.error("[ipc-bridge] duplicate transferred MessagePort id");
        return;
      }
      const messagePorts =
        messagePortsByConnection.get(session.connectionId) ?? new Map();
      messagePortsByConnection.set(session.connectionId, messagePorts);
      const ports = message.portIds.map((portId) => {
        messagePorts.get(portId)?.disconnect();
        const port = new WebSocketMessagePort(
          portId,
          (outgoing) => session.send(outgoing),
          () => messagePorts.delete(portId),
        );
        messagePorts.set(portId, port);
        return port;
      });
      if (bridgeState.handleRendererPostMessage) {
        bridgeState.handleRendererPostMessage(
          message.channel,
          message.message,
          ports,
          message.sourceUrl,
        );
      } else {
        for (const port of ports) {
          port.close();
        }
      }
      return;
    }

    if (message.type === "message-port-message") {
      messagePortsByConnection
        .get(session.connectionId)
        ?.get(message.portId)
        ?.receiveMessage(message.data);
      return;
    }

    if (message.type === "message-port-close") {
      messagePortsByConnection
        .get(session.connectionId)
        ?.get(message.portId)
        ?.disconnect();
      return;
    }

    if (message.type === "ipc-renderer-send") {
      bridgeState.handleRendererSend?.(message.channel, message.args);
      return;
    }

    if (message.type === "workspace-directory-entries-request") {
      const { requestId } = message;
      workspaceFileAuthority
        .getWorkspaceDirectoryEntries(
          message.directoryPath,
          message.directoriesOnly,
          message.scope,
        )
        .then((result) => {
          session.send({
            type: "workspace-directory-entries-result",
            requestId,
            ok: true,
            result,
          });
        })
        .catch((error) => {
          session.send({
            type: "workspace-directory-entries-result",
            requestId,
            ok: false,
            errorMessage: errorMessage(error),
          });
        });
      return;
    }

    if (message.type === "ipc-renderer-invoke") {
      const { requestId } = message;
      Promise.resolve()
        .then(() =>
          invokeRendererRequest(
            message,
            workspaceFileAuthority.browseRoot,
            async (sanitizedChannel, sanitizedArgs) =>
              await (bridgeState.handleRendererInvoke?.(
                sanitizedChannel,
                sanitizedArgs,
              ) ??
                Promise.reject(
                  new Error(
                    `[ipc-bridge] no ipcMain.handle for channel ${sanitizedChannel}`,
                  ),
                )),
            os.homedir(),
            workspaceFileAuthority.projectBrowseRoot,
          ),
        )
        .then((result) => {
          session.send({
            type: "ipc-renderer-invoke-result",
            requestId,
            ok: true,
            result,
          });
        })
        .catch((error) => {
          session.send({
            type: "ipc-renderer-invoke-result",
            requestId,
            ok: false,
            errorMessage: rendererInvokeErrorMessage(error),
          });
          const syntheticResponse = syntheticMcpErrorEventForRejectedInvoke(
            message,
            error,
          );
          if (syntheticResponse) {
            session.send(syntheticResponse);
          }
        });
    }
  }

  await startupStep(() =>
    app.listen({ host: options.host, port: options.port }),
  );
  console.log(`IPC bridge listening at ws://${options.host}:${options.port}`);
  console.log(`Workspace browse root: ${workspaceFileAuthority.browseRoot}`);
  if (allowAnyProject) {
    console.warn(
      "WARNING: CODEX_WEBUI_ALLOW_ANY_PROJECT lets Create project select any filesystem path visible to this server",
    );
  }

  await startupStep(async () => {
    ensureElectronLikeProcessContext();
    installModuleAliasHook();

    if (process.env.CODEX_WEBUI_BROWSE_ROOT?.trim()) {
      // The desktop bundle (shell-projectless-browse-root.patch) and child
      // processes read this env value directly. A relative or symlinked
      // configured root would diverge from the canonical root the request
      // sanitizer pins to, so rewrite it to the canonical form.
      process.env.CODEX_WEBUI_BROWSE_ROOT = workspaceFileAuthority.browseRoot;
    }

    if (ownsAppServerRuntime) {
      // The default Desktop app-server creates TMPDIR/codex-ipc/ipc.sock but
      // Codex does not unlink that pathname when it exits. Keep it inside the
      // exact per-process root codex-web already owns so normal server cleanup
      // can remove it without touching a caller's shared TMPDIR. The external
      // CODEX_UNIX_SOCKET topology retains its existing runtime boundary.
      process.env.TMPDIR = workspaceFileAuthority.runtimeRoot;
    }

    const packageJson = JSON.parse(
      await fs.readFile(
        path.resolve(__dirname, "../../scratch/asar/package.json"),
        "utf8",
      ),
    );

    globalThis.__CODEX_SHIM_VALUES__ = {
      version: packageJson.version,
      browseRoot: workspaceFileAuthority.browseRoot,
    };

    const matches = await glob("../../scratch/asar/.vite/build/main-*.js", {
      nodir: true,
      cwd: __dirname,
    });

    if (matches.length === 0) {
      throw new Error("no main bundle found");
    }

    if (matches.length > 1) {
      throw new Error("multiple main bundles found");
    }

    const module = require(matches[0]!);
    await Promise.resolve(module.runMainAppStartup());
  });
}

async function main(args: string[]) {
  const options = parseServerArgs(args);

  await startIpcBridgeServer(options);
}

main(process.argv.slice(2)).catch((error) => {
  console.error(errorMessage(error));
  process.exit(1);
});
