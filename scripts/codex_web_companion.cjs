#!/usr/bin/env node

/*
 * Outbound target companion. It keeps the local app-server on the computer and
 * opens one authenticated WSS connection to the gateway, so the gateway can
 * own sessions without requiring an inbound port on the computer.
 */
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const readline = require("node:readline");
const { WebSocket } = require("ws");

const gateway = process.env.CODEX_WEB_COMPANION_GATEWAY;
const backendId = process.env.CODEX_WEB_COMPANION_BACKEND;
const token = process.env.CODEX_WEB_COMPANION_TOKEN;
const command = process.env.CODEX_WEB_COMPANION_COMMAND || "codex";
const args = process.env.CODEX_WEB_COMPANION_ARGS
  ? JSON.parse(process.env.CODEX_WEB_COMPANION_ARGS)
  : ["app-server", "--listen", "stdio://"];
if (!gateway || !backendId || !token)
  throw new Error(
    "Set CODEX_WEB_COMPANION_GATEWAY, CODEX_WEB_COMPANION_BACKEND and CODEX_WEB_COMPANION_TOKEN",
  );
if (!gateway.startsWith("wss://") && !gateway.startsWith("ws://"))
  throw new Error("The companion gateway must use ws:// or wss://");
const configuredRoot = fs.realpathSync(
  process.env.CODEX_WEB_COMPANION_ROOT || process.cwd(),
);
if (!fs.statSync(configuredRoot).isDirectory())
  throw new Error("CODEX_WEB_COMPANION_ROOT must be a directory");
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
const UPLOAD_QUOTA_BYTES = 100 * 1024 * 1024;
const uploadExtensions = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".webp",
  ".gif",
  ".txt",
  ".pdf",
  ".md",
  ".csv",
]);
function safeRoot(value) {
  const candidate = fs.realpathSync(path.resolve(value || configuredRoot));
  if (
    candidate !== configuredRoot &&
    !candidate.startsWith(configuredRoot + path.sep)
  )
    throw new Error("Path is outside the companion workspace");
  return candidate;
}
function safePath(root, value) {
  const candidate = path.resolve(root, value || ".");
  const resolved = fs.realpathSync(candidate);
  if (resolved !== root && !resolved.startsWith(root + path.sep))
    throw new Error("Path is outside the companion workspace");
  return resolved;
}
function fileControl(message) {
  const root = safeRoot(message.root);
  if (message.action === "list") {
    const directory = safePath(root, message.path);
    if (!fs.statSync(directory).isDirectory())
      throw new Error("Expected directory");
    const entries = fs
      .readdirSync(directory, { withFileTypes: true })
      .map((entry) => {
        try {
          const entryPath = safePath(root, path.join(directory, entry.name));
          return {
            name: entry.name,
            path: entryPath,
            directory: fs.statSync(entryPath).isDirectory(),
          };
        } catch {
          return null;
        }
      })
      .filter(Boolean)
      .sort(
        (a, b) =>
          Number(b.directory) - Number(a.directory) ||
          a.name.localeCompare(b.name),
      );
    if (entries.length > 1000)
      throw new Error("Directory exceeds 1000 entries");
    return { path: directory, root, entries };
  }
  if (message.action === "read") {
    const file = safePath(root, message.path);
    if (!fs.statSync(file).isFile()) throw new Error("Expected a regular file");
    const data = fs.readFileSync(file);
    if (data.length > MAX_UPLOAD_BYTES) throw new Error("File exceeds 10 MiB");
    return { name: path.basename(file), data: data.toString("base64") };
  }
  if (message.action === "upload") {
    if (typeof message.data !== "string")
      throw new Error("Invalid upload data");
    const data = Buffer.from(message.data, "base64");
    if (data.length > MAX_UPLOAD_BYTES)
      throw new Error("Upload exceeds 10 MiB");
    const folderCandidate = path.join(root, ".codex-web-uploads");
    fs.mkdirSync(folderCandidate, { recursive: true, mode: 0o700 });
    const folder = safePath(root, ".codex-web-uploads");
    if (fs.lstatSync(folder).isSymbolicLink())
      throw new Error("Upload directory must not be a symlink");
    const total = fs.readdirSync(folder).reduce((sum, name) => {
      try {
        const stat = fs.statSync(path.join(folder, name));
        return sum + (stat.isFile() ? stat.size : 0);
      } catch {
        return sum;
      }
    }, 0);
    if (total + data.length > UPLOAD_QUOTA_BYTES)
      throw new Error("Workspace upload quota reached");
    const original = typeof message.name === "string" ? message.name : "";
    const suffix = uploadExtensions.has(path.extname(original).toLowerCase())
      ? path.extname(original).toLowerCase()
      : ".bin";
    const target = path.join(folder, randomUUID().replaceAll("-", "") + suffix);
    const fd = fs.openSync(target, "wx", 0o600);
    try {
      fs.writeFileSync(fd, data);
    } finally {
      fs.closeSync(fd);
    }
    return { path: target, bytes: data.length, name: original };
  }
  throw new Error("Unsupported companion control action");
}

const runtime = spawn(command, args, { stdio: ["pipe", "pipe", "inherit"] });
let socket = null;
let runtimeInitialized = false;
let relayReady = false;
let stopping = false;
let reconnectDelay = 500;
const runtimeLines = readline.createInterface({ input: runtime.stdout });
runtimeLines.on("line", (line) => {
  if (!relayReady || !socket || socket.readyState !== WebSocket.OPEN) return;
  socket.send(line);
});
runtime.stdin.on("error", () => {});
function connect() {
  if (stopping) return;
  const next = new WebSocket(gateway.replace(/\/$/, "") + "/api/v1/agent");
  socket = next;
  next.on("open", () => {
    reconnectDelay = 500;
    next.send(
      JSON.stringify({
        type: "agent-authenticate",
        version: 1,
        backendId,
        token,
        runtimeInitialized,
      }),
    );
  });
  next.on("message", (raw) => {
    let message;
    try {
      message = JSON.parse(String(raw));
    } catch {
      next.close(1003, "Invalid JSON");
      return;
    }
    if (message.type === "agent-ready") {
      relayReady = true;
      return;
    }
    if (message.type === "companion-control") {
      try {
        next.send(
          JSON.stringify({
            type: "companion-result",
            requestId: message.requestId,
            result: fileControl(message),
          }),
        );
      } catch (error) {
        next.send(
          JSON.stringify({
            type: "companion-result",
            requestId: message.requestId,
            error: error instanceof Error ? error.message : "Control failed",
          }),
        );
      }
      return;
    }
    if (message.method === "initialized") runtimeInitialized = true;
    runtime.stdin.write(String(raw) + "\n");
  });
  next.on("error", () => {});
  next.on("close", () => {
    relayReady = false;
    if (socket !== next || stopping) return;
    reconnectDelay = Math.min(reconnectDelay * 2, 15_000);
    setTimeout(connect, reconnectDelay).unref();
  });
}
connect();
const stop = () => {
  stopping = true;
  socket?.close();
  runtime.kill("SIGTERM");
};
runtime.on("exit", () => {
  stopping = true;
  socket?.close();
});
process.once("SIGINT", stop);
process.once("SIGTERM", stop);
