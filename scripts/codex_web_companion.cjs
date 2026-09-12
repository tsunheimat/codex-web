#!/usr/bin/env node

/*
 * Outbound target companion. It keeps the local app-server on the computer and
 * opens one authenticated WSS connection to the gateway, so the gateway can
 * own sessions without requiring an inbound port on the computer.
 */
const { spawn } = require("node:child_process");
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
    const message = JSON.parse(String(raw));
    if (message.type === "agent-ready") {
      relayReady = true;
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
