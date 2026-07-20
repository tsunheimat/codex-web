#!/usr/bin/env node

declare global {
  var __CODEX_SHIM_VALUES__: {
    version: string;
  };
}

import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parseArgs as parseCliArgs } from "node:util";
import { WebSocket, WebSocketServer } from "ws";
import Fastify from "fastify";
import fastifyMultipart from "@fastify/multipart";
import fastifyStatic from "@fastify/static";
import { installModuleAliasHook } from "./module";
import { glob } from "glob";
import { cacheControlForResponse } from "./cache-policy";
import { sanitizeRendererInvokeMcpRequestPaths } from "./mcp-request-path-sanitizer";
import {
  parseReliableBridgeHello,
  ReliableBridgeCapacity,
  ReliableBridgeSession,
} from "./reliable-bridge";
import {
  parseRendererBridgeReady,
  RendererRecoveryCoordinator,
} from "./renderer-recovery";

type ServerOptions = {
  host: string;
  port: number;
};

type RendererToMainMessage =
  | {
      type: "renderer-bridge-ready";
      currentThreadId: string | null;
    }
  | {
      type: "ipc-renderer-invoke";
      requestId: string;
      channel: string;
      args: unknown[];
      sourceUrl: string;
    }
  | {
      type: "ipc-renderer-send";
      channel: string;
      args: unknown[];
      sourceUrl: string;
    }
  | {
      type: "workspace-directory-entries-request";
      requestId: string;
      directoryPath: string | null;
      directoriesOnly: boolean;
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
    };

type WorkspaceDirectoryEntry = {
  name: string;
  path: string;
  type: "directory" | "file";
};

type WorkspaceDirectoryEntries = {
  directoryPath: string;
  parentPath: string | null;
  entries: WorkspaceDirectoryEntry[];
};

function workspaceDirectoryEntryTypeRank(
  entry: WorkspaceDirectoryEntry,
): number {
  return entry.type === "directory" ? 0 : 1;
}

function workspaceDirectoryEntryHiddenRank(
  entry: WorkspaceDirectoryEntry,
): number {
  return entry.name.startsWith(".") ? 1 : 0;
}

function compareWorkspaceDirectoryEntries(
  left: WorkspaceDirectoryEntry,
  right: WorkspaceDirectoryEntry,
): number {
  return (
    workspaceDirectoryEntryTypeRank(left) -
      workspaceDirectoryEntryTypeRank(right) ||
    workspaceDirectoryEntryHiddenRank(left) -
      workspaceDirectoryEntryHiddenRank(right) ||
    left.name.localeCompare(right.name)
  );
}

type IpcMainBridgeState = {
  broadcastToRenderer?: (message: MainToRendererMessage) => void;
  handleRendererInvoke?: (channel: string, args: unknown[]) => Promise<unknown>;
  handleRendererSend?: (channel: string, args: unknown[]) => void;
};

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

function sanitizeOutboundMcpRequest(message: RendererToMainMessage): void {
  const result = sanitizeRendererInvokeMcpRequestPaths(message, os.homedir());
  if (!result) {
    return;
  }
  for (const change of result.changes) {
    console.log(
      `[mcp-request-sanitizer] ${result.method} ${change.key}: ${JSON.stringify(change.before)} -> ${change.after === null ? "dropped" : JSON.stringify(change.after)}`,
    );
  }
}

async function getWorkspaceDirectoryEntries({
  directoryPath,
  directoriesOnly,
}: {
  directoryPath: string | null;
  directoriesOnly: boolean;
}): Promise<WorkspaceDirectoryEntries> {
  const requestedPath = directoryPath?.trim() || os.homedir();
  const resolvedPath = path.resolve(requestedPath);
  const stat = await fs.stat(resolvedPath);
  if (!stat.isDirectory()) {
    throw new Error(`Directory not found: ${requestedPath}`);
  }

  const entries = (await fs.readdir(resolvedPath, { withFileTypes: true }))
    .flatMap((entry): WorkspaceDirectoryEntry[] => {
      const type = entry.isDirectory() ? "directory" : "file";
      if (directoriesOnly && type !== "directory") {
        return [];
      }

      return [
        {
          name: entry.name,
          path: path.join(resolvedPath, entry.name),
          type,
        },
      ];
    })
    .sort(compareWorkspaceDirectoryEntries);

  const rootPath = path.parse(resolvedPath).root;
  const parentPath =
    resolvedPath === rootPath ? null : path.dirname(resolvedPath);

  return {
    directoryPath: resolvedPath,
    parentPath,
    entries,
  };
}

function ensureElectronLikeProcessContext(): void {
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

async function startIpcBridgeServer(options: ServerOptions): Promise<void> {
  const bridgeState = getIpcMainBridgeState();
  const app = Fastify({ logger: false });
  const websocketServer = new WebSocketServer({ noServer: true });
  const serverEpoch = randomUUID();
  const bridgeCapacity = new ReliableBridgeCapacity();
  const sessions = new Map<
    string,
    ReliableBridgeSession<RendererToMainMessage, MainToRendererMessage>
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
    });

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

  await app.register(fastifyMultipart, {
    limits: {
      fileSize: Infinity,
    },
  });

  const uploadRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "codex-web-uploads-"),
  );

  app.post("/__backend/upload", async (request, reply) => {
    if (!request.isMultipart()) {
      return reply.code(400).send({ error: "expected multipart upload body" });
    }

    const files = await Array.fromAsync(
      (async function* () {
        for await (const part of request.files()) {
          const label = part.filename?.trim() || "upload";

          const uploadedPath = path.join(uploadRoot, randomUUID());

          await fs.writeFile(uploadedPath, await part.toBuffer());

          yield {
            label,
            path: uploadedPath,
            fsPath: uploadedPath,
          };
        }
      })(),
    );

    return reply.send({ files });
  });

  await app.register(fastifyStatic, {
    root: "/",
    prefix: "/@fs/",
    decorateReply: false,
  });

  await app.register(fastifyStatic, {
    root: path.resolve(__dirname, "../../scratch/asar/webview"),
    prefix: "/",
  });

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
            rendererRecovery.disposeRenderer(hello.connectionId);
            bridgeCapacity.releaseSession(hello.connectionId);
          },
          onMessage: (message) => handleRendererMessage(session!, message),
        });
        sessions.set(hello.connectionId, session);
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
      );
      return;
    }

    if (message.type === "ipc-renderer-send") {
      bridgeState.handleRendererSend?.(message.channel, message.args);
      return;
    }

    if (message.type === "workspace-directory-entries-request") {
      const { requestId } = message;
      getWorkspaceDirectoryEntries(message)
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
      const { channel, requestId, args } = message;
      sanitizeOutboundMcpRequest(message);
      Promise.resolve(
        bridgeState.handleRendererInvoke?.(channel, args) ??
          Promise.reject(
            new Error(`[ipc-bridge] no ipcMain.handle for channel ${channel}`),
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
            errorMessage: errorMessage(error),
          });
        });
    }
  }

  await app.listen({ host: options.host, port: options.port });
  console.log(`IPC bridge listening at ws://${options.host}:${options.port}`);

  ensureElectronLikeProcessContext();
  installModuleAliasHook();

  const packageJson = JSON.parse(
    await fs.readFile(
      path.resolve(__dirname, "../../scratch/asar/package.json"),
      "utf8",
    ),
  );

  globalThis.__CODEX_SHIM_VALUES__ = {
    version: packageJson.version,
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
  module.runMainAppStartup();
}

async function main(args: string[]) {
  const options = parseServerArgs(args);

  await startIpcBridgeServer(options);
}

main(process.argv.slice(2));
