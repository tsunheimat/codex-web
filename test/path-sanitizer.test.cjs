const assert = require("node:assert/strict");
const test = require("node:test");
const {
  expandTildePath,
  sanitizeMcpRequestPaths,
  sanitizeRendererInvokeMcpRequestPaths,
} = require("../src/server/mcp-request-path-sanitizer.js");

const HOME = "/home/codex";
const request = (method, params, type = "mcp-request") => ({
  type,
  request: { method, params },
});

test("expands home-relative thread start and resume paths", () => {
  assert.equal(expandTildePath("~/repo", HOME), `${HOME}/repo`);
  const envelope = request("thread/resume", {
    cwd: "~",
    runtimeWorkspaceRoots: ["~/repo", "/srv/repo"],
    sandbox: { writableRoots: ["~"] },
  });
  const result = sanitizeMcpRequestPaths(envelope, HOME);
  assert.equal(result.method, "thread/resume");
  assert.deepEqual(envelope.request.params, {
    cwd: HOME,
    runtimeWorkspaceRoots: [`${HOME}/repo`, "/srv/repo"],
    sandbox: { writableRoots: [HOME] },
  });
});

test("drops invalid arrays deliberately but preserves non-home-relative cwd", () => {
  const envelope = request("thread/start", {
    cwd: "relative/repo",
    runtimeWorkspaceRoots: ["workspace-id"],
    sandbox: { writableRoots: ["also-relative"] },
  });
  sanitizeMcpRequestPaths(envelope, HOME);
  assert.equal(envelope.request.params.cwd, "relative/repo");
  assert.equal("runtimeWorkspaceRoots" in envelope.request.params, false);
  assert.deepEqual(envelope.request.params.sandbox.writableRoots, []);
});

test("covers prewarm envelopes and ignores unrelated methods and text", () => {
  const prewarm = request(
    "thread/start",
    { runtimeWorkspaceRoots: ["~"] },
    "thread-prewarm-start",
  );
  sanitizeMcpRequestPaths(prewarm, HOME);
  assert.deepEqual(prewarm.request.params.runtimeWorkspaceRoots, [HOME]);

  const turn = request("turn/start", {
    items: [{ type: "text", text: "cwd ~ and writableRoots" }],
  });
  assert.equal(sanitizeMcpRequestPaths(turn, HOME), null);
  assert.equal(turn.request.params.items[0].text, "cwd ~ and writableRoots");
});

test("normalizes only the exact Desktop app-server invoke shape", () => {
  for (const envelopeType of ["mcp-request", "thread-prewarm-start"]) {
    const envelope = request(
      "thread/start",
      { runtimeWorkspaceRoots: ["~"] },
      envelopeType,
    );
    const result = sanitizeRendererInvokeMcpRequestPaths(
      {
        type: "ipc-renderer-invoke",
        channel: "codex_desktop:message-from-view",
        args: [envelope],
      },
      HOME,
    );
    assert.equal(result.method, "thread/start");
    assert.deepEqual(envelope.request.params.runtimeWorkspaceRoots, [HOME]);
  }
});

for (const [name, message] of [
  [
    "wrong channel",
    {
      type: "ipc-renderer-invoke",
      channel: "codex_desktop:worker:main:from-view",
    },
  ],
  [
    "wrong envelope",
    {
      type: "ipc-renderer-invoke",
      channel: "codex_desktop:message-from-view",
      envelopeType: "shared-object-set",
    },
  ],
  [
    "send instead of invoke",
    {
      type: "ipc-renderer-send",
      channel: "codex_desktop:message-from-view",
    },
  ],
]) {
  test(`does not normalize ${name}`, () => {
    const envelope = request(
      "thread/start",
      { runtimeWorkspaceRoots: ["~"] },
      message.envelopeType ?? "mcp-request",
    );
    assert.equal(
      sanitizeRendererInvokeMcpRequestPaths(
        { ...message, args: [envelope] },
        HOME,
      ),
      null,
    );
    assert.deepEqual(envelope.request.params.runtimeWorkspaceRoots, ["~"]);
  });
}

test("does not normalize malformed invoke argument cardinality", () => {
  const extraArgumentEnvelope = request("thread/resume", { cwd: "~" });
  const nonArrayEnvelope = request("thread/resume", { cwd: "~" });
  for (const [args, envelope] of [
    [[], null],
    [[extraArgumentEnvelope, { extra: true }], extraArgumentEnvelope],
    [nonArrayEnvelope, nonArrayEnvelope],
  ]) {
    assert.equal(
      sanitizeRendererInvokeMcpRequestPaths(
        {
          type: "ipc-renderer-invoke",
          channel: "codex_desktop:message-from-view",
          args,
        },
        HOME,
      ),
      null,
    );
    if (envelope) {
      assert.equal(envelope.request.params.cwd, "~");
    }
  }
});
