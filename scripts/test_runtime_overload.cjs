#!/usr/bin/env node

const assert = require("node:assert/strict");
const { WebSocket } = require("ws");

const baseUrl = process.env.CODEX_WEB_SMOKE_URL ?? "http://127.0.0.1:8214";
const websocketUrl = `${baseUrl.replace(/^http/, "ws")}/__backend/ipc`;
const sockets = new Set();

function connect() {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(websocketUrl);
    sockets.add(socket);
    socket.once("open", () => resolve(socket));
    socket.once("error", reject);
    socket.once("close", () => sockets.delete(socket));
  });
}

function nextFrame(socket, predicate, timeoutMs = 5_000) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      socket.off("message", onMessage);
      reject(new Error("timed out waiting for reliable bridge frame"));
    }, timeoutMs);
    const onMessage = (rawData) => {
      const frame = JSON.parse(String(rawData));
      if (!predicate(frame)) return;
      clearTimeout(timeout);
      socket.off("message", onMessage);
      resolve(frame);
    };
    socket.on("message", onMessage);
  });
}

async function handshake(socket, connectionId, serverEpoch) {
  const frame = nextFrame(
    socket,
    (candidate) =>
      candidate.type === "bridge-ready" || candidate.type === "bridge-reset",
  );
  socket.send(
    JSON.stringify({
      type: "bridge-hello",
      protocolVersion: 2,
      connectionId,
      serverEpoch,
    }),
  );
  return await frame;
}

async function disconnect(socket) {
  if (socket.readyState !== WebSocket.OPEN) return;
  const closed = new Promise((resolve) => socket.once("close", resolve));
  socket.send(JSON.stringify({ type: "bridge-disconnect" }));
  await closed;
}

async function main() {
  const retained = [];
  let serverEpoch = null;

  try {
    for (let index = 0; index < 16; index += 1) {
      const socket = await connect();
      const ready = await handshake(
        socket,
        `runtime-overload-${process.pid}-${index}`,
        null,
      );
      assert.equal(ready.type, "bridge-ready");
      serverEpoch ??= ready.serverEpoch;
      assert.equal(ready.serverEpoch, serverEpoch);
      retained.push(socket);
    }

    const rejected = await connect();
    const reset = await handshake(
      rejected,
      `runtime-overload-${process.pid}-rejected`,
      null,
    );
    assert.equal(reset.type, "bridge-reset");
    assert.equal(reset.reason, "reliable bridge session capacity exceeded");
    rejected.terminate();

    const firstConnectionId = `runtime-overload-${process.pid}-0`;
    retained[0].terminate();
    const replacement = await connect();
    const reconnectReady = await handshake(
      replacement,
      firstConnectionId,
      serverEpoch,
    );
    assert.equal(reconnectReady.type, "bridge-ready");
    retained[0] = replacement;

    await disconnect(retained.pop());
    const accepted = await connect();
    const acceptedReady = await handshake(
      accepted,
      `runtime-overload-${process.pid}-after-release`,
      null,
    );
    assert.equal(acceptedReady.type, "bridge-ready");
    retained.push(accepted);

    console.log(
      "Codex Web retained-session overload/reconnect runtime smoke passed.",
    );
  } finally {
    await Promise.all([...sockets].map((socket) => disconnect(socket)));
  }
}

main().catch((error) => {
  for (const socket of sockets) socket.terminate();
  console.error(error);
  process.exitCode = 1;
});
