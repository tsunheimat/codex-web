const assert = require("node:assert/strict");
const test = require("node:test");
const { WebSocket } = require("ws");
const { SessionStore } = require("../src/server/gateway/store.js");
const { SessionService } = require("../src/server/gateway/service.js");
const { createGateway } = require("../src/server/gateway/http.js");

const token = "companion-agent-token-for-gateway-test";

test("outbound companion authenticates and exposes its local app-server", async (t) => {
  process.env.TEST_COMPANION_AGENT_TOKEN = token;
  const backend = {
    id: "computer",
    label: "Computer",
    cwd: "/home/me/project",
    transport: {
      type: "companion",
      agentTokenEnv: "TEST_COMPANION_AGENT_TOKEN",
      command: "codex",
      args: ["app-server", "--listen", "stdio://"],
    },
  };
  const service = new SessionService(new SessionStore(":memory:"), [backend]);
  const config = {
    host: "127.0.0.1",
    port: 8215,
    statePath: "/tmp/gateway-companion-test.sqlite",
    token: "gateway-token-for-companion-test-more-than-32",
    allowedOrigins: [],
    backends: [backend],
  };
  const app = await createGateway(config, service);
  await app.listen({ host: "127.0.0.1", port: 0 });
  t.after(async () => {
    await app.close();
    delete process.env.TEST_COMPANION_AGENT_TOKEN;
  });
  const socket = new WebSocket(
    `ws://127.0.0.1:${app.server.address().port}/api/v1/agent`,
  );
  const messages = [];
  socket.on("message", (raw) => {
    const message = JSON.parse(String(raw));
    messages.push(message);
    if (message.type === "companion-control")
      socket.send(
        JSON.stringify({
          type: "companion-result",
          requestId: message.requestId,
          result: { root: "/home/me/project", entries: [] },
        }),
      );
  });
  await new Promise((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  socket.send(
    JSON.stringify({
      type: "agent-authenticate",
      version: 1,
      backendId: "computer",
      token,
    }),
  );
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(messages[0].type, "agent-ready");
  await new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("initialize timeout")),
      2000,
    );
    const listener = () => {
      const message = messages.at(-1);
      if (message?.method !== "initialize") return;
      clearTimeout(timer);
      socket.send(JSON.stringify({ id: message.id, result: {} }));
      resolve();
    };
    const poll = setInterval(() => {
      listener();
      if (messages.some((m) => m.method === "initialize")) clearInterval(poll);
    }, 5);
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(service.connections.get("computer").connected, true);
  assert.equal(service.summaries()[0].runtimeOwnership, "companion");
  assert.equal(service.summaries()[0].capabilities.files, true);
  assert.deepEqual(
    await service.companionControl("computer", "list", {
      root: "/home/me/project",
      path: ".",
    }),
    { root: "/home/me/project", entries: [] },
  );
  const closed = new Promise((resolve) => socket.once("close", resolve));
  socket.close();
  await closed;
  const resumed = new WebSocket(
    `ws://127.0.0.1:${app.server.address().port}/api/v1/agent`,
  );
  const resumedMessages = [];
  resumed.on("message", (raw) => resumedMessages.push(JSON.parse(String(raw))));
  await new Promise((resolve, reject) => {
    resumed.once("open", resolve);
    resumed.once("error", reject);
  });
  resumed.send(
    JSON.stringify({
      type: "agent-authenticate",
      version: 1,
      backendId: "computer",
      token,
      runtimeInitialized: true,
    }),
  );
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.deepEqual(resumedMessages, [{ type: "agent-ready", version: 1 }]);
  assert.equal(service.connections.get("computer").connected, true);
  resumed.close();
});
