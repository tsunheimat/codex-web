const net = require("node:net");
const fs = require("node:fs/promises");
const { randomUUID } = require("node:crypto");
const { FrameReader, encodeFrame, DesktopError } = require("./ipc.cjs");

// This is the existing Desktop app-tools pipe, not an MCP server we launch.
// Only these three native actions can be reached by the network adapter.
const ALLOWED = new Set([
  "list_threads",
  "read_thread",
  "send_message_to_thread",
]);
function nativeRequest(endpoint, message, timeout = 15000) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(endpoint);
    let finished = false;
    const finish = (error, result) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      socket.destroy();
      error ? reject(error) : resolve(result);
    };
    const timer = setTimeout(
      () =>
        finish(
          new DesktopError(
            "NATIVE_TIMEOUT",
            "Desktop app-tools request timed out; do not resend a message without reconciling",
            message.method === "tools/call",
          ),
        ),
      timeout,
    );
    const reader = new FrameReader(
      (reply) => {
        if (reply.id !== message.id) return;
        if (reply.error)
          finish(new DesktopError("NATIVE_REJECTED", reply.error.message));
        else finish(null, reply.result);
      },
      8 * 1024 * 1024,
    );
    socket.once("connect", () =>
      socket.write(encodeFrame(message, 8 * 1024 * 1024)),
    );
    socket.on("data", (chunk) => {
      try {
        reader.push(chunk);
      } catch (error) {
        finish(error);
      }
    });
    socket.on("error", (error) =>
      finish(
        new DesktopError(
          "NATIVE_PIPE",
          `Desktop app-tools pipe unavailable (${error.code})`,
        ),
      ),
    );
    socket.once("end", () =>
      finish(
        new DesktopError(
          "NATIVE_CLOSED",
          "Desktop app-tools pipe closed before acknowledgement",
          true,
        ),
      ),
    );
  });
}
async function discoverNativeTools() {
  let candidates = [process.env.CODEX_APP_TOOLS_PIPE_PATH].filter(Boolean);
  if (process.platform === "win32") {
    const names = await fs.readdir("\\\\.\\pipe\\");
    candidates.push(
      ...names
        .filter((n) => /^codex-browser-use-[\da-f-]+$/.test(n))
        .slice(0, 64)
        .map((n) => "\\\\.\\pipe\\" + n),
    );
  }
  for (const endpoint of [...new Set(candidates)]) {
    try {
      const catalog = await nativeRequest(
        endpoint,
        {
          jsonrpc: "2.0",
          id: randomUUID(),
          method: "tools/list",
          params: { threadStartKind: "all" },
        },
        endpoint === process.env.CODEX_APP_TOOLS_PIPE_PATH ? 10000 : 1000,
      );
      if (
        [...ALLOWED].every((name) =>
          catalog?.tools?.some(
            (t) => t.namespace === "codex_app" && t.name === name,
          ),
        )
      )
        return { endpoint };
    } catch {
      /* A browser pipe is not the app-tools pipe. Never invoke tools on it. */
    }
  }
  return null;
}
function unpackNativeResult(result) {
  // Dynamic tools return app-server contentItems, while some builds use MCP content.
  if (result?.isError || result?.success === false)
    throw new DesktopError(
      "NATIVE_REJECTED",
      "Desktop native handler rejected the action",
    );
  if (result?.structuredContent) return result.structuredContent;
  for (const item of result?.contentItems ?? result?.content ?? []) {
    const text = item.text;
    if (typeof text === "string") {
      try {
        return JSON.parse(text);
      } catch {}
    }
  }
  throw new DesktopError(
    "NATIVE_FORMAT",
    "Desktop app-tools handler returned an unrecognized result; update the bridge for this build",
  );
}
class NativeTools {
  constructor(endpoint, originThreadId) {
    this.endpoint = endpoint;
    this.originThreadId = originThreadId;
  }
  async call(tool, args) {
    if (!ALLOWED.has(tool))
      throw new DesktopError(
        "UNSUPPORTED",
        "Native action is not exposed by the bridge",
      );
    if (!this.originThreadId)
      throw new DesktopError(
        "NATIVE_ORIGIN",
        "A Desktop-owned Codex conversation is required as the app-tools routing context; attach one first or set CODEX_WEB_DESKTOP_CONTEXT_THREAD",
      );
    const id = randomUUID();
    try {
      return unpackNativeResult(
        await nativeRequest(this.endpoint, {
          jsonrpc: "2.0",
          id,
          method: "tools/call",
          params: {
            namespace: "codex_app",
            tool,
            arguments: args,
            callId: id,
            threadId: this.originThreadId,
            turnId: "codex-web-desktop-bridge",
          },
        }),
      );
    } catch (error) {
      // A native handler can fail after dispatching a completion.
      if (tool === "send_message_to_thread") error.deliveryUnknown = true;
      throw error;
    }
  }
}
module.exports = {
  discoverNativeTools,
  NativeTools,
  nativeRequest,
  unpackNativeResult,
};
