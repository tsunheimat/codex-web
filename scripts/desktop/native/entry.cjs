// Entry point for the proposed in-process Desktop patch. No network listener.
// Absence of the separately approved configuration leaves every hook inert.
const fs = require("node:fs");
const path = require("node:path");
const net = require("node:net");
const { createHash, timingSafeEqual, randomUUID } = require("node:crypto");
const { FrameReader, encodeFrame } = require("./ipc.cjs");
const { NativeHost } = require("./host.cjs");
const { NativeReceipts } = require("./receipts.cjs");
const {
  BINDING_ID,
  METHODS,
  FRAME_LIMIT,
  checkedId,
} = require("./contract.cjs");
let host,
  approval,
  electron,
  computerUse,
  clients = new Set();
function equal(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const x = Buffer.from(a),
    y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
function write(client, message, capture = false) {
  if (!client.socket.writable) return;
  if (capture && client.socket.writableLength > 65536) return;
  if (!capture && client.socket.writableLength > 2 * 1024 * 1024) {
    client.socket.destroy();
    return;
  }
  try {
    client.socket.write(encodeFrame(message, FRAME_LIMIT));
  } catch {
    client.socket.destroy();
  }
}
function normalizeImage(url) {
  const image = electron.nativeImage.createFromDataURL(url),
    size = image.getSize();
  if (!size.width || !size.height) return null;
  const scale = Math.min(1, 1600 / size.width, 1000 / size.height);
  return (
    "data:image/jpeg;base64," +
    image
      .resize({
        width: Math.max(1, Math.round(size.width * scale)),
        height: Math.max(1, Math.round(size.height * scale)),
      })
      .toJPEG(65)
      .toString("base64")
  );
}
function decodeToolResult(result) {
  if (!result?.success)
    throw new Error("Native renderer operation was not acknowledged");
  return JSON.parse(
    result.contentItems.find((i) => i.type === "inputText").text,
  );
}
function bindAppTools(appElectron, callTool) {
  electron = appElectron;
  const directory = path.join(
    electron.app.getPath("userData"),
    "codex-web-native",
  );
  try {
    approval = JSON.parse(
      fs.readFileSync(path.join(directory, "approved.json"), "utf8"),
    );
  } catch {
    return;
  }
  if (
    approval.enabled !== true ||
    approval.bindingId !== BINDING_ID ||
    approval.desktopVersion !== electron.app.getVersion() ||
    !/^[a-f0-9]{64}$/.test(approval.planSha256 ?? "") ||
    typeof approval.token !== "string" ||
    approval.token.length < 32 ||
    !/^\\\\\.\\pipe\\codex-web-native-[\da-f-]+$/.test(approval.endpoint)
  )
    return;
  const actual = createHash("sha256")
    .update(fs.readFileSync(path.join(process.resourcesPath, "app.asar")))
    .digest("hex");
  if (actual !== approval.patchedArchiveSha256) return;
  let contextThreadId;
  host = new NativeHost({
    receipts: new NativeReceipts(path.join(directory, "receipts")),
    normalizeImage,
    renderer: async (request) => {
      const id = randomUUID();
      return decodeToolResult(
        await callTool({
          namespace: "codex_app",
          tool: "codex_web_native_v1",
          arguments: request,
          callId: id,
          threadId: contextThreadId,
          turnId: "codex-web-native-adapter",
        }),
      );
    },
  });
  if (computerUse) bindComputerUse(computerUse);
  host.on("state", (state) => {
    for (const client of clients)
      if (client.owners.has(state.ownerId))
        write(client, { event: "native/cu/state", data: state });
  });
  host.on("capture", (frame) => {
    for (const client of clients)
      if (client.owners.has(frame.ownerId))
        client.frames.set(frame.ownerId, frame);
  });
  host.on("captureStatus", (status) => {
    for (const client of clients)
      if (client.authenticated)
        write(client, { event: "native/capture/status", data: status });
  });
  const server = net.createServer((socket) => {
    const client = {
      socket,
      owners: new Set(),
      frames: new Map(),
      authenticated: false,
      inflight: 0,
    };
    clients.add(client);
    const timeout = setTimeout(() => socket.destroy(), 5000);
    const frames = setInterval(() => {
      for (const frame of client.frames.values())
        write(client, { event: "native/cu/capture", data: frame }, true);
      client.frames.clear();
    }, 200);
    const reader = new FrameReader(async (message) => {
      try {
        checkedId(message.id);
        if (!client.authenticated) {
          if (
            message.method !== "native/hello" ||
            !equal(message.params?.token, approval.token) ||
            message.params.bindingId !== BINDING_ID ||
            message.params.planSha256 !== approval.planSha256
          )
            throw new Error("Native authentication rejected");
          contextThreadId = checkedId(message.params.contextThreadId);
          await host.verify();
          client.authenticated = true;
          clearTimeout(timeout);
          write(client, {
            id: message.id,
            result: {
              ...host.capabilities(),
              desktopVersion: approval.desktopVersion,
              planSha256: approval.planSha256,
              patchedArchiveSha256: actual,
              captureStatuses: [...host.captureStatuses.values()],
            },
          });
          return;
        }
        if (!METHODS.has(message.method) || client.inflight >= 16)
          throw new Error("Native operation unavailable");
        client.inflight++;
        try {
          const result = await host.dispatch(
            message.method,
            message.params ?? {},
          );
          if (
            message.method === "native/cu/attach" ||
            message.method === "native/cu/sync"
          ) {
            client.owners.add(result.ownerId);
            const latest = host.owners.get(result.ownerId)?.capture;
            if (latest) client.frames.set(result.ownerId, latest);
          }
          write(client, { id: message.id, result });
        } finally {
          client.inflight--;
        }
      } catch (error) {
        if (!client.authenticated) {
          socket.destroy();
          return;
        }
        write(client, {
          id: message.id,
          error: {
            message: error.message,
            deliveryUnknown: error.deliveryUnknown === true,
          },
        });
      }
    }, FRAME_LIMIT);
    socket.on("data", (chunk) => {
      try {
        reader.push(chunk);
      } catch {
        socket.destroy();
      }
    });
    socket.on("error", () => {});
    socket.on("close", () => {
      clearTimeout(timeout);
      clearInterval(frames);
      clients.delete(client);
    });
    // Closing this observer channel never closes a helper, rejects its approval,
    // or cancels an in-flight upload/message operation.
  });
  server.on("error", () => {
    host.ready = false;
  });
  server.listen(approval.endpoint);
  electron.app.on("will-quit", () => {
    for (const c of clients) c.socket.destroy();
    server.close();
  });
}
function bindComputerUse(service) {
  computerUse = service;
  if (!host) return;
  const originalClose = service.closeActiveTurn;
  host.closeActiveTurn = originalClose;
  host.hasActiveTurn = service.hasActiveTurn;
  service.closeActiveTurn = async (metadata) => {
    const result = await originalClose(metadata);
    if (result)
      for (const owner of host.owners.values())
        if (
          owner.metadata.session_id === metadata.sessionId &&
          owner.turnId === metadata.turnId
        )
          host.end(owner, "completed");
    return result;
  };
}
module.exports = {
  bindAppTools,
  bindComputerUse,
  observeOwner: (...args) => {
    try {
      return host?.observeOwner(...args);
    } catch {}
  },
  observeResult: (...args) => {
    try {
      host?.observeResult(...args);
    } catch {}
  },
  observeApproval: (...args) => {
    try {
      host?.observeApproval(...args);
    } catch {}
  },
  observeApprovalResponse: (...args) => {
    try {
      host?.observeApprovalResponse(...args);
    } catch {}
  },
  observePresentation: (...args) => {
    try {
      host?.observePresentation(...args);
    } catch {}
  },
  elicit: (bridge, sender, socket, metadata, params) =>
    host
      ? host.elicit(bridge, sender, socket, metadata, params)
      : bridge.requestApprovalForSender(sender, params),
};
