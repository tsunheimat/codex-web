const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

globalThis.__CODEX_SHIM_VALUES__ ??= { version: "test" };

const shimSource = fs.readFileSync(
  path.join(__dirname, "..", "src", "browser", "shim.ts"),
  "utf8",
);

test("browser bridge hides native-only capabilities so the renderer uses its DOM fallbacks", () => {
  assert.match(
    shimSource,
    /BROWSER_UNSUPPORTED_BRIDGE_METHODS = \["showContextMenu", "startFileDrag"\]/,
  );
  assert.match(shimSource, /delete api\[method\]/);
  assert.doesNotMatch(
    shimSource,
    /getPathForFile[\s\S]{0,200}?unimplemented\("webUtils\.getPathForFile"\)/,
  );
});

test("bundled renderer switches to DOM context menus when the bridge method is absent", () => {
  const assetsDirectory = path.join(
    __dirname,
    "..",
    "scratch",
    "asar",
    "webview",
    "assets",
  );
  const appInitialAssets = fs
    .readdirSync(assetsDirectory)
    .filter((name) => /^app-initial-[\w-]+\.js$/.test(name));
  assert.equal(
    appInitialAssets.length,
    1,
    `expected exactly one app-initial Desktop bundle, found: ${appInitialAssets.join(", ") || "none"}`,
  );
  const bundle = fs.readFileSync(
    path.join(assetsDirectory, appInitialAssets[0]),
    "utf8",
  );
  assert.match(
    bundle,
    /window\.electronBridge\?\.showContextMenu != null/,
    "renderer must gate native menus on bridge capability",
  );
  assert.match(
    bundle,
    /window\.electronBridge\?\.startFileDrag != null/,
    "renderer must gate native file drags on bridge capability",
  );
});

test("Menu.popup resolves the desktop show-context-menu invoke instead of hanging", async () => {
  const { Menu } = require("../src/server/electron/index.js");

  // Mirror of the desktop main-process handler for
  // codex_desktop:show-context-menu (scratch/asar/.vite/build/main-*.js):
  // clicks resolve {id}, and the popup callback resolves {id: null}.
  const result = await new Promise((resolve) => {
    let settled = false;
    const settle = (id) => {
      if (!settled) {
        settled = true;
        resolve({ id });
      }
    };
    const template = [
      { id: "copy", label: "Copy", click: () => settle("copy") },
      { type: "separator" },
      { id: "delete", label: "Delete", click: () => settle("delete") },
    ];
    Menu.buildFromTemplate(template).popup({
      window: undefined,
      callback: () => settle(null),
    });
  });

  assert.deepEqual(result, { id: null });
});

test("shared-object snapshot stays schema-complete for renderer loading gates", () => {
  // The renderer treats a missing remote_control_connections array as
  // "still loading" and never settles (Ijr selector in app-initial).
  assert.match(
    shimSource,
    /get-shared-object-snapshot[\s\S]{0,600}remote_control_connections: \[\]/,
  );
});

test("REPLACE memory navigations mirror with replaceState, not pushState", () => {
  assert.match(
    shimSource,
    /navigation\.action === "REPLACE" \|\|\s+window\.location\.pathname \+ window\.location\.search === browserPath\.path/,
  );
});

test("Menu.closePopup is callable", () => {
  const { Menu } = require("../src/server/electron/index.js");
  const menu = Menu.buildFromTemplate([{ id: "x", label: "X" }]);
  menu.closePopup();
});
