const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const ts = require("typescript");

function compileTypeScriptModule(relativePath, window, dependencies = {}) {
  const filename = path.join(__dirname, "..", relativePath);
  const source = fs.readFileSync(filename, "utf8");
  const compiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
    fileName: filename,
  }).outputText;
  const module = { exports: {} };
  const localRequire = (specifier) =>
    Object.hasOwn(dependencies, specifier)
      ? dependencies[specifier]
      : require(specifier);
  new Function("exports", "module", "require", "window", compiled)(
    module.exports,
    module,
    localRequire,
    window,
  );
  return module.exports;
}

function createBrowserHarness() {
  let reloaded = false;
  const scheduledTimers = new Set();

  class FakeWebSocket extends EventTarget {
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSING = 2;
    static CLOSED = 3;

    constructor(url, protocols) {
      super();
      this.protocols = protocols;
      this.readyState = FakeWebSocket.OPEN;
      this.sent = [];
      this.url = String(url);
    }

    send(data) {
      this.sent.push(data);
    }

    closeFromServer() {
      this.readyState = FakeWebSocket.CLOSED;
      this.dispatchEvent(new Event("close"));
    }
  }

  const storage = new Map();
  const window = {
    WebSocket: FakeWebSocket,
    addEventListener() {},
    clearTimeout(timer) {
      scheduledTimers.delete(timer);
    },
    dispatchEvent() {},
    location: {
      href: "https://codex.example/work/conversation/local-chatgpt%3Atest",
      pathname: "/work/conversation/local-chatgpt%3Atest",
      protocol: "https:",
      reload() {
        reloaded = true;
      },
    },
    sessionStorage: {
      getItem(key) {
        return storage.get(key) ?? null;
      },
      setItem(key, value) {
        storage.set(key, value);
      },
    },
    setTimeout(callback) {
      scheduledTimers.add(callback);
      return callback;
    },
  };

  return {
    reloaded: () => reloaded,
    scheduledTimers,
    window,
  };
}

test("relay close delivers ChatGPT recovery before the ordinary close listener", () => {
  const harness = createBrowserHarness();
  const recovery = compileTypeScriptModule(
    "src/browser/chatgpt-pubsub-recovery.ts",
    harness.window,
  );
  const routes = compileTypeScriptModule(
    "src/browser/routes.ts",
    harness.window,
  );
  const relay = compileTypeScriptModule(
    "src/browser/chatgpt-pubsub-relay.ts",
    harness.window,
    {
      "./chatgpt-pubsub-recovery": recovery,
      "./routes": routes,
      "./server-config": compileTypeScriptModule("src/browser/server-config.ts", harness.window),
    },
  );

  relay.installChatGptPubsubRelay();
  const socket = new harness.window.WebSocket(
    "wss://ws.chatgpt.com/ws?access_token=signed-secret",
  );
  const recoveryFrames = [];
  let framesSeenByCloseListener = -1;
  socket.addEventListener("message", (event) => {
    recoveryFrames.push(JSON.parse(event.data));
  });
  socket.addEventListener("close", () => {
    framesSeenByCloseListener = recoveryFrames.length;
  });

  socket.send(
    JSON.stringify([
      {
        id: 21,
        command: {
          type: "subscribe",
          topic_id: "conversation-turn-topic",
        },
      },
    ]),
  );
  socket.closeFromServer();

  assert.equal(socket.url, "wss://codex.example/__backend/chatgpt-pubsub");
  assert.equal(framesSeenByCloseListener, 1);
  assert.deepEqual(recoveryFrames, [
    [{ id: 21, reply: { type: "codex-web-relay-unavailable" } }],
  ]);
  assert.equal(harness.scheduledTimers.size, 0);
  assert.equal(harness.reloaded(), false);
});
