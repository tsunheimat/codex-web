const assert = require("node:assert/strict");
const os = require("node:os");
const test = require("node:test");

globalThis.__CODEX_SHIM_VALUES__ = {
  version: "test",
  browseRoot: "/browse-root-for-test",
};

const { app, BrowserWindow } = require("../src/server/electron/index.js");

test("app.getPath maps workspace-facing names into usable locations", () => {
  assert.equal(app.getPath("home"), os.homedir());
  assert.equal(app.getPath("documents"), "/browse-root-for-test");
  assert.equal(app.getPath("desktop"), "/browse-root-for-test");
  assert.equal(app.getPath("userData"), process.cwd());
  assert.equal(app.getPath("downloads"), process.cwd());
});

test("windows handed out by static lookups keep stub fallbacks", () => {
  const window = new BrowserWindow();
  const lookedUp = BrowserWindow.getAllWindows().at(-1);
  assert.equal(lookedUp, window);
  assert.equal(BrowserWindow.getFocusedWindow(), window);

  assert.equal(lookedUp.isVisible(), true);
  assert.equal(lookedUp.isFocused(), true);
  // Methods the stub does not implement must fall back to the deep stub
  // instead of throwing "x is not a function".
  assert.equal(lookedUp.setTitleBarOverlay({ height: 10 }), undefined);
  assert.equal(lookedUp.setWindowButtonPosition({ x: 0, y: 0 }), undefined);

  window.destroy();
  assert.equal(window.isVisible(), false);
  assert.equal(
    BrowserWindow.getAllWindows().some((entry) => entry === window),
    false,
  );
});
