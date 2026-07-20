const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { WebSocket } = require("ws");

const baseUrl = process.env.CODEX_WEB_SMOKE_URL ?? "http://127.0.0.1:8214";
const websocketUrl = `${baseUrl.replace(/^http/, "ws")}/__backend/ipc`;
const expectedBrowseRoot = fs.realpathSync(
  path.resolve(process.env.CODEX_WEBUI_BROWSE_ROOT ?? os.homedir()),
);

async function assertCachePolicy(pathname, expected) {
  const response = await fetch(`${baseUrl}${pathname}`);
  assert.equal(response.status, 200, pathname);
  assert.equal(response.headers.get("cache-control"), expected, pathname);
  await response.body?.cancel();
}

function connect() {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(websocketUrl);
    socket.once("open", () => resolve(socket));
    socket.once("error", reject);
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
  const ready = nextFrame(socket, (frame) => frame.type === "bridge-ready");
  socket.send(
    JSON.stringify({
      type: "bridge-hello",
      protocolVersion: 2,
      connectionId,
      serverEpoch,
    }),
  );
  return ready;
}

async function sendBridgeData(socket, id, ack, message) {
  const accepted = nextFrame(
    socket,
    (frame) => frame.type === "bridge-ack" && frame.ack === id,
  );
  socket.send(
    JSON.stringify({
      type: "bridge-data",
      id,
      ack,
      message,
    }),
  );
  await accepted;
}

async function requestWorkspaceDirectories(socket, id, ack, requestId) {
  const result = nextFrame(
    socket,
    (frame) =>
      frame.type === "bridge-data" && frame.message?.requestId === requestId,
  );
  socket.send(
    JSON.stringify({
      type: "bridge-data",
      id,
      ack,
      message: {
        type: "workspace-directory-entries-request",
        requestId,
        directoryPath: null,
        directoriesOnly: true,
      },
    }),
  );
  const resultFrame = await result;
  assert.equal(resultFrame.message.ok, true);
  assert.equal(resultFrame.message.result.directoryPath, expectedBrowseRoot);
  socket.send(JSON.stringify({ type: "bridge-ack", ack: resultFrame.id }));
  return resultFrame;
}

async function main() {
  await assertCachePolicy("/", "no-cache");
  await assertCachePolicy("/assets/preload.js", "no-cache");
  await assertCachePolicy(
    "/assets/app-initial~app-main~page-BF1QkwFT.js",
    "public, max-age=31536000, immutable",
  );
  await assertCachePolicy("/assets/missing-BF1QkwFT.js", "no-cache");

  const connectionId = `runtime-smoke-${process.pid}`;
  const first = await connect();
  const firstReady = await handshake(first, connectionId, null);
  assert.equal(firstReady.connectionId, connectionId);
  assert.equal(typeof firstReady.serverEpoch, "string");

  const result = nextFrame(
    first,
    (frame) =>
      frame.type === "bridge-data" &&
      frame.message?.type === "workspace-directory-entries-result",
  );
  first.send(
    JSON.stringify({
      type: "bridge-data",
      id: 1,
      ack: 0,
      message: {
        type: "workspace-directory-entries-request",
        requestId: "runtime-smoke-directory",
        directoryPath: null,
        directoriesOnly: true,
      },
    }),
  );
  const resultFrame = await result;
  assert.equal(resultFrame.id, 1);
  assert.equal(resultFrame.message.ok, true);
  assert.equal(resultFrame.message.result.directoryPath, expectedBrowseRoot);
  first.send(JSON.stringify({ type: "bridge-ack", ack: resultFrame.id }));
  first.terminate();

  const second = await connect();
  const secondReady = await handshake(
    second,
    connectionId,
    firstReady.serverEpoch,
  );
  assert.equal(secondReady.serverEpoch, firstReady.serverEpoch);

  let duplicateResult = false;
  const duplicateListener = (rawData) => {
    const frame = JSON.parse(String(rawData));
    if (
      frame.type === "bridge-data" &&
      frame.message?.requestId === "runtime-smoke-directory"
    ) {
      duplicateResult = true;
    }
  };
  second.on("message", duplicateListener);
  second.send(
    JSON.stringify({
      type: "bridge-data",
      id: 1,
      ack: 1,
      message: {
        type: "workspace-directory-entries-request",
        requestId: "runtime-smoke-directory",
        directoryPath: process.cwd(),
        directoriesOnly: true,
      },
    }),
  );
  await new Promise((resolve) => setTimeout(resolve, 150));
  second.off("message", duplicateListener);
  assert.equal(duplicateResult, false);
  second.send(JSON.stringify({ type: "bridge-disconnect" }));

  const stale = await connect();
  const reset = nextFrame(stale, (frame) => frame.type === "bridge-reset");
  stale.send(
    JSON.stringify({
      type: "bridge-hello",
      protocolVersion: 2,
      connectionId: `${connectionId}-stale`,
      serverEpoch: `${firstReady.serverEpoch}-stale`,
    }),
  );
  assert.equal((await reset).reason, "backend restarted");
  stale.terminate();

  const rendererA = await connect();
  const rendererAReady = await handshake(
    rendererA,
    `${connectionId}-renderer-a`,
    null,
  );
  const rendererAResets = [];
  rendererA.on("message", (rawData) => {
    const frame = JSON.parse(String(rawData));
    if (frame.type === "bridge-reset") rendererAResets.push(frame.reason);
  });
  await sendBridgeData(rendererA, 1, 0, {
    type: "renderer-bridge-ready",
    currentThreadId: null,
  });

  const rendererB = await connect();
  const rendererBReady = await handshake(
    rendererB,
    `${connectionId}-renderer-b`,
    null,
  );
  assert.equal(rendererBReady.serverEpoch, rendererAReady.serverEpoch);
  const rendererBResets = [];
  rendererB.on("message", (rawData) => {
    const frame = JSON.parse(String(rawData));
    if (frame.type === "bridge-reset") rendererBResets.push(frame.reason);
  });
  const rendererBRecovery = nextFrame(
    rendererB,
    (frame) =>
      frame.type === "bridge-data" &&
      frame.message?.type === "ipc-main-event" &&
      frame.message?.args?.[0]?.type === "codex-app-server-connection-changed",
  );
  await sendBridgeData(rendererB, 1, 0, {
    type: "renderer-bridge-ready",
    currentThreadId: null,
  });
  const recoveryFrame = await rendererBRecovery;

  assert.equal(rendererA.readyState, WebSocket.OPEN);
  assert.equal(rendererB.readyState, WebSocket.OPEN);
  const rendererAResult = await requestWorkspaceDirectories(
    rendererA,
    2,
    0,
    "runtime-smoke-renderer-a-directory",
  );
  const rendererBResult = await requestWorkspaceDirectories(
    rendererB,
    2,
    recoveryFrame.id,
    "runtime-smoke-renderer-b-directory",
  );
  assert.equal(rendererAResult.id, 1);
  assert.equal(rendererBResult.id, recoveryFrame.id + 1);
  assert.deepEqual(rendererAResets, []);
  assert.deepEqual(rendererBResets, []);
  assert.equal(rendererA.readyState, WebSocket.OPEN);
  assert.equal(rendererB.readyState, WebSocket.OPEN);
  rendererA.send(JSON.stringify({ type: "bridge-disconnect" }));
  rendererB.send(JSON.stringify({ type: "bridge-disconnect" }));

  console.log(
    "Codex Web local HTTP/reliable-bridge and multi-renderer runtime smoke passed.",
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
