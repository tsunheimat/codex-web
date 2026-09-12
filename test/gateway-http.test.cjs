const assert = require("node:assert/strict");
const test = require("node:test");
const { randomUUID } = require("node:crypto");
const { WebSocket } = require("ws");
const { SessionStore } = require("../src/server/gateway/store.js");
const { SessionService } = require("../src/server/gateway/service.js");
const { createGateway } = require("../src/server/gateway/http.js");
const { MockRuntime, waitFor } = require("./fixtures/gateway-runtime.cjs");
const token = "test-only-gateway-token-with-at-least-32-characters";

async function setup(t) {
  const runtime = await new MockRuntime().listen();
  const config = {
    host: "127.0.0.1",
    port: 8215,
    token,
    allowedOrigins: ["https://frontend.example"],
    statePath: ":memory:",
    backends: [
      {
        id: "remote",
        label: "Remote",
        cwd: "/remote/project",
        transport: {
          type: "websocket",
          url: runtime.url,
          tokenEnv: "NEVER_EXPOSE_THIS",
        },
      },
    ],
  };
  // Secret only in config; the fake runtime does not need upstream auth.
  const service = new SessionService(new SessionStore(":memory:"), [
    {
      ...config.backends[0],
      transport: { type: "websocket", url: runtime.url },
    },
  ]);
  const app = await createGateway(config, service);
  await app.listen({ host: "127.0.0.1", port: 0 });
  t.after(async () => {
    await app.close();
    await runtime.close();
  });
  const headers = { authorization: `Bearer ${token}` };
  return {
    app,
    runtime,
    service,
    headers,
    wsUrl: `ws://127.0.0.1:${app.server.address().port}/api/v1/events`,
  };
}

test("API authentication, exact CORS origins, and secret-free backend summaries", async (t) => {
  const { app, headers } = await setup(t);
  assert.equal((await app.inject({ url: "/api/v1/backends" })).statusCode, 401);
  assert.equal(
    (
      await app.inject({
        url: "/api/v1/backends",
        headers: { ...headers, origin: "https://evil.example" },
      })
    ).statusCode,
    403,
  );
  const result = await app.inject({
    url: "/api/v1/backends",
    headers: { ...headers, origin: "https://frontend.example" },
  });
  assert.equal(result.statusCode, 200);
  assert.equal(
    result.headers["access-control-allow-origin"],
    "https://frontend.example",
  );
  assert.equal(result.headers["cache-control"], "no-store");
  assert.doesNotMatch(result.body, /tokenEnv|NEVER_EXPOSE_THIS|ws:\/\//);
  const preflight = await app.inject({
    method: "OPTIONS",
    url: "/api/v1/sessions",
    headers: { origin: "https://frontend.example" },
  });
  assert.equal(preflight.statusCode, 204);
});

test("closing every viewer retains upstream execution and a new viewer gets current state", async (t) => {
  const { app, headers, wsUrl, service, runtime } = await setup(t);
  const created = (
    await app.inject({
      method: "POST",
      url: "/api/v1/sessions",
      headers,
      payload: { backendId: "remote", clientCommandId: randomUUID() },
    })
  ).json();
  await waitFor(() => service.store.command(created.id)?.state === "accepted");
  const open = async () => {
    const frames = [];
    const socket = new WebSocket(wsUrl, { origin: "https://frontend.example" });
    socket.on("message", (raw) => frames.push(JSON.parse(String(raw))));
    await new Promise((resolve) => socket.once("open", resolve));
    socket.send(JSON.stringify({ type: "authenticate", version: 1, token }));
    await waitFor(() => frames.some((f) => f.type === "ready"));
    socket.send(
      JSON.stringify({
        type: "subscribe",
        sessionId: created.sessionId,
        afterSeq: 0,
      }),
    );
    await waitFor(() => frames.some((f) => f.type === "sync"));
    return { socket, frames };
  };
  const first = await open();
  first.socket.close();
  const body = {
    clientCommandId: randomUUID(),
    method: "turn/start",
    params: { input: [{ type: "text", text: "Continue without a viewer" }] },
  };
  const submitted = await app.inject({
    method: "POST",
    url: `/api/v1/sessions/${created.sessionId}/commands`,
    headers,
    payload: body,
  });
  assert.equal(submitted.statusCode, 202);
  await waitFor(
    () => service.store.command(body.clientCommandId).state === "accepted",
  );
  runtime.finish(service.store.get(created.sessionId).threadId);
  await waitFor(
    () => service.store.get(created.sessionId).status === "completed",
  );
  const second = await open();
  assert.equal(
    second.frames.find((f) => f.type === "sync").snapshot.status,
    "completed",
  );
  assert.equal(runtime.starts, 1);
  second.socket.close();
});

test("invalid websocket credentials never expose session state", async (t) => {
  const { wsUrl } = await setup(t);
  const frames = [];
  const socket = new WebSocket(wsUrl, { origin: "https://frontend.example" });
  socket.on("message", (raw) => frames.push(String(raw)));
  await new Promise((resolve) => socket.once("open", resolve));
  socket.send(
    JSON.stringify({ type: "authenticate", version: 1, token: "wrong" }),
  );
  const code = await new Promise((resolve) => socket.once("close", resolve));
  assert.equal(code, 1008);
  assert.deepEqual(frames, []);
});
