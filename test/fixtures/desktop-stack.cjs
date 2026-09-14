// Boots fixture Desktop -> bridge -> loopback gateway for tests that need the
// whole Desktop path without TLS (the bridge accepts plain ws:// on loopback).
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { DesktopIpc } = require("../../scripts/desktop/ipc.cjs");
const { DesktopSession } = require("../../scripts/desktop/session.cjs");
const {
  DesktopBridge,
  CommandJournal,
  gatewayUrl,
} = require("../../scripts/codex_web_desktop_bridge.cjs");
const { SessionStore } = require("../../src/server/gateway/store.js");
const { SessionService } = require("../../src/server/gateway/service.js");
const { createGateway } = require("../../src/server/gateway/http.js");
const { InstalledProtocolFixture, versions } = require("./desktop-protocol.cjs");

const GATEWAY_TOKEN = "viewer-token-with-more-than-32-characters";
const AGENT_TOKEN = "desktop-agent-secret-with-more-than-32-characters";

function fakeJwt(claims) {
  const encode = (v) =>
    Buffer.from(JSON.stringify(v)).toString("base64url");
  return `${encode({ alg: "none" })}.${encode(claims)}.signature`;
}

async function until(predicate, timeout = 10000) {
  const end = Date.now() + timeout;
  while (!(await predicate())) {
    if (Date.now() > end) throw new Error("Timed out waiting for stack state");
    await new Promise((r) => setTimeout(r, 25));
  }
}

async function startDesktopStack({
  seedHistory = true,
  autoReply = true,
  imageFile = true,
  shareAccountToken = true,
  threadId = "0199f2c4-6a1b-7c3d-9e8f-0123456789ab",
} = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-web-desktop-stack-"));
  const endpoint =
    process.platform === "win32"
      ? "\\\\.\\pipe\\codex-web-test-" + randomUUID()
      : path.join(dir, "desktop.sock");
  let imagePath;
  if (imageFile) {
    // A 1x1 PNG the "Desktop" attached to its seeded user message.
    imagePath = path.join(dir, "desktop-image.png");
    fs.writeFileSync(
      imagePath,
      Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
        "base64",
      ),
    );
  }
  const fixture = await new InstalledProtocolFixture(endpoint, {
    seedHistory,
    imagePath,
    autoReply,
    threadId,
  }).listen();
  const ipc = new DesktopIpc({ endpoint, versions, timeoutMs: 1500 });
  await ipc.connect();
  fs.writeFileSync(
    path.join(dir, "auth.json"),
    JSON.stringify({
      auth_mode: "chatgpt",
      tokens: {
        id_token: fakeJwt({
          "https://api.openai.com/profile": { email: "desktop@example.com" },
          "https://api.openai.com/auth": { chatgpt_plan_type: "pro" },
        }),
        // The shell decodes the access token's claims for account id and plan.
        access_token: fakeJwt({
          "https://api.openai.com/profile": { email: "desktop@example.com" },
          "https://api.openai.com/auth": {
            chatgpt_account_id: "fixture-account",
            chatgpt_plan_type: "pro",
            chatgpt_user_id: "user-fixture",
          },
          exp: Math.floor(Date.now() / 1000) + 3600,
        }),
      },
    }),
  );
  fs.writeFileSync(
    path.join(dir, "session_index.jsonl"),
    JSON.stringify({ id: threadId, thread_name: "Desktop conversation" }) +
      "\n",
  );
  // The Desktop's own sidebar bookkeeping: the seeded thread's cwd is a
  // project the Windows user added there.
  fs.writeFileSync(
    path.join(dir, ".codex-global-state.json"),
    JSON.stringify({
      "local-projects": {
        "project-fixture": {
          id: "project-fixture",
          name: "project",
          rootPaths: ["C:\\project"],
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
      },
      "pinned-thread-ids": [],
      "electron-main-window-bounds": { x: 0, y: 0 },
    }),
  );
  const session = new DesktopSession(ipc, {
    codexHome: dir,
    uploadRoot: path.join(dir, "uploads"),
    shareAccountToken,
  });
  process.env.DESKTOP_STACK_TOKEN = AGENT_TOKEN;
  const backend = {
    id: "windows",
    label: "Windows Desktop",
    cwd: "C:\\project",
    transport: { type: "desktop", agentTokenEnv: "DESKTOP_STACK_TOKEN" },
  };
  const store = new SessionStore(":memory:");
  const service = new SessionService(store, [backend]);
  const config = {
    host: "127.0.0.1",
    port: 0,
    statePath: path.join(dir, "gateway.sqlite"),
    token: GATEWAY_TOKEN,
    allowedOrigins: [],
    backends: [backend],
  };
  const app = await createGateway(config, service);
  await app.listen({ host: "127.0.0.1", port: 0 });
  const port = app.server.address().port;
  const bridge = new DesktopBridge({
    session,
    info: { version: "26.908.40834", packageVersion: "26.908.4834.0" },
    url: gatewayUrl(`ws://127.0.0.1:${port}`),
    backendId: backend.id,
    token: AGENT_TOKEN,
    journal: new CommandJournal(path.join(dir, "bridge.sqlite")),
    retryMs: 50,
  });
  bridge.start();
  await until(() => service.connections.get(backend.id).connected && bridge.ready);
  return {
    dir,
    threadId,
    imagePath,
    fixture,
    ipc,
    session,
    store,
    service,
    bridge,
    app,
    port,
    backend,
    token: GATEWAY_TOKEN,
    gatewayUrl: `http://127.0.0.1:${port}`,
    until,
    async close() {
      await bridge.close();
      await app.close();
      await fixture.close();
      fs.rmSync(dir, { recursive: true, force: true });
      delete process.env.DESKTOP_STACK_TOKEN;
    },
  };
}

module.exports = { startDesktopStack, until, GATEWAY_TOKEN, AGENT_TOKEN };
