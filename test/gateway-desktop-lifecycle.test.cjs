const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const {
  waitForDesktop,
  checkGateway,
} = require("../scripts/desktop/connection-lifecycle.cjs");

test("Windows startup waits for Desktop and closes failed pipe attempts", async () => {
  let discoveries = 0,
    connections = 0,
    closes = 0;
  const diagnostics = [];
  const result = await waitForDesktop({
    wait: true,
    retryMs: 1,
    discover: async () => {
      if (++discoveries === 1)
        throw Object.assign(new Error(), { code: "DESKTOP_NOT_FOUND" });
      return { version: "test" };
    },
    makeIpc: () => ({
      connect: async () => {
        if (++connections === 1)
          throw Object.assign(new Error(), { code: "ENOENT" });
      },
      close: () => closes++,
    }),
    diagnose: (message) => diagnostics.push(message),
  });
  assert.equal(result.info.version, "test");
  assert.equal(discoveries, 3);
  assert.equal(closes, 1);
  assert.equal(diagnostics.length, 2);
});

test("Windows startup fails promptly on access/version errors and supports cancellation", async () => {
  for (const code of ["EACCES", "PROTOCOL_UNRECOGNIZED", "DESKTOP_AMBIGUOUS"]) {
    await assert.rejects(
      waitForDesktop({
        wait: true,
        discover: async () => {
          throw Object.assign(new Error(code), { code });
        },
      }),
      { code },
    );
  }
  const abort = new AbortController();
  await assert.rejects(
    waitForDesktop({
      wait: true,
      signal: abort.signal,
      discover: async () => {
        abort.abort();
        return {};
      },
      makeIpc: () => {
        assert.fail("Must not connect after cancellation");
      },
    }),
    { name: "AbortError" },
  );
});

function bridgeFixture() {
  return Object.assign(new EventEmitter(), {
    readOnly: true,
    info: { version: "test" },
    session: { ipc: { clientId: "desktop-client" } },
    capabilities: () => ({ chatgptAttachments: false, computerUse: false }),
    start() {
      this.emit("ready");
    },
  });
}

test("Connection check verifies gateway authentication without inventing native capability", async () => {
  const bridge = bridgeFixture();
  const result = await checkGateway(bridge, 100);
  assert.equal(result.gatewayAuthenticated, true);
  assert.equal(result.desktopAttached, true);
  assert.equal(result.capabilities.computerUse, false);
  assert.equal(result.mutationsSent, 0);
  assert.equal(bridge.listenerCount("ready"), 0);
  assert.equal(bridge.listenerCount("fatal"), 0);
  bridge.readOnly = false;
  assert.throws(() => checkGateway(bridge), /read-only/);
});

test("Connection check reports rejection, timeout and Desktop disconnect without hanging", async () => {
  const bridge = bridgeFixture();
  bridge.start = () => bridge.emit("fatal", new Error("Rejected"));
  await assert.rejects(checkGateway(bridge), /Rejected/);
  bridge.start = () => {};
  await assert.rejects(checkGateway(bridge, 10), { code: "GATEWAY_TIMEOUT" });
  bridge.session.ipc.clientId = null;
  bridge.start = () => bridge.emit("ready");
  await assert.rejects(checkGateway(bridge), { code: "IPC_DISCONNECTED" });
});
