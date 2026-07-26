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

test("project browse authority permits a selected project outside the file browse root", async (t) => {
  const temporaryRoot = await fsp.mkdtemp(
    path.join(os.tmpdir(), "codex-web-ipc-project-root-"),
  );
  const browseRoot = path.join(temporaryRoot, "workspace");
  const projectRoot = path.join(temporaryRoot, "project");
  await Promise.all([fsp.mkdir(browseRoot), fsp.mkdir(projectRoot)]);
  t.after(() => fsp.rm(temporaryRoot, { recursive: true, force: true }));

  const forwarded = [];
  const handler = async (_channel, args) => {
    forwarded.push(structuredClone(args));
    return "accepted";
  };
  assert.equal(
    await invokeRendererRequest(
      rendererInvoke("mcp-request", "thread/start", projectRoot),
      browseRoot,
      handler,
      temporaryRoot,
      projectRoot,
    ),
    "accepted",
  );
  assert.equal(forwarded[0][0].request.params.cwd, projectRoot);
});

test("a workspace-path rejection produces a renderer-visible mcp-response error", async (t) => {
  const {
    syntheticMcpErrorEventForRejectedInvoke,
  } = require("../src/server/ipc-renderer-invoke.js");
  const temporaryRoot = await fsp.mkdtemp(
    path.join(os.tmpdir(), "codex-web-ipc-synthetic-error-"),
  );
  const browseRoot = path.join(temporaryRoot, "browse");
  const outside = path.join(temporaryRoot, "outside");
  await fsp.mkdir(browseRoot);
  await fsp.mkdir(outside);
  t.after(() => fsp.rm(temporaryRoot, { recursive: true, force: true }));

  const message = {
    type: "ipc-renderer-invoke",
    requestId: "synthetic-error-request",
    channel: CHANNEL,
    args: [
      {
        type: "mcp-request",
        hostId: "local",
        request: {
          id: "mcp-request-id-1",
          method: "thread/start",
          params: { cwd: outside },
        },
      },
    ],
    sourceUrl: "http://127.0.0.1/",
  };
  const error = await invokeRendererRequest(
    message,
    browseRoot,
    async () => "forwarded",
    temporaryRoot,
  ).then(
    () => null,
    (caught) => caught,
  );
  assert(error);
  assert.equal(
    rendererInvokeErrorMessage(error),
    "cwd is outside CODEX_WEBUI_BROWSE_ROOT",
  );

  const event = syntheticMcpErrorEventForRejectedInvoke(message, error);
  assert.deepEqual(event, {
    type: "ipc-main-event",
    channel: "codex_desktop:message-for-view",
    args: [
      {
        type: "mcp-response",
        hostId: "local",
        message: {
          id: "mcp-request-id-1",
          error: {
            code: -32602,
            message: "cwd is outside CODEX_WEBUI_BROWSE_ROOT",
          },
        },
      },
    ],
  });

  // Non-workspace errors and prewarm envelopes must not fabricate responses.
  assert.equal(
    syntheticMcpErrorEventForRejectedInvoke(message, new Error("other")),
    null,
  );
  const prewarm = structuredClone(message);
  prewarm.args[0].type = "thread-prewarm-start";
  assert.equal(syntheticMcpErrorEventForRejectedInvoke(prewarm, error), null);
  const missingId = structuredClone(message);
  delete missingId.args[0].request.id;
  assert.equal(syntheticMcpErrorEventForRejectedInvoke(missingId, error), null);
});
