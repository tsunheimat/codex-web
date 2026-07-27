const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const ts = require("typescript");

function loadRoutes() {
  const filename = path.join(__dirname, "..", "src", "browser", "routes.ts");
  const source = fs.readFileSync(filename, "utf8");
  const compiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
    fileName: filename,
  }).outputText;
  const module = { exports: {} };
  const window = {
    addEventListener() {},
    dispatchEvent() {},
    location: { pathname: "/" },
  };
  new Function("exports", "module", "require", "window", compiled)(
    module.exports,
    module,
    require,
    window,
  );
  return module.exports;
}

test("ChatGPT Work conversation paths survive initial route hydration", () => {
  const routes = loadRoutes();
  const pathName = "/work/conversation/local-chatgpt%3Aexample-id";

  assert.equal(routes.currentThreadIdFromBrowserPath(pathName), null);
  assert.equal(
    routes.currentConversationIdFromBrowserPath(pathName),
    "local-chatgpt:example-id",
  );
  assert.deepEqual(routes.mapBrowserPathToInitialRoute(pathName, ""), {
    memoryPath: pathName,
  });
});

test("ChatGPT Work memory routes remain visible in browser history", () => {
  const routes = loadRoutes();

  assert.deepEqual(
    routes.mapMemoryPathToBrowserPath("/work/conversation/server-id"),
    { path: "/work/conversation/server-id" },
  );
});

test("Codex thread routes retain their existing local mapping", () => {
  const routes = loadRoutes();

  assert.equal(
    routes.currentThreadIdFromBrowserPath("/thread/task-id"),
    "task-id",
  );
  assert.equal(
    routes.currentConversationIdFromBrowserPath("/thread/task-id"),
    "task-id",
  );
  assert.deepEqual(routes.mapBrowserPathToInitialRoute("/thread/task-id", ""), {
    memoryPath: "/local/task-id",
  });
  assert.deepEqual(routes.mapMemoryPathToBrowserPath("/local/task-id"), {
    path: "/thread/task-id",
  });

  const encodedBrowserPath = "/thread/local-chatgpt%3Aexample-id";
  const initialRoute = routes.mapBrowserPathToInitialRoute(
    encodedBrowserPath,
    "",
  );
  assert.deepEqual(initialRoute, {
    memoryPath: "/local/local-chatgpt:example-id",
  });
  assert.deepEqual(routes.mapMemoryPathToBrowserPath(initialRoute.memoryPath), {
    path: encodedBrowserPath,
  });
});

test("malformed or unsafe conversation paths do not become routes", () => {
  const routes = loadRoutes();

  for (const pathName of [
    "/work/conversation/",
    "/work/conversation/a/b",
    "/work/conversation/%2Fetc",
    "/work/conversation/%00bad",
  ]) {
    assert.equal(
      routes.currentThreadIdFromBrowserPath(pathName),
      null,
      pathName,
    );
    assert.equal(
      routes.currentConversationIdFromBrowserPath(pathName),
      null,
      pathName,
    );
    assert.deepEqual(routes.mapBrowserPathToInitialRoute(pathName, ""), {
      memoryPath: "/",
    });
  }
});
