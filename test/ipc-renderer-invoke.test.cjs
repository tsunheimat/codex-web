const assert = require("node:assert/strict");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const {
  invokeRendererRequest,
  rendererInvokeErrorMessage,
} = require("../src/server/ipc-renderer-invoke.js");

const CHANNEL = "codex_desktop:message-from-view";

function rendererInvoke(type, method, cwd) {
  return {
    type: "ipc-renderer-invoke",
    requestId: `relative-cwd-${method}`,
    channel: CHANNEL,
    args: [{ type, request: { method, params: { cwd } } }],
    sourceUrl: "http://127.0.0.1/",
  };
}

test("bounded relative cwd errors are returned before the IPC handler is invoked", async (t) => {
  const temporaryRoot = await fsp.mkdtemp(
    path.join(os.tmpdir(), "codex-web-ipc-relative-cwd-"),
  );
  const browseRoot = path.join(temporaryRoot, "browse");
  await fsp.mkdir(browseRoot);
  t.after(() => fsp.rm(temporaryRoot, { recursive: true, force: true }));

  let forwarded = 0;
  const handler = async () => {
    forwarded += 1;
    return "forwarded";
  };

  for (const [type, method, cwd] of [
    ["mcp-request", "thread/start", "relative/repo"],
    ["mcp-request", "thread/resume", "../outside"],
    ["thread-prewarm-start", "thread/start", "."],
  ]) {
    const error = await invokeRendererRequest(
      rendererInvoke(type, method, cwd),
      browseRoot,
      handler,
      temporaryRoot,
    ).then(
      () => null,
      (caught) => caught,
    );
    assert(error);
    assert.equal(
      rendererInvokeErrorMessage(error),
      "cwd must be absolute when CODEX_WEBUI_BROWSE_ROOT is configured",
    );
  }

  assert.equal(forwarded, 0, "a rejected request reached app-server IPC");
});

test("absolute and tilde cwd values are canonicalized before IPC forwarding", async (t) => {
  const temporaryRoot = await fsp.mkdtemp(
    path.join(os.tmpdir(), "codex-web-ipc-bounded-cwd-"),
  );
  const nested = path.join(temporaryRoot, "nested");
  await fsp.mkdir(nested);
  t.after(() => fsp.rm(temporaryRoot, { recursive: true, force: true }));

  const forwarded = [];
  const handler = async (_channel, args) => {
    forwarded.push(structuredClone(args));
    return "accepted";
  };
  for (const cwd of [nested, "~/nested"]) {
    assert.equal(
      await invokeRendererRequest(
        rendererInvoke("mcp-request", "thread/start", cwd),
        temporaryRoot,
        handler,
        temporaryRoot,
      ),
      "accepted",
    );
  }
  assert.equal(forwarded.length, 2);
  assert.deepEqual(
    forwarded.map((args) => args[0].request.params.cwd),
    [nested, nested],
  );
});
