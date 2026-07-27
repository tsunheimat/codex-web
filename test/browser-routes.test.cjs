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

test("conversation query state such as temporary-chat survives refresh", () => {
  const routes = loadRoutes();

  assert.deepEqual(
    routes.mapBrowserPathToInitialRoute(
      "/work/conversation/server-id",
      "?temporary-chat=true",
    ),
    { memoryPath: "/work/conversation/server-id?temporary-chat=true" },
  );
  assert.deepEqual(
    routes.mapBrowserPathToInitialRoute("/thread/task-id", "?foo=bar"),
    { memoryPath: "/local/task-id?foo=bar" },
  );
  assert.deepEqual(routes.mapBrowserPathToInitialRoute("/", "?prompt=hi"), {
    memoryPath: "/?prompt=hi",
  });
  assert.deepEqual(
    routes.mapMemoryPathToBrowserPath(
      "/work/conversation/server-id",
      "?temporary-chat=true",
    ),
    { path: "/work/conversation/server-id?temporary-chat=true" },
  );
});

test("allowlisted app pages keep their browser URL and query state", () => {
  const routes = loadRoutes();

  for (const pathname of [
    "/projects",
    "/settings",
    "/settings/data-controls",
    "/security/scans/scan-1",
    "/automations",
    "/skills",
    "/remote/task-9",
  ]) {
    assert.deepEqual(
      routes.mapBrowserPathToInitialRoute(pathname, ""),
      { memoryPath: pathname },
      pathname,
    );
    assert.deepEqual(
      routes.mapMemoryPathToBrowserPath(pathname),
      { path: pathname },
      pathname,
    );
  }

  assert.deepEqual(
    routes.mapBrowserPathToInitialRoute(
      "/automations",
      "?automationId=abc123",
    ),
    { memoryPath: "/automations?automationId=abc123" },
  );
  assert.deepEqual(
    routes.mapMemoryPathToBrowserPath("/automations", "?automationId=abc123"),
    { path: "/automations?automationId=abc123" },
  );
});

test("window-scoped or unknown pages never become browser URLs", () => {
  const routes = loadRoutes();

  for (const pathname of [
    "/login",
    "/welcome",
    "/first-run",
    "/select-workspace",
    "/avatar-overlay",
    "/diff",
    "/unknown",
    "/settings/../../etc",
    "/settings//double",
    "/projects/extra",
    "/remote",
    "/remote/a/b",
  ]) {
    assert.deepEqual(
      routes.mapBrowserPathToInitialRoute(pathname, ""),
      { memoryPath: "/" },
      pathname,
    );
    assert.equal(routes.mapMemoryPathToBrowserPath(pathname), null, pathname);
  }
});

test("unsafe query strings are dropped rather than preserved", () => {
  const routes = loadRoutes();

  for (const search of ["?a=b#frag", "no-question-mark", "?", "?a=\u0000"]) {
    assert.deepEqual(
      routes.mapBrowserPathToInitialRoute("/projects", search),
      { memoryPath: "/projects" },
      JSON.stringify(search),
    );
  }
  const longSearch = `?x=${"y".repeat(3000)}`;
  assert.deepEqual(routes.mapBrowserPathToInitialRoute("/projects", longSearch), {
    memoryPath: "/projects",
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
