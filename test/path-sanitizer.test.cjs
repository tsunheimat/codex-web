const assert = require("node:assert/strict");
const test = require("node:test");
const {
  expandTildePath,
  sanitizeMcpRequestPaths,
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
