const net = require("node:net");
const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { randomUUID } = require("node:crypto");
const { EventEmitter } = require("node:events");
const { FrameReader, encodeFrame } = require("../../scripts/desktop/ipc.cjs");
const { NativeHost } = require("../../scripts/desktop/native/host.cjs");
const { NativeReceipts } = require("../../scripts/desktop/native/receipts.cjs");
const { BINDING_ID } = require("../../scripts/desktop/native/contract.cjs");
const PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aHMsAAAAASUVORK5CYII=";
async function nativeAdapterFixture(directory) {
  const { dispatchNativeRenderer } = await import(
    pathToFileURL(
      path.resolve(__dirname, "../../scripts/desktop/native/renderer.mjs"),
    ).href
  );
  const fixture = {
    uploads: 0,
    submissions: [],
    uploadFiles: [],
    helperCloses: 0,
    active: true,
    pending: new Map(),
    originalApprovals: [],
    nativeResponses: [],
    sockets: new Set(),
    rendererCalls: [],
  };
  const conversation = {
    conversation_id: "native-chat",
    current_node: "parent-message",
    mapping: {},
  };
  const native = {
    target: async (id) =>
      id === conversation.conversation_id ? conversation : null,
    decodeImage: async (file) => {
      const bytes = Buffer.from(await file.arrayBuffer());
      return {
        width: bytes.readUInt32BE(16),
        height: bytes.readUInt32BE(20),
        close() {},
      };
    },
    upload: async (file) => {
      fixture.uploads++;
      fixture.uploadFiles.push(Buffer.from(await file.arrayBuffer()));
      if (fixture.holdUpload)
        await new Promise((resolve) => {
          fixture.releaseUpload = resolve;
        });
      return {
        id: "file_native_" + fixture.uploads,
        libraryFileId: "library-native-1",
        name: file.name,
        mimeType: file.type,
        size: file.size,
      };
    },
    // Fixture of the inspected Iqr/Jqr boundary, not a production substitute.
    prepare: ({ prompt, attachments }) => ({
      extraDeveloperInstructionMessages: [],
      message: {
        id: randomUUID(),
        author: { role: "user" },
        content: {
          content_type: "multimodal_text",
          parts: [
            ...attachments.map((a) => ({
              content_type: "image_asset_pointer",
              asset_pointer: "sediment://" + a.id,
              width: a.width,
              height: a.height,
              size_bytes: a.size,
            })),
            prompt,
          ],
        },
        metadata: {
          attachments: attachments.map((a) => ({ id: a.id, name: a.name })),
        },
      },
    }),
    submit: async (request) => {
      fixture.submissions.push(structuredClone(request));
      const message = request.prepared.bundle.message;
      conversation.mapping[message.id] = { message };
      conversation.current_node = message.id;
      if (fixture.holdSubmit)
        await new Promise((resolve) => {
          fixture.releaseSubmit = resolve;
        });
      return { messageId: message.id };
    },
  };
  const host = new NativeHost({
    receipts: new NativeReceipts(path.join(directory, "native-receipts")),
    renderer: (request) => {
      fixture.rendererCalls.push(request.op);
      return dispatchNativeRenderer(request, native);
    },
    hasActiveTurn: () => fixture.active,
    closeActiveTurn: async () => {
      fixture.helperCloses++;
      fixture.active = false;
      return true;
    },
  });
  fixture.host = host;
  fixture.conversation = conversation;
  fixture.native = native;
  const helper = new EventEmitter();
  helper.destroyed = false;
  fixture.helper = helper;
  fixture.metadata = {
    session_id: "native-chat",
    thread_id: "native-chat",
    turn_id: "original-cu-turn",
    item_id: "original-item",
    thread_source: "chatgpt",
    model: "native-model",
    reasoning_effort: "high",
  };
  const approvalBridge = {
    requestApprovalForSender(sender, params) {
      return new Promise((resolve) => {
        const id = "computer-use-approval:" + randomUUID();
        fixture.pending.set(id, resolve);
        const message = {
          id,
          jsonrpc: "2.0",
          method: "requestComputerUseApproval",
          params,
        };
        host.observeApproval(sender, message, () => fixture.pending.has(id));
        sender(message);
      });
    },
    handleApprovalResponse(message) {
      host.observeApprovalResponse(message);
      const resolve = fixture.pending.get(message.id);
      if (!resolve) return false;
      fixture.pending.delete(message.id);
      fixture.nativeResponses.push(message);
      resolve(message.result);
      return true;
    },
  };
  fixture.owner = host.observeOwner(
    helper,
    fixture.metadata,
    (message) => approvalBridge.handleApprovalResponse(message),
    "get_window_state",
  );
  fixture.offerApproval = (params) =>
    host.elicit(
      approvalBridge,
      (message) => fixture.originalApprovals.push(message),
      helper,
      fixture.metadata,
      params,
    );
  fixture.capture = () =>
    host.observeResult(helper, fixture.metadata, "get_window_state", {
      screenshots: [
        {
          id: "original-screenshot",
          url: "data:image/png;base64," + PNG,
          width: 1,
          height: 1,
        },
      ],
    });
  const endpoint =
    process.platform === "win32"
      ? "\\\\.\\pipe\\codex-web-native-" + randomUUID()
      : path.join(directory, "native.sock");
  const config = {
    enabled: true,
    bindingId: BINDING_ID,
    desktopVersion: "26.908.40834",
    planSha256: "a".repeat(64),
    patchedArchiveSha256: "b".repeat(64),
    token: randomUUID() + randomUUID(),
    endpoint,
  };
  fixture.config = config;
  const states = new Map();
  const send = (socket, message) => {
    if (!socket.destroyed) socket.write(encodeFrame(message));
  };
  host.on("state", (state) => {
    for (const [socket, owners] of states)
      if (owners.has(state.ownerId))
        send(socket, { event: "native/cu/state", data: state });
  });
  host.on("capture", (frame) => {
    for (const [socket, owners] of states)
      if (owners.has(frame.ownerId))
        send(socket, { event: "native/cu/capture", data: frame });
  });
  host.on("captureStatus", (status) => {
    for (const socket of states.keys())
      send(socket, { event: "native/capture/status", data: status });
  });
  const server = net.createServer((socket) => {
    fixture.sockets.add(socket);
    states.set(socket, new Set());
    let authenticated = false;
    const reader = new FrameReader(async (message) => {
      try {
        if (!authenticated) {
          if (
            message.method !== "native/hello" ||
            message.params.token !== config.token
          ) {
            socket.destroy();
            return;
          }
          await host.verify();
          authenticated = true;
          send(socket, {
            id: message.id,
            result: {
              ...host.capabilities(),
              desktopVersion: config.desktopVersion,
              planSha256: config.planSha256,
              patchedArchiveSha256: fixture.wrongHash
                ? "c".repeat(64)
                : config.patchedArchiveSha256,
            },
          });
          return;
        }
        const result = await host.dispatch(message.method, message.params);
        if (["native/cu/attach", "native/cu/sync"].includes(message.method))
          states.get(socket)?.add(result.ownerId);
        send(socket, { id: message.id, result });
      } catch (error) {
        send(socket, {
          id: message.id,
          error: {
            message: error.message,
            deliveryUnknown: error.deliveryUnknown === true,
          },
        });
      }
    });
    socket.on("data", (chunk) => {
      try {
        reader.push(chunk);
      } catch {
        socket.destroy();
      }
    });
    socket.on("error", () => {});
    socket.on("close", () => {
      fixture.sockets.delete(socket);
      states.delete(socket);
    });
  });
  await new Promise((resolve) => server.listen(endpoint, resolve));
  fixture.close = async () => {
    for (const socket of fixture.sockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
  };
  return fixture;
}
module.exports = { nativeAdapterFixture, PNG };
