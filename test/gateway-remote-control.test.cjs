const assert = require("node:assert/strict");
const test = require("node:test");
const { EventEmitter } = require("node:events");
const { SessionStore } = require("../src/server/gateway/store.js");
const { SessionService } = require("../src/server/gateway/service.js");
const { createGateway } = require("../src/server/gateway/http.js");

class RemoteControlConnection extends EventEmitter {
  connected = true;
  epoch = "remote-control-test";
  calls = [];
  async connect() {}
  request(method, params) {
    this.calls.push({ method, params });
    if (method.endsWith("status/read"))
      return {
        status: "connected",
        serverName: "test-host",
        installationId: "installation-test",
        environmentId: "environment-test",
      };
    if (method.endsWith("pairing/start"))
      return {
        pairingCode: "pairing-test",
        manualPairingCode: null,
        environmentId: "environment-test",
        expiresAt: Date.now() + 60_000,
      };
    return {};
  }
  close() {
    this.connected = false;
  }
}

test("official remote-control status and pairing stay behind the gateway", async (t) => {
  const connection = new RemoteControlConnection();
  const backend = {
    id: "desktop",
    label: "Desktop",
    cwd: "/workspace",
    transport: { type: "websocket", url: "ws://127.0.0.1:12345" },
  };
  const service = new SessionService(
    new SessionStore(":memory:"),
    [backend],
    () => connection,
  );
  const config = {
    host: "127.0.0.1",
    port: 8215,
    statePath: "/tmp/gateway-remote-control-test.sqlite",
    token: "remote-control-test-token-with-more-than-32-characters",
    allowedOrigins: [],
    backends: [backend],
  };
  const app = await createGateway(config, service);
  await app.ready();
  t.after(() => app.close());
  const headers = { authorization: `Bearer ${config.token}` };
  const status = await app.inject({
    method: "GET",
    url: "/api/v1/backends/desktop/remote-control",
    headers,
  });
  assert.equal(status.statusCode, 200);
  assert.equal(status.json().serverName, "test-host");
  const pairing = await app.inject({
    method: "POST",
    url: "/api/v1/backends/desktop/remote-control/pairing%2Fstart",
    headers,
    payload: { manualCode: true },
  });
  assert.equal(pairing.statusCode, 200);
  assert.equal(pairing.json().pairingCode, "pairing-test");
  assert.deepEqual(connection.calls, [
    { method: "remoteControl/status/read", params: {} },
    { method: "remoteControl/pairing/start", params: { manualCode: true } },
  ]);
});
