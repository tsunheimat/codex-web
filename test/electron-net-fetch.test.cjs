const assert = require("node:assert/strict");
const test = require("node:test");

globalThis.__CODEX_SHIM_VALUES__ = { version: "test" };

test("Electron net.fetch supplies a browser user agent without overwriting one", async () => {
  const original = globalThis.fetch;
  const seen = [];
  globalThis.fetch = async (_input, init) => {
    seen.push(init.headers.get("user-agent"));
    return new Response("ok", { status: 200 });
  };
  try {
    const { net } = require("../src/server/electron/index.js");
    await net.fetch("https://chatgpt.com/backend-api/files");
    await net.fetch("https://chatgpt.com/backend-api/files", {
      headers: { "User-Agent": "custom-client/1.0" },
    });
    assert.match(seen[0], /Mozilla\/5\.0/);
    assert.equal(seen[1], "custom-client/1.0");
  } finally {
    globalThis.fetch = original;
  }
});
