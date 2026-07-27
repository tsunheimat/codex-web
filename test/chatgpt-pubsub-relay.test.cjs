const assert = require("node:assert/strict");
const { EventEmitter, once } = require("node:events");
const http = require("node:http");
const https = require("node:https");
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

  close(code = 1005, reason = Buffer.alloc(0)) {
    if (this.readyState === WebSocket.CLOSED) return;
    this.readyState = WebSocket.CLOSED;
    this.emit("close", code, reason);
  }

  terminate() {
    this.close(1006);
  }
}

function createDiagnosticRecorder() {
  const messages = [];
  return {
    logger: {
      info(message) {
        messages.push(`info ${message}`);
      },
      warn(message) {
        messages.push(`warn ${message}`);
      },
    },
    messages,
  };
}

async function openRelayClient(
  t,
  { clientHeaders, target, ...relayOptions } = {},
) {
  const relay = new ChatGptPubsubRelay(relayOptions);
  const server = http.createServer();
  server.on("upgrade", (request, socket, head) => {
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
  const upstreamTarget =
    target ?? "wss://ws.chatgpt.com/ws?access_token=signed-diagnostic-secret";
  const client = new WebSocket(
    `ws://127.0.0.1:${address.port}${CHATGPT_PUBSUB_RELAY_PATH}`,
    relayProtocol(upstreamTarget),
    { headers: clientHeaders },
  );
  t.after(() => client.terminate());
  await once(client, "open");

  return { client, relay, target: upstreamTarget };
}

const proxyEnvironmentNames = [
  "HTTPS_PROXY",
  "https_proxy",
  "WSS_PROXY",
  "wss_proxy",
  "ALL_PROXY",
  "all_proxy",
  "NO_PROXY",
  "no_proxy",
];

function replaceProxyEnvironment(t, values) {
  const previous = Object.fromEntries(
    proxyEnvironmentNames.map((name) => [name, process.env[name]]),
  );
  for (const name of proxyEnvironmentNames) {
    delete process.env[name];
  }
  Object.assign(process.env, values);
  t.after(() => {
    for (const name of proxyEnvironmentNames) {
      const value = previous[name];
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
  });
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

test("relay logs safe upstream open and close diagnostics", async (t) => {
  const upstream = new FakeUpstreamWebSocket();
  const { logger, messages } = createDiagnosticRecorder();
  const { client, target } = await openRelayClient(t, {
    createUpstreamWebSocket() {
      return upstream;
    },
    logger,
  });

  upstream.open();
  await waitFor("upstream open diagnostic", () =>
    messages.some((message) => message.includes("upstream open")),
  );

  const closed = once(client, "close");
  upstream.close(4001, Buffer.from("close-reason-secret"));
  await closed;

  assert.deepEqual(messages, [
    "info [chatgpt-pubsub-relay] upstream open host=ws.chatgpt.com",
    "info [chatgpt-pubsub-relay] upstream close host=ws.chatgpt.com code=4001",
  ]);
  const diagnostics = messages.join("\n");
  assert.equal(diagnostics.includes(new URL(target).search), false);
  assert.equal(diagnostics.includes("signed-diagnostic-secret"), false);
  assert.equal(diagnostics.includes("close-reason-secret"), false);
});

test("relay logs an unexpected upstream HTTP response without response secrets", async (t) => {
  const upstream = new FakeUpstreamWebSocket();
  const { logger, messages } = createDiagnosticRecorder();
  const { client, target } = await openRelayClient(t, {
    createUpstreamWebSocket() {
      return upstream;
    },
    logger,
  });
  upstream.emit(
    "unexpected-response",
    {},
    {
      headers: { "set-cookie": "session=response-cookie-secret" },
      statusCode: 403,
      statusMessage: "response-status-secret",
    },
  );
  await waitFor(
    "downstream close after unexpected upstream response",
    () => client.readyState === WebSocket.CLOSED,
  );
  upstream.emit(
    "error",
    new Error("synthetic handshake abort with response-status-secret"),
  );

  assert.equal(
    messages.includes(
      "warn [chatgpt-pubsub-relay] upstream unexpected-response host=ws.chatgpt.com status=403",
    ),
    true,
  );
  assert.equal(
    messages.some((message) => message.includes("upstream error")),
    false,
  );
  const diagnostics = messages.join("\n");
  for (const secret of [
    new URL(target).search,
    "signed-diagnostic-secret",
    "response-cookie-secret",
    "response-status-secret",
  ]) {
    assert.equal(diagnostics.includes(secret), false, secret);
  }
});

test("relay logs an upstream error without its URL or proxy credentials", async (t) => {
  const upstream = new FakeUpstreamWebSocket();
  const { logger, messages } = createDiagnosticRecorder();
  const { client, target } = await openRelayClient(t, {
    createUpstreamWebSocket() {
      return upstream;
    },
    logger,
  });
  const closed = once(client, "close");
  const upstreamError = new Error(
    `connect failed for ${target} via http://proxy-user:proxy-secret@proxy.invalid`,
  );
  upstreamError.code = "ECONNRESET";

  upstream.emit("error", upstreamError);
  await closed;

  assert.equal(
    messages.includes(
      "warn [chatgpt-pubsub-relay] upstream error host=ws.chatgpt.com code=ECONNRESET",
    ),
    true,
  );
  const diagnostics = messages.join("\n");
  for (const secret of [
    new URL(target).search,
    "signed-diagnostic-secret",
    "proxy-user",
    "proxy-secret",
  ]) {
    assert.equal(diagnostics.includes(secret), false, secret);
  }
});

test("relay bounds malformed upstream diagnostic fields", async (t) => {
  const responseUpstream = new FakeUpstreamWebSocket();
  const responseRecorder = createDiagnosticRecorder();
  const responseRelay = await openRelayClient(t, {
    createUpstreamWebSocket() {
      return responseUpstream;
    },
    logger: responseRecorder.logger,
  });
  responseUpstream.emit("unexpected-response", {}, { statusCode: undefined });
  await waitFor(
    "downstream close after malformed response status",
    () => responseRelay.client.readyState === WebSocket.CLOSED,
  );
  assert.equal(
    responseRecorder.messages.includes(
      "warn [chatgpt-pubsub-relay] upstream unexpected-response host=ws.chatgpt.com status=unknown",
    ),
    true,
  );

  const closeUpstream = new FakeUpstreamWebSocket();
  const closeRecorder = createDiagnosticRecorder();
  const closeRelay = await openRelayClient(t, {
    createUpstreamWebSocket() {
      return closeUpstream;
    },
    logger: closeRecorder.logger,
  });
  closeUpstream.close(Number.NaN, Buffer.from("malformed-close-secret"));
  await waitFor(
    "downstream close after malformed upstream close",
    () => closeRelay.client.readyState === WebSocket.CLOSED,
  );
  assert.equal(
    closeRecorder.messages.includes(
      "info [chatgpt-pubsub-relay] upstream close host=ws.chatgpt.com code=unknown",
    ),
    true,
  );
  assert.equal(
    closeRecorder.messages.join("\n").includes("malformed-close-secret"),
    false,
  );
});

test(
  "default wss upstream honors WSS, HTTPS, ALL, and NO_PROXY precedence",
  { concurrency: false },
  async (t) => {
    const originalHttpsRequest = https.request;
    const requests = [];
    https.request = (options) => {
      requests.push(options);
      const error = new Error("test stopped the upstream request");
      error.code = "UNSAFE_TEST_CODE";
      throw error;
    };
    t.after(() => {
      https.request = originalHttpsRequest;
    });
    replaceProxyEnvironment(t, {
      ALL_PROXY: "http://127.0.0.1:5128",
      HTTPS_PROXY: "http://127.0.0.1:3128",
    });

    const first = await openRelayClient(t, {
      clientHeaders: {
        authorization: "Bearer browser-auth-secret",
        cookie: "session=browser-cookie-secret",
      },
      logger: {
        info() {
          throw new Error("test logger failed");
        },
        warn() {
          throw new Error("test logger failed");
        },
      },
    });
    await waitFor(
      "downstream close after proxied request",
      () => first.client.readyState === WebSocket.CLOSED,
    );
    assert.equal(requests.length, 1);
    assert.equal(requests[0].agent?.proxy?.origin, "http://127.0.0.1:3128");
    const upstreamHeaders = JSON.stringify(requests[0].headers);
    assert.equal(upstreamHeaders.includes("browser-auth-secret"), false);
    assert.equal(upstreamHeaders.includes("browser-cookie-secret"), false);

    process.env.wss_proxy = "http://127.0.0.1:4128";
    const wssRecorder = createDiagnosticRecorder();
    const wss = await openRelayClient(t, { logger: wssRecorder.logger });
    await waitFor(
      "downstream close after WSS-proxied request",
      () => wss.client.readyState === WebSocket.CLOSED,
    );
    assert.equal(requests.length, 2);
    assert.equal(requests[1].agent?.proxy?.origin, "http://127.0.0.1:4128");

    delete process.env.wss_proxy;
    process.env.NO_PROXY = "ws.chatgpt.com";
    const secondRecorder = createDiagnosticRecorder();
    const second = await openRelayClient(t, { logger: secondRecorder.logger });
    await waitFor(
      "downstream close after direct request",
      () => second.client.readyState === WebSocket.CLOSED,
    );
    assert.equal(requests.length, 3);
    assert.equal(requests[2].agent, undefined);
  },
);
