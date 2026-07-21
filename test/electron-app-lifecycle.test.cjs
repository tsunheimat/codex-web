const assert = require("node:assert/strict");
const test = require("node:test");

globalThis.__CODEX_SHIM_VALUES__ = { version: "test" };

test("Desktop shutdown emits the Electron quit lifecycle once and in order", async () => {
  const bridgeState = (globalThis.__codexElectronIpcBridge = {});
  const { app } = require("../src/server/electron/index.js");
  const events = [];

  app.on("before-quit", () => events.push("before-quit"));
  app.once("will-quit", () => events.push("will-quit"));
  app.on("quit", (_event, exitCode) => events.push(`quit:${exitCode}`));

  assert.equal(typeof bridgeState.shutdownDesktopApp, "function");
  const first = bridgeState.shutdownDesktopApp();
  const second = bridgeState.shutdownDesktopApp();
  assert.equal(first, second);
  await Promise.all([first, second]);

  assert.deepEqual(events, ["before-quit", "will-quit", "quit:0"]);
  await bridgeState.shutdownDesktopApp();
  assert.deepEqual(events, ["before-quit", "will-quit", "quit:0"]);
});
