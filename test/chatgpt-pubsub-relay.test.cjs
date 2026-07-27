const assert = require("node:assert/strict");
const { EventEmitter, once } = require("node:events");
const http = require("node:http");
const path = require("node:path");
const test = require("node:test");
const { WebSocket } = require("ws");

const repositoryRoot = path.resolve(__dirname, "..");
const serverBuildRoot = process.env.CODEX_WEB_SERVER_BUILD_ROOT
  ? path.resolve(process.env.CODEX_WEB_SERVER_BUILD_ROOT)
  : path.join(repositoryRoot, "src", "server");
const {
  CHATGPT_PUBSUB_RELAY_PATH,
  CHATGPT_PUBSUB_RELAY_PROTOCOL_PREFIX,
  CHATGPT_PUBSUB_UPSTREAM_HOSTS,
  ChatGptPubsubRelay,
  chatGptPubsubOriginForTarget,
  parseChatGptPubsubRelayTarget,
} = require(path.join(serverBuildRoot, "chatgpt-pubsub-relay.js"));

function relayProtocol(target) {
  return `${CHATGPT_PUBSUB_RELAY_PROTOCOL_PREFIX}${Buffer.from(
    target,
    "utf8",
  ).toString("base64url")}`;
}

function waitFor(label, predicate, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const poll = () => {
      try {
        const result = predicate();
        if (result) {
          resolve(result);
          return;
        }
      } catch (error) {
        reject(error);
        return;
      }
      if (Date.now() >= deadline) {
        reject(new Error(`Timed out waiting for ${label}`));
        return;
      }
      setTimeout(poll, 5);
    };
    poll();
  });
}

class FakeUpstreamWebSocket extends EventEmitter {
  constructor() {
    super();
    this.readyState = WebSocket.CONNECTING;
    this.sent = [];
  }

  open() {
    assert.equal(this.readyState, WebSocket.CONNECTING);
    this.readyState = WebSocket.OPEN;
    this.emit("open");
  }

  send(data, options, callback) {
    assert.equal(this.readyState, WebSocket.OPEN);
    this.sent.push({
      data: Buffer.isBuffer(data) ? Buffer.from(data) : data,
      isBinary: options.binary,
    });
    callback?.();
  }

  close(code = 1005) {
    if (this.readyState === WebSocket.CLOSED) return;
    this.readyState = WebSocket.CLOSED;
    this.emit("close", code, Buffer.alloc(0));
  }

  terminate() {
    this.close(1006);
  }
}

test("relay target parser accepts only the bundled ChatGPT pubsub hosts", () => {
  assert.deepEqual(CHATGPT_PUBSUB_UPSTREAM_HOSTS, [
    "chatgpt.com",
    "ws.chatgpt.com",
    "ws.chatgpt-staging.com",
  ]);

  for (const hostname of CHATGPT_PUBSUB_UPSTREAM_HOSTS) {
    const target = `wss://${hostname}/ws?access_token=signed-value`;
    assert.equal(
      parseChatGptPubsubRelayTarget(relayProtocol(target))?.href,
      target,
    );
  }

  for (const target of [
    "ws://ws.chatgpt.com/ws",
    "https://ws.chatgpt.com/ws",
    "wss://evil.chatgpt.com/ws",
    "wss://ws.chatgpt.com.example.test/ws",
    "wss://user:password@ws.chatgpt.com/ws",
    "wss://ws.chatgpt.com:8443/ws",
    "wss://ws.chatgpt.com/ws#signed-fragment",
  ]) {
    assert.equal(
      parseChatGptPubsubRelayTarget(relayProtocol(target)),
      null,
      target,
    );
  }

  assert.equal(parseChatGptPubsubRelayTarget(undefined), null);
  assert.equal(parseChatGptPubsubRelayTarget([]), null);
  assert.equal(
    parseChatGptPubsubRelayTarget(
      `${relayProtocol("wss://ws.chatgpt.com/ws")},other-protocol`,
    ),
    null,
  );
  assert.equal(
    parseChatGptPubsubRelayTarget(
      `${CHATGPT_PUBSUB_RELAY_PROTOCOL_PREFIX}not+base64`,
    ),
    null,
  );
  assert.equal(
    parseChatGptPubsubRelayTarget(
      relayProtocol(`wss://ws.chatgpt.com/${"a".repeat(9 * 1024)}`),
    ),
    null,
  );

  assert.equal(
    chatGptPubsubOriginForTarget(new URL("wss://ws.chatgpt.com/ws")),
    "https://chatgpt.com",
  );
  assert.equal(
    chatGptPubsubOriginForTarget(new URL("wss://ws.chatgpt-staging.com/ws")),
    "https://chatgpt-staging.com",
  );
});

test("relay keeps the signed target out of the request URL and forwards queued frames", async (t) => {
  const upstream = new FakeUpstreamWebSocket();
  let receivedTarget = null;
  let receivedRequestUrl = null;
  const relay = new ChatGptPubsubRelay({
    createUpstreamWebSocket(target) {
      receivedTarget = target;
      return upstream;
    },
  });
  const server = http.createServer();
  server.on("upgrade", (request, socket, head) => {
    receivedRequestUrl = request.url;
    if (!relay.handleUpgrade(request, socket, head)) {
      socket.destroy();
    }
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  t.after(async () => {
    await relay.close().catch(() => undefined);
    await new Promise((resolve) => server.close(() => resolve()));
  });

  const address = server.address();
  assert(address && typeof address !== "string");
  const signedTarget =
    "wss://ws.chatgpt.com/ws?access_token=must-not-enter-request-logs";
  const protocol = relayProtocol(signedTarget);
  const client = new WebSocket(
    `ws://127.0.0.1:${address.port}${CHATGPT_PUBSUB_RELAY_PATH}`,
    protocol,
  );
  t.after(() => client.terminate());
  await once(client, "open");

  assert.equal(client.protocol, protocol);
  assert.equal(receivedRequestUrl, CHATGPT_PUBSUB_RELAY_PATH);
  assert.equal(receivedRequestUrl.includes("access_token"), false);
  assert.equal(receivedTarget.href, signedTarget);

  client.send("queued-before-upstream-open");
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(upstream.sent, []);

  upstream.open();
  await waitFor("queued client frame to reach upstream", () =>
    upstream.sent.length === 1 ? upstream.sent[0] : null,
  );
  assert.equal(upstream.sent[0].data.toString(), "queued-before-upstream-open");
  assert.equal(upstream.sent[0].isBinary, false);

  const incoming = once(client, "message");
  upstream.emit("message", Buffer.from("from-upstream"), false);
  const [data, isBinary] = await incoming;
  assert.equal(data.toString(), "from-upstream");
  assert.equal(isBinary, false);

  const closed = once(client, "close");
  client.close();
  await closed;
  assert.equal(upstream.readyState, WebSocket.CLOSED);
});
