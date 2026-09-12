const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const ts = require("typescript");

function load(window) {
  const source = fs.readFileSync(
    path.join(__dirname, "../src/browser/server-config.ts"),
    "utf8",
  );
  const code = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText;
  const module = { exports: {} };
  new Function("module", "exports", "window", code)(
    module,
    module.exports,
    window,
  );
  return module.exports;
}
test("all compatibility routes resolve against the configured backend, including prefixes", () => {
  const api = load({
    location: { href: "https://ui.example/thread/task" },
    __CODEX_WEB_CONFIG__: { serverBaseUrl: "https://backend.example/desktop" },
  });
  for (const route of [
    "/__backend/upload",
    "/__backend/download",
    "/@fs/project/image.png",
  ])
    assert.equal(
      api.backendUrl(route).href,
      `https://backend.example/desktop${route}`,
    );
  assert.equal(
    api.backendWebSocketUrl("/__backend/ipc").href,
    "wss://backend.example/desktop/__backend/ipc",
  );
  assert.equal(
    api.backendWebSocketUrl("/__backend/chatgpt-pubsub").href,
    "wss://backend.example/desktop/__backend/chatgpt-pubsub",
  );
});
test("default frontend remains same-origin and insecure mixed-content config fails", () => {
  const api = load({ location: { href: "https://ui.example/thread/task" } });
  assert.equal(
    api.backendUrl("/__backend/upload").href,
    "https://ui.example/__backend/upload",
  );
  for (const serverBaseUrl of [
    "http://backend.example",
    "https://user:secret@backend.example",
    "https://backend.example?token=secret",
  ]) {
    const bad = load({
      location: { href: "https://ui.example" },
      __CODEX_WEB_CONFIG__: { serverBaseUrl },
    });
    assert.throws(() => bad.backendUrl("/__backend/ipc"));
  }
});
