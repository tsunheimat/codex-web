const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const assetName =
  "app-initial~app-main~onboarding-page~hotkey-window-thread-page~quick-chat-window-page~chatg~k0ede4gb-BfuFOm2j.js";
const assetPath = path.join(
  __dirname,
  "..",
  "scratch",
  "asar",
  "webview",
  "assets",
  assetName,
);

test("current Desktop bundle exposes non-hidden app-server models", () => {
  const bundle = fs.readFileSync(assetPath, "utf8");
  assert.match(bundle, /a\.forEach\(\(n\) => \{\s+if \(!n\.hidden\)/);
  assert.doesNotMatch(bundle, /if \(l \? t\.has\(n\.model\) : !n\.hidden\)/);
});

test("new-thread fallback uses config then app-server catalog without a hardcoded model", () => {
  const bundle = fs.readFileSync(assetPath, "utf8");
  assert.match(
    bundle,
    /e \? Dv\(n\?\.models, e\) : \(n\?\.defaultModel \?\? n\?\.models\[0\] \?\? null\)/,
  );
  assert.match(bundle, /model: r\?\.model \?\? e \?\? null/);
  assert.doesNotMatch(
    bundle.slice(bundle.indexOf("function Ive("), bundle.indexOf("var Ov =")),
    /gpt-|claude|deepseek|qianfan/i,
  );
});

test("model precedence remains thread then explicit setting then effective config then catalog", () => {
  const bundle = fs.readFileSync(assetPath, "utf8");
  assert.match(bundle, /model: w \?\? p\.model/);

  const configAwareSelection = bundle.slice(
    bundle.indexOf("function Jve("),
    bundle.indexOf("function Yve("),
  );
  assert.match(configAwareSelection, /let C = m\?\.model \?\? null/);
  assert.match(configAwareSelection, /userSavedModelString: T \? null : C/);
  assert.match(configAwareSelection, /E = Kve\([\s\S]*?,\s+f,\s+\)/);
});

test("HTTP browser bridge does not depend on secure-context randomUUID", () => {
  const shim = fs.readFileSync(
    path.join(__dirname, "..", "src", "browser", "shim.ts"),
    "utf8",
  );
  assert.match(shim, /globalThis\.crypto\?\.getRandomValues/);
  assert.match(shim, /const connectionId = createBridgeConnectionId\(\)/);
  assert.doesNotMatch(
    shim,
    /const connectionId = (?:globalThis\.)?crypto\.randomUUID/,
  );
  assert.match(shim, /reportedRendererListenerErrors\.has\(channel\)/);
});

test("ChatGPT pubsub uses the same-origin relay and separate hydration recovery", () => {
  const shim = fs.readFileSync(
    path.join(__dirname, "..", "src", "browser", "shim.ts"),
    "utf8",
  );
  const browserRelay = fs.readFileSync(
    path.join(__dirname, "..", "src", "browser", "chatgpt-pubsub-relay.ts"),
    "utf8",
  );
  const server = fs.readFileSync(
    path.join(__dirname, "..", "src", "server", "main.ts"),
    "utf8",
  );
  const viteConfig = fs.readFileSync(
    path.join(__dirname, "..", "vite.browser.config.ts"),
    "utf8",
  );
  const desktopBundle = fs.readFileSync(assetPath, "utf8");

  assert.match(desktopBundle, /let n = new WebSocket\(t\)/);
  assert.match(shim, /installChatGptPubsubRelay\(\)/);
  assert.match(browserRelay, /class CodexWebWebSocket extends NativeWebSocket/);
  assert.match(browserRelay, /codex-web-chatgpt-pubsub\./);
  assert.match(browserRelay, /"chatgpt\.com"/);
  assert.match(browserRelay, /"ws\.chatgpt\.com"/);
  assert.match(browserRelay, /"ws\.chatgpt-staging\.com"/);
  assert.match(browserRelay, /CHATGPT_PUBSUB_RECOVERY_COOLDOWN_MS/);
  assert.match(browserRelay, /window\.location\.reload\(\)/);
  assert.match(server, /chatGptPubsubRelay\.handleUpgrade/);
  assert.match(viteConfig, /"\/__backend\/chatgpt-pubsub"/);
  assert.doesNotMatch(
    browserRelay,
    /CHATGPT_PUBSUB_RELAY_PATH[\s\S]{0,1000}searchParams\.set/,
  );
});

test("browser reliable bridge rejects acknowledgements above the sent id", () => {
  const shim = fs.readFileSync(
    path.join(__dirname, "..", "src", "browser", "shim.ts"),
    "utf8",
  );
  const acceptAck = shim.slice(
    shim.indexOf("function acceptAck("),
    shim.indexOf("function pumpOutgoing("),
  );
  assert.match(acceptAck, /ack > outgoingSentId/);
  assert.doesNotMatch(acceptAck, /ack > outgoingMessageId/);
});

test("Desktop main bundle retains the node-pty integration point", () => {
  const buildDirectory = path.join(
    __dirname,
    "..",
    "scratch",
    "asar",
    ".vite",
    "build",
  );
  const mainBundleName = fs
    .readdirSync(buildDirectory)
    .find((name) => /^main-.*\.js$/.test(name));
  assert.ok(mainBundleName, "expected exactly one Desktop main bundle");
  const mainBundle = fs.readFileSync(
    path.join(buildDirectory, mainBundleName),
    "utf8",
  );
  assert.match(mainBundle, /['\"`]node-pty['\"`]/);
});

test("model patch is an explicit fail-closed prepare step", () => {
  const prepare = fs.readFileSync(
    path.join(__dirname, "..", "scripts", "prepare_asar"),
    "utf8",
  );
  const invocation =
    "patch --batch --forward --strip 1 --directory scratch/asar < patches/webview-model-authority.patch";
  assert.equal(prepare.split(invocation).length - 1, 1);
});
