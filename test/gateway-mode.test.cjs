const test = require("node:test");
const assert = require("node:assert/strict");
const {
  readGatewayMode,
  appServerWebSocketUrl,
  configureShellEnvironment,
  mergeGlobalStateValue,
  GatewayGlobalStateOverlay,
} = require("../src/server/gateway-mode.js");

const TOKEN = "viewer-token-with-more-than-32-characters";
const env = (overrides = {}) => ({
  CODEX_WEB_GATEWAY_URL: "https://codex.example.com",
  CODEX_WEB_GATEWAY_TOKEN: TOKEN,
  CODEX_WEB_GATEWAY_BACKEND: "windows",
  ...overrides,
});

test("gateway mode validates its environment", () => {
  assert.equal(readGatewayMode({}), null);
  assert.throws(() => readGatewayMode(env({ CODEX_WEB_GATEWAY_URL: "ftp://x" })), /http or https/);
  assert.throws(
    () => readGatewayMode(env({ CODEX_WEB_GATEWAY_URL: "https://u:p@codex.example.com" })),
    /credentials/,
  );
  assert.throws(
    () => readGatewayMode(env({ CODEX_WEB_GATEWAY_URL: "http://codex.example.com" })),
    /https unless/,
  );
  assert.ok(readGatewayMode(env({ CODEX_WEB_GATEWAY_URL: "http://127.0.0.1:8215" })));
  assert.ok(
    readGatewayMode(
      env({
        CODEX_WEB_GATEWAY_URL: "http://codex-web-gateway.codex-web-gateway.svc:8215",
        CODEX_WEB_GATEWAY_ALLOW_PLAIN_HTTP: "true",
      }),
    ),
  );
  assert.throws(() => readGatewayMode(env({ CODEX_WEB_GATEWAY_TOKEN: "short" })), /at least 32/);
  assert.throws(() => readGatewayMode(env({ CODEX_WEB_GATEWAY_BACKEND: "bad id!" })), /backend/);
});

test("the shell is pointed at the gateway's app-server endpoint", () => {
  const mode = readGatewayMode(env());
  assert.equal(
    appServerWebSocketUrl(mode),
    "wss://codex.example.com/api/v1/backends/windows/app-server",
  );
  // A trailing slash or a path prefix never produces a protocol-relative URL.
  assert.equal(
    appServerWebSocketUrl(readGatewayMode(env({ CODEX_WEB_GATEWAY_URL: "https://codex.example.com/" }))),
    "wss://codex.example.com/api/v1/backends/windows/app-server",
  );
  assert.equal(
    appServerWebSocketUrl(readGatewayMode(env({ CODEX_WEB_GATEWAY_URL: "https://host.example.com/codex/" }))),
    "wss://host.example.com/codex/api/v1/backends/windows/app-server",
  );
  const shellEnv = { CODEX_APP_SERVER_FORCE_CLI: "1" };
  configureShellEnvironment(mode, shellEnv);
  assert.equal(shellEnv.CODEX_APP_SERVER_WS_URL, "wss://codex.example.com/api/v1/backends/windows/app-server");
  assert.equal(shellEnv.CODEX_APP_SERVER_WS_AUTHORIZATION, `Bearer ${TOKEN}`);
  assert.equal(shellEnv.CODEX_WEB_RUNTIME_OWNERSHIP, "external");
  assert.equal(shellEnv.CODEX_APP_SERVER_FORCE_CLI, undefined);
});

test("Desktop sidebar bookkeeping merges under the local shell's values", () => {
  const local = { a: { id: "a", name: "local", rootPaths: ["/home/me/a"] } };
  const desktop = {
    a: { id: "a", name: "desktop copy", rootPaths: ["C:\\a"] },
    b: { id: "b", name: "project", rootPaths: ["C:\\project"] },
  };
  assert.deepEqual(mergeGlobalStateValue("local-projects", local, desktop), {
    a: local.a,
    b: desktop.b,
  });
  assert.equal(mergeGlobalStateValue("local-projects", local, {}), local);
  assert.deepEqual(mergeGlobalStateValue("local-projects", undefined, desktop), desktop);
  assert.deepEqual(mergeGlobalStateValue("pinned-thread-ids", ["x"], ["y", "x"]), ["x", "y"]);
  assert.deepEqual(mergeGlobalStateValue("projectless-thread-ids", undefined, ["t1"]), ["t1"]);
  assert.deepEqual(mergeGlobalStateValue("pinned-thread-ids", ["x"], []), ["x"]);
  // Keys outside the sidebar set are never touched.
  assert.equal(mergeGlobalStateValue("electron-main-window-bounds", { x: 1 }, { x: 2 }).x, 1);
});

test("global-state answers are rewritten only for tracked sidebar reads", async () => {
  let reads = 0;
  const overlay = new GatewayGlobalStateOverlay({
    readGlobalState: async () => {
      reads += 1;
      return { "local-projects": { p: { id: "p", name: "project", rootPaths: ["C:\\project"] } } };
    },
  });
  const invoke = (requestId, key, url = "vscode://codex/get-global-state") => ({
    type: "ipc-renderer-invoke",
    requestId: "r",
    channel: "codex_desktop:message-from-view",
    args: [{ type: "fetch", requestId, method: "POST", url, body: JSON.stringify({ key }) }],
  });
  const response = (requestId, value) => ({
    type: "ipc-main-event",
    channel: "codex_desktop:message-for-view",
    args: [
      {
        type: "fetch-response",
        responseType: "success",
        requestId,
        status: 200,
        bodyJsonString: JSON.stringify({ value }),
      },
    ],
  });
  overlay.observeInvoke(invoke("1", "local-projects"));
  overlay.observeInvoke(invoke("2", "electron-main-window-bounds"));
  overlay.observeInvoke(invoke("3", "local-projects", "vscode://codex/get-configuration"));
  assert.equal(overlay.claims(response("1", {})), true);
  assert.equal(overlay.claims(response("2", {})), false);
  assert.equal(overlay.claims(response("3", {})), false);
  const rewritten = await overlay.rewrite(response("1", { mine: { id: "mine", rootPaths: ["/x"] } }));
  const body = JSON.parse(rewritten.args[0].bodyJsonString);
  assert.deepEqual(Object.keys(body.value).sort(), ["mine", "p"]);
  // Answered once; a second answer for the same request is passed through.
  assert.equal(overlay.claims(response("1", {})), false);
  assert.ok(reads >= 1);
  // Desktop failures leave the local answer untouched.
  const failing = new GatewayGlobalStateOverlay({
    readGlobalState: async () => {
      throw new Error("offline");
    },
  });
  failing.observeInvoke(invoke("9", "pinned-thread-ids"));
  const untouched = await failing.rewrite(response("9", ["x"]));
  assert.deepEqual(JSON.parse(untouched.args[0].bodyJsonString).value, ["x"]);
});
