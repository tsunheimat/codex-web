#!/usr/bin/env node

const net = require("node:net");
const WebSocket = require("ws");

const socketPath = process.env.CODEX_UNIX_SOCKET;
if (!socketPath) {
  console.error("CODEX_UNIX_SOCKET is required");
  process.exit(64);
}

const MAX_PAYLOAD_BYTES = 100 * 1024 * 1024;
const MAX_QUEUED_BYTES = 128 * 1024 * 1024;
const CLOSE_GRACE_MS = 1_000;

let closing = false;
let stdinBuffer = Buffer.alloc(0);
let queuedBytes = 0;
let sendInFlight = false;
const sendQueue = [];

function fail(error) {
  if (closing) return;
  closing = true;
  console.error(error instanceof Error ? error.stack : String(error));
  websocket.terminate();
  process.exitCode = 1;
}

function enqueueLine(line) {
  if (line.length === 0) return;
  if (line.length > MAX_PAYLOAD_BYTES) {
    fail(new Error("app-server proxy stdin message exceeds max payload"));
    return;
  }
  try {
    JSON.parse(line.toString("utf8"));
  } catch {
    fail(new Error("app-server proxy stdin contained invalid JSON"));
    return;
  }
  queuedBytes += line.length;
  if (queuedBytes > MAX_QUEUED_BYTES) {
    fail(new Error("app-server proxy stdin queue exceeded its byte limit"));
    return;
  }
  sendQueue.push(line.toString("utf8"));
  pumpSendQueue();
}

function pumpSendQueue() {
  if (
    closing ||
    sendInFlight ||
    websocket.readyState !== WebSocket.OPEN ||
    sendQueue.length === 0
  ) {
    return;
  }
  const message = sendQueue.shift();
  queuedBytes -= Buffer.byteLength(message);
  sendInFlight = true;
  websocket.send(message, { binary: false }, (error) => {
    sendInFlight = false;
    if (error) {
      fail(error);
      return;
    }
    pumpSendQueue();
  });
}

function consumeStdin(chunk) {
  if (closing) return;
  stdinBuffer = Buffer.concat([stdinBuffer, chunk]);
  if (stdinBuffer.length > MAX_PAYLOAD_BYTES && !stdinBuffer.includes(0x0a)) {
    fail(new Error("app-server proxy stdin line exceeds max payload"));
    return;
  }
  while (true) {
    const newline = stdinBuffer.indexOf(0x0a);
    if (newline === -1) return;
    let line = stdinBuffer.subarray(0, newline);
    stdinBuffer = stdinBuffer.subarray(newline + 1);
    if (line.at(-1) === 0x0d) line = line.subarray(0, -1);
    enqueueLine(line);
  }
}

function shutdown() {
  if (closing) return;
  closing = true;
  process.stdin.pause();
  if (websocket.readyState === WebSocket.CLOSED) return;
  if (
    websocket.readyState === WebSocket.OPEN ||
    websocket.readyState === WebSocket.CONNECTING
  ) {
    websocket.close(1000, "proxy shutdown");
    setTimeout(() => websocket.terminate(), CLOSE_GRACE_MS).unref();
  }
}

const websocket = new WebSocket("ws://localhost/", {
  createConnection: () => net.createConnection({ path: socketPath }),
  maxPayload: MAX_PAYLOAD_BYTES,
  perMessageDeflate: false,
});

websocket.on("open", pumpSendQueue);
websocket.on("message", (data, isBinary) => {
  if (closing) return;
  if (isBinary) {
    fail(new Error("app-server proxy received an unexpected binary frame"));
    return;
  }
  const message = Buffer.isBuffer(data) ? data : Buffer.from(data);
  if (message.length > MAX_PAYLOAD_BYTES) {
    fail(new Error("app-server proxy received message exceeds max payload"));
    return;
  }
  const messageWritable = process.stdout.write(message);
  const newlineWritable = process.stdout.write("\n");
  if (!messageWritable || !newlineWritable) {
    websocket.pause();
  }
});
websocket.on("error", fail);
websocket.on("close", (code, reason) => {
  if (!closing && code !== 1000) {
    console.error(
      `app-server proxy WebSocket closed unexpectedly (${code}): ${reason}`,
    );
    process.exitCode = 1;
  }
  closing = true;
  process.stdin.pause();
  setImmediate(() => process.exit(process.exitCode ?? 0));
});

process.stdout.on("drain", () => websocket.resume());
process.stdin.on("data", consumeStdin);
process.stdin.on("end", () => {
  if (stdinBuffer.length > 0) enqueueLine(stdinBuffer);
  shutdown();
});
process.stdin.on("error", fail);
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
