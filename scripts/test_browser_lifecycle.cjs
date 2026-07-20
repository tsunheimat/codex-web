#!/usr/bin/env node

const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const http = require("node:http");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");
const { chromium } = require("playwright");

const repositoryRoot = path.resolve(__dirname, "..");
const scenarios = [
  {
    name: "same-page reconnect",
    token: "phase2-reconnect-request-6f4d9b",
    output: "PHASE2_RECONNECT_RESULT_91A73C",
    delayMs: 2_500,
  },
  {
    name: "hard refresh",
    token: "phase2-refresh-request-23e81a",
    output: "PHASE2_REFRESH_RESULT_4D52BE",
    delayMs: 10_000,
  },
  {
    name: "browser close/reopen",
    token: "phase2-reopen-request-b75c20",
    output: "PHASE2_REOPEN_RESULT_8F306D",
    delayMs: 2_500,
  },
];

const childLogs = new Map();
const children = new Set();
let browserContext = null;
const maximumChildLogCharacters = 100_000;
const exactlyOnceStabilityWindowMs = 1_500;

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitFor(description, predicate, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const result = await predicate();
      if (result) {
        return result;
      }
    } catch (error) {
      lastError = error;
    }
    await wait(100);
  }
  throw new Error(
    `Timed out waiting for ${description}${lastError ? `: ${lastError}` : ""}`,
  );
}

function captureChild(child, label) {
  children.add(child);
  const lines = [];
  const log = { characterCount: 0, label, lines };
  childLogs.set(child, log);
  for (const stream of [child.stdout, child.stderr]) {
    stream?.on("data", (chunk) => {
      const text = String(chunk);
      lines.push(text);
      log.characterCount += text.length;
      while (
        lines.length > 1 &&
        log.characterCount > maximumChildLogCharacters
      ) {
        log.characterCount -= lines.shift().length;
      }
      if (process.env.CODEX_WEB_BROWSER_E2E_VERBOSE === "1") {
        process.stderr.write(`[${label}] ${text}`);
      }
    });
  }
  child.once("exit", () => children.delete(child));
  return child;
}

function childOutput(child) {
  return childLogs.get(child)?.lines.join("") ?? "";
}

async function waitForChildMessage(child, predicate, timeoutMs = 15_000) {
  return await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.off("message", onMessage);
      reject(
        new Error(
          `Timed out waiting for ${childLogs.get(child)?.label} message\n${childOutput(child)}`,
        ),
      );
    }, timeoutMs);
    const onMessage = (message) => {
      if (!predicate(message)) {
        return;
      }
      clearTimeout(timeout);
      child.off("message", onMessage);
      resolve(message);
    };
    child.on("message", onMessage);
  });
}

async function unusedLoopbackPort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert(address && typeof address !== "string");
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return address.port;
}

async function startLoopbackProxy(targetPort) {
  const clientSockets = new Set();
  const upstreamSockets = new Set();
  const ipcConnections = [];
  let closing = false;

  const proxyServer = http.createServer((request, response) => {
    const upstreamRequest = http.request(
      {
        agent: false,
        headers: request.headers,
        host: "127.0.0.1",
        method: request.method,
        path: request.url,
        port: targetPort,
      },
      (upstreamResponse) => {
        response.writeHead(
          upstreamResponse.statusCode,
          upstreamResponse.statusMessage,
          upstreamResponse.rawHeaders,
        );
        upstreamResponse.pipe(response);
      },
    );
    upstreamRequest.on("error", (error) => {
      if (closing) {
        response.destroy();
        return;
      }
      if (response.headersSent) {
        response.destroy(error);
        return;
      }
      response.writeHead(502, { "content-type": "text/plain" });
      response.end("Loopback lifecycle proxy could not reach Codex Web");
    });
    request.on("aborted", () => upstreamRequest.destroy());
    response.on("close", () => {
      if (!response.writableEnded) {
        upstreamRequest.destroy();
      }
    });
    request.pipe(upstreamRequest);
  });

  proxyServer.on("connection", (socket) => {
    clientSockets.add(socket);
    socket.once("close", () => clientSockets.delete(socket));
  });

  proxyServer.on("upgrade", (request, clientSocket, head) => {
    clientSocket.pause();
    const upstreamSocket = net.createConnection({
      host: "127.0.0.1",
      port: targetPort,
    });
    upstreamSockets.add(upstreamSocket);
    upstreamSocket.once("close", () => upstreamSockets.delete(upstreamSocket));

    const requestPath = new URL(
      request.url ?? "/",
      "http://lifecycle-proxy.invalid",
    ).pathname;
    const ipcConnection =
      requestPath === "/__backend/ipc"
        ? {
            sequence: ipcConnections.length + 1,
            createdAt: Date.now(),
            connectedAt: null,
            severedAt: null,
            clientClosedAt: null,
            upstreamClosedAt: null,
          }
        : null;
    if (ipcConnection) {
      ipcConnections.push(ipcConnection);
      Object.defineProperties(ipcConnection, {
        clientSocket: { value: clientSocket },
        upstreamSocket: { value: upstreamSocket },
      });
    }

    clientSocket.on("error", () => upstreamSocket.destroy());
    upstreamSocket.on("error", () => clientSocket.destroy());
    clientSocket.once("close", () => {
      if (ipcConnection) {
        ipcConnection.clientClosedAt = Date.now();
      }
      upstreamSocket.destroy();
    });
    upstreamSocket.once("close", () => {
      if (ipcConnection) {
        ipcConnection.upstreamClosedAt = Date.now();
      }
      clientSocket.destroy();
    });
    upstreamSocket.once("connect", () => {
      if (ipcConnection) {
        ipcConnection.connectedAt = Date.now();
      }
      const requestLines = [
        `${request.method} ${request.url} HTTP/${request.httpVersion}`,
      ];
      for (let index = 0; index < request.rawHeaders.length; index += 2) {
        requestLines.push(
          `${request.rawHeaders[index]}: ${request.rawHeaders[index + 1]}`,
        );
      }
      upstreamSocket.write(`${requestLines.join("\r\n")}\r\n\r\n`);
      if (head.length > 0) {
        upstreamSocket.write(head);
      }
      clientSocket.pipe(upstreamSocket);
      upstreamSocket.pipe(clientSocket);
      clientSocket.resume();
    });
  });

  await new Promise((resolve, reject) => {
    proxyServer.once("error", reject);
    proxyServer.listen(0, "127.0.0.1", resolve);
  });
  const address = proxyServer.address();
  assert(address && typeof address !== "string");

  return {
    origin: `http://127.0.0.1:${address.port}`,
    ipcConnections,
    activeIpcConnections() {
      return ipcConnections.filter(
        (connection) =>
          connection.connectedAt !== null &&
          connection.severedAt === null &&
          connection.clientClosedAt === null &&
          connection.upstreamClosedAt === null,
      );
    },
    severIpcConnection(connection) {
      assert(
        ipcConnections.includes(connection),
        "IPC connection does not belong to this lifecycle proxy",
      );
      assert.equal(
        connection.severedAt,
        null,
        "IPC connection already severed",
      );
      assert.equal(
        connection.clientClosedAt,
        null,
        "IPC client connection already closed",
      );
      assert.equal(
        connection.upstreamClosedAt,
        null,
        "IPC upstream connection already closed",
      );
      connection.severedAt = Date.now();
      connection.clientSocket.destroy();
      connection.upstreamSocket.destroy();
    },
    async close() {
      closing = true;
      for (const socket of [...clientSockets, ...upstreamSockets]) {
        socket.destroy();
      }
      await new Promise((resolve, reject) => {
        proxyServer.close((error) => (error ? reject(error) : resolve()));
      });
      await waitFor(
        "loopback proxy socket cleanup",
        () => clientSockets.size === 0 && upstreamSockets.size === 0,
        10_000,
      );
    },
  };
}

function findExecutable(command) {
  const result = spawnSync("which", [command], { encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`Required executable not found: ${command}`);
  }
  return result.stdout.trim();
}

function processTable() {
  const result = spawnSync("ps", ["-eo", "pid=,ppid=,args="], {
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const match = line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/);
      assert(match, line);
      return { pid: Number(match[1]), ppid: Number(match[2]), args: match[3] };
    });
}

function descendantsOf(parentPid) {
  const table = processTable();
  const descendants = [];
  const pending = [parentPid];
  while (pending.length > 0) {
    const current = pending.shift();
    for (const process of table.filter(({ ppid }) => ppid === current)) {
      if (descendants.some(({ pid }) => pid === process.pid)) {
        continue;
      }
      descendants.push(process);
      pending.push(process.pid);
    }
  }
  return descendants;
}

function processExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code !== "ESRCH";
  }
}

async function stopChild(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  child.kill("SIGTERM");
  const exited = await Promise.race([
    new Promise((resolve) => child.once("exit", () => resolve(true))),
    wait(3_000).then(() => false),
  ]);
  if (!exited) {
    child.kill("SIGKILL");
    await new Promise((resolve) => child.once("exit", resolve));
  }
}

async function mockState(baseUrl) {
  const response = await fetch(`${baseUrl}/__control/state`);
  assert.equal(response.status, 200);
  return await response.json();
}

function attachPageDiagnostics(page, diagnostics) {
  page.on("console", (message) => {
    boundedPush(
      diagnostics.console,
      `${message.type()}: ${message.text()}`,
      200,
    );
  });
  page.on("pageerror", (error) => {
    boundedPush(diagnostics.pageErrors, String(error), 200);
  });
  page.on("websocket", (websocket) => {
    boundedPush(diagnostics.websockets, websocket.url(), 100);
    const ipcSocket = websocket.url().endsWith("/__backend/ipc")
      ? {
          sequence: diagnostics.ipcWebSockets.length + 1,
          url: websocket.url(),
          createdAt: Date.now(),
          closedAt: null,
          receivedControlFrames: [],
          sentControlFrames: [],
        }
      : null;
    if (ipcSocket) {
      boundedPush(diagnostics.ipcWebSockets, ipcSocket, 100);
      websocket.on("close", () => {
        ipcSocket.closedAt = Date.now();
      });
      websocket.on("socketerror", (error) => {
        ipcSocket.socketError = String(error);
      });
    }
    websocket.on("framesent", (event) => {
      const payload = String(event.payload);
      const controlFrame = compactBridgeControlFrame(payload);
      if (ipcSocket && controlFrame !== null) {
        boundedPush(ipcSocket.sentControlFrames, controlFrame, 50);
      }
      const frame = compactWebSocketFrame(payload);
      if (frame !== null) {
        boundedPush(diagnostics.sentFrames, frame, 500);
      }
    });
    websocket.on("framereceived", (event) => {
      const payload = String(event.payload);
      const controlFrame = compactBridgeControlFrame(payload);
      if (ipcSocket && controlFrame !== null) {
        boundedPush(ipcSocket.receivedControlFrames, controlFrame, 50);
      }
      const frame = compactWebSocketFrame(payload);
      if (frame !== null) {
        boundedPush(diagnostics.receivedFrames, frame, 500);
      }
    });
  });
}

function boundedPush(values, value, maximumLength) {
  values.push(value);
  if (values.length > maximumLength) {
    values.splice(0, values.length - maximumLength);
  }
}

function compactBridgeControlFrame(frame) {
  try {
    const parsed = JSON.parse(frame);
    if (parsed.type === "bridge-hello") {
      return {
        type: parsed.type,
        protocolVersion: parsed.protocolVersion,
        connectionId: parsed.connectionId,
        serverEpoch: parsed.serverEpoch,
      };
    }
    if (parsed.type === "bridge-ready") {
      return {
        type: parsed.type,
        connectionId: parsed.connectionId,
        serverEpoch: parsed.serverEpoch,
      };
    }
  } catch {
    return null;
  }
  return null;
}

function compactWebSocketFrame(frame) {
  try {
    const parsed = JSON.parse(frame);
    const firstArgument = parsed?.message?.args?.[0];
    if (parsed.type !== "bridge-data") {
      return null;
    }
    const argumentType = firstArgument?.type;
    const requestMethod = firstArgument?.request?.method;
    const eventMethod = firstArgument?.method;
    const rendererReady = parsed.message?.type === "renderer-bridge-ready";
    const relevant =
      rendererReady ||
      requestMethod?.startsWith("thread/") ||
      requestMethod?.startsWith("turn/") ||
      argumentType === "thread-role-request" ||
      argumentType === "thread-role-response" ||
      argumentType === "ipc-broadcast" ||
      (argumentType === "mcp-notification" &&
        (eventMethod?.startsWith("thread/") ||
          eventMethod?.startsWith("turn/") ||
          eventMethod?.startsWith("item/"))) ||
      (argumentType === "mcp-response" &&
        (firstArgument?.message?.result?.thread ||
          firstArgument?.message?.result?.turn));
    if (!relevant) {
      return null;
    }
    return JSON.stringify({
      type: parsed.type,
      id: parsed.id,
      ack: parsed.ack,
      message: {
        type: parsed.message?.type,
        channel: parsed.message?.channel,
        currentThreadId: parsed.message?.currentThreadId,
        argument: {
          type: firstArgument?.type,
          url: firstArgument?.url,
          level: firstArgument?.level,
          logMessage:
            typeof firstArgument?.message === "string"
              ? firstArgument.message
              : undefined,
          requestMethod,
          threadId: firstArgument?.request?.params?.threadId,
          conversationId:
            firstArgument?.conversationId ??
            firstArgument?.params?.conversationId ??
            firstArgument?.request?.params?.conversationId,
          requestId: firstArgument?.requestId,
          role: firstArgument?.role,
          method: firstArgument?.method,
          sourceClientId: firstArgument?.sourceClientId,
          status: firstArgument?.params?.status,
          responseId: firstArgument?.message?.id,
          responseThreadId: firstArgument?.message?.result?.thread?.id,
          responseThreadStatus:
            firstArgument?.message?.result?.thread?.status?.type,
          responseThreadTurnCount:
            firstArgument?.message?.result?.thread?.turns?.length,
          responseLastTurnItemCount:
            firstArgument?.message?.result?.thread?.turns?.at?.(-1)?.items
              ?.length,
          responseTurnId: firstArgument?.message?.result?.turn?.id,
          responseTurnStatus: firstArgument?.message?.result?.turn?.status,
          responseTurnItemCount:
            firstArgument?.message?.result?.turn?.items?.length,
        },
      },
    });
  } catch {
    return frame.slice(0, 4_000);
  }
}

function isAllowedBrowserRequest(requestUrl, expectedOrigin) {
  const url = new URL(requestUrl);
  return (
    url.origin === expectedOrigin ||
    url.protocol === "data:" ||
    url.protocol === "blob:"
  );
}

async function launchBrowser(profileDirectory, diagnostics, expectedOrigin) {
  browserContext = await chromium.launchPersistentContext(profileDirectory, {
    headless: false,
    args: process.getuid?.() === 0 ? ["--no-sandbox"] : [],
    viewport: { width: 1440, height: 1000 },
  });
  await browserContext.route("**/*", async (route) => {
    const requestUrl = route.request().url();
    if (isAllowedBrowserRequest(requestUrl, expectedOrigin)) {
      await route.continue();
      return;
    }
    diagnostics.blockedBrowserRequests.push(requestUrl);
    await route.abort("blockedbyclient");
  });
  const pages = browserContext.pages();
  const page = pages[0] ?? (await browserContext.newPage());
  attachPageDiagnostics(page, diagnostics);
  return page;
}

async function closeBrowser() {
  if (!browserContext) {
    return;
  }
  const context = browserContext;
  browserContext = null;
  await context.close();
}

async function waitForComposer(page) {
  const composer = page.locator('[contenteditable="true"]:visible').last();
  await composer.waitFor({
    state: "visible",
    timeout: Number(process.env.CODEX_WEB_COMPOSER_TIMEOUT_MS ?? 60_000),
  });
  return composer;
}

async function passFirstRunOnboarding(page) {
  const deadline = Date.now() + 60_000;
  const dismissButtons = ["Skip", "Continue with current model"];
  while (Date.now() < deadline) {
    let dismissed = false;
    for (const buttonName of dismissButtons) {
      const button = page.getByRole("button", {
        exact: true,
        name: buttonName,
      });
      if (await button.isVisible().catch(() => false)) {
        await button.click();
        dismissed = true;
        break;
      }
    }
    if (dismissed) {
      await wait(100);
      continue;
    }

    const composer = page.locator('[contenteditable="true"]:visible').last();
    if (await composer.isVisible().catch(() => false)) {
      return composer;
    }
    await wait(100);
  }
  return await waitForComposer(page);
}

async function submitPrompt(page, prompt) {
  const composer = await waitForComposer(page);
  await composer.click();
  await composer.fill(prompt);
  await composer.press("Enter");
}

async function waitForScenarioStarted(mockBaseUrl, scenario) {
  await waitFor(
    `${scenario.name} mock request and first streaming chunk`,
    async () => {
      const state = await mockState(mockBaseUrl);
      const scenarioState = state.scenarios[scenario.token];
      return (
        scenarioState?.requestCount === 1 && scenarioState.firstChunkSentAt
      );
    },
    30_000,
  );
}

async function waitForScenarioCompleted(mockBaseUrl, scenario) {
  await waitFor(
    `${scenario.name} mock response completion`,
    async () => {
      const state = await mockState(mockBaseUrl);
      return state.scenarios[scenario.token]?.completedAt;
    },
    30_000,
  );
}

async function waitForPartialOutput(page, scenario) {
  const prefix = scenario.output.slice(
    0,
    Math.floor(scenario.output.length / 2),
  );
  await waitFor(
    `${scenario.name} partial renderer output`,
    async () => (await page.locator("body").innerText()).includes(prefix),
    30_000,
  );
}

async function assertExactlyOnce(page, marker) {
  await waitFor(
    `${marker} visible in renderer`,
    async () => (await page.locator("body").innerText()).includes(marker),
    60_000,
  );
  let bodyText = await page.locator("body").innerText();
  assert.equal(
    bodyText.split(marker).length - 1,
    1,
    `expected exactly one visible occurrence of ${marker}`,
  );
  await wait(exactlyOnceStabilityWindowMs);
  bodyText = await page.locator("body").innerText();
  assert.equal(
    bodyText.split(marker).length - 1,
    1,
    `late duplicate of ${marker} appeared during the ${exactlyOnceStabilityWindowMs}ms stability window`,
  );
}

function bridgePayloads(frames) {
  return frames.flatMap((frame) => {
    try {
      const parsed = JSON.parse(frame);
      return parsed.type === "bridge-data" ? [parsed.message] : [];
    } catch {
      return [];
    }
  });
}

function assertOfficialThreadRehydration(frames, phase) {
  const payloads = bridgePayloads(frames);
  assert(
    payloads.some((payload) => {
      const serialized = JSON.stringify(payload);
      return (
        serialized.includes("thread/read") ||
        serialized.includes("thread/resume")
      );
    }),
    `${phase} did not request official app-server thread state`,
  );
}

async function waitForOfficialThreadRehydration(framesSince, phase) {
  await waitFor(
    `${phase} official app-server thread rehydration`,
    () => {
      try {
        assertOfficialThreadRehydration(framesSince(), phase);
        return true;
      } catch {
        return false;
      }
    },
    30_000,
  );
}

function threadIdFromBrowserUrl(browserUrl) {
  const match = new URL(browserUrl).pathname.match(/^\/thread\/([^/]+)$/);
  assert(match, `expected canonical Browser thread URL, got ${browserUrl}`);
  return decodeURIComponent(match[1]);
}

async function waitForRendererReadyThread(
  framesSince,
  expectedThreadId,
  phase,
) {
  await waitFor(
    `${phase} renderer-ready current thread identity`,
    () =>
      bridgePayloads(framesSince()).some(
        (payload) =>
          payload.type === "renderer-bridge-ready" &&
          payload.currentThreadId === expectedThreadId,
      ),
    30_000,
  );
}

function appServerProcesses(serverPid) {
  return descendantsOf(serverPid).filter(({ args }) =>
    /codex.*app-server/.test(args),
  );
}

function nativeAppServerProcess(serverPid) {
  const candidates = appServerProcesses(serverPid);
  return candidates.find((candidate) =>
    candidates.some(({ pid }) => pid === candidate.ppid),
  );
}

function assertRuntimeIdentity(server, serverPid, appServerPids) {
  assert.equal(server.pid, serverPid, "server process identity changed");
  assert.equal(server.exitCode, null, `server exited\n${childOutput(server)}`);
  assert(
    processExists(serverPid),
    `server process ${serverPid} is not running`,
  );
  for (const appServerPid of appServerPids) {
    assert(
      processExists(appServerPid),
      `app-server process ${appServerPid} is not running`,
    );
  }
  const appServers = appServerProcesses(serverPid);
  assert.deepEqual(
    appServers.map(({ pid }) => pid),
    appServerPids,
    "app-server process identity changed",
  );
}

async function main() {
  const tempRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "codex-web-browser-lifecycle-"),
  );
  const isolatedHome = path.join(tempRoot, "home");
  const codexHome = path.join(isolatedHome, ".codex");
  const workspace = path.join(tempRoot, "workspace");
  const profileOne = path.join(tempRoot, "chromium-profile-one");
  const profileTwo = path.join(tempRoot, "chromium-profile-two");
  const externalNetworkLog = path.join(tempRoot, "external-network.log");
  const diagnostics = {
    blockedBrowserRequests: [],
    console: [],
    ipcWebSockets: [],
    pageErrors: [],
    receivedFrames: [],
    sentFrames: [],
    websockets: [],
  };
  let mockProvider = null;
  let server = null;
  let loopbackProxy = null;
  let serverDescendantPids = [];
  let browserDescendantPids = [];

  try {
    await Promise.all([
      fs.mkdir(codexHome, { recursive: true }),
      fs.mkdir(workspace, { recursive: true }),
      fs.mkdir(path.join(tempRoot, "tmp"), { recursive: true }),
      fs.mkdir(path.join(tempRoot, "xdg-cache"), { recursive: true }),
      fs.mkdir(path.join(tempRoot, "xdg-config"), { recursive: true }),
      fs.mkdir(path.join(tempRoot, "xdg-data"), { recursive: true }),
      fs.mkdir(path.join(tempRoot, "xdg-state"), { recursive: true }),
      fs.writeFile(externalNetworkLog, "", { mode: 0o600 }),
    ]);

    mockProvider = captureChild(
      spawn(process.execPath, ["test/fixtures/mock-responses-provider.cjs"], {
        cwd: repositoryRoot,
        env: {
          PATH: process.env.PATH,
          CODEX_WEB_MOCK_SCENARIOS: JSON.stringify(scenarios),
        },
        stdio: ["ignore", "pipe", "pipe", "ipc"],
      }),
      "mock-provider",
    );
    const mockReady = await waitForChildMessage(
      mockProvider,
      (message) => message?.type === "ready",
    );

    const config = [
      'model = "mock-model"',
      'model_provider = "codex_web_lifecycle_mock"',
      'approval_policy = "never"',
      'sandbox_mode = "read-only"',
      "",
      "[analytics]",
      "enabled = false",
      "",
      "[features]",
      "plugins = false",
      "remote_plugin = false",
      "workspace_dependencies = false",
      "",
      "[model_providers.codex_web_lifecycle_mock]",
      'name = "Codex Web lifecycle deterministic mock"',
      `base_url = "${mockReady.baseUrl}/v1"`,
      'wire_api = "responses"',
      "requires_openai_auth = false",
      "request_max_retries = 0",
      "stream_max_retries = 0",
      "supports_websockets = false",
      "",
    ].join("\n");
    await fs.writeFile(path.join(codexHome, "config.toml"), config, {
      mode: 0o600,
    });
    await fs.mkdir(path.join(codexHome, "vendor_imports"), {
      recursive: true,
    });
    await fs.writeFile(
      path.join(codexHome, "vendor_imports", "skills-curated-cache.json"),
      JSON.stringify({ fetchedAt: Date.now(), skills: [] }),
      { mode: 0o600 },
    );

    const port = await unusedLoopbackPort();
    const codexExecutable = findExecutable("codex");
    const serverEnvironment = {
      PATH: process.env.PATH,
      LANG: process.env.LANG ?? "C.UTF-8",
      LC_ALL: process.env.LC_ALL ?? "C.UTF-8",
      SHELL: "/bin/sh",
      HOME: isolatedHome,
      CODEX_HOME: codexHome,
      CODEX_CLI_PATH: codexExecutable,
      TMPDIR: path.join(tempRoot, "tmp"),
      XDG_CACHE_HOME: path.join(tempRoot, "xdg-cache"),
      XDG_CONFIG_HOME: path.join(tempRoot, "xdg-config"),
      XDG_DATA_HOME: path.join(tempRoot, "xdg-data"),
      XDG_STATE_HOME: path.join(tempRoot, "xdg-state"),
      ALL_PROXY: "http://127.0.0.1:9",
      HTTP_PROXY: "http://127.0.0.1:9",
      HTTPS_PROXY: "http://127.0.0.1:9",
      NO_PROXY: "127.0.0.1,localhost",
      all_proxy: "http://127.0.0.1:9",
      http_proxy: "http://127.0.0.1:9",
      https_proxy: "http://127.0.0.1:9",
      no_proxy: "127.0.0.1,localhost",
      CODEX_WEB_E2E_NETWORK_LOG: externalNetworkLog,
    };
    server = captureChild(
      spawn(
        process.execPath,
        [
          "--require",
          path.join(repositoryRoot, "test/fixtures/block-external-network.cjs"),
          path.join(repositoryRoot, "src/server/main.js"),
          "--host",
          "127.0.0.1",
          "--port",
          String(port),
        ],
        {
          cwd: workspace,
          env: serverEnvironment,
          stdio: ["ignore", "pipe", "pipe"],
        },
      ),
      "codex-web",
    );
    await waitFor(
      "Codex Web HTTP server",
      async () => {
        const response = await fetch(`http://127.0.0.1:${port}/`);
        await response.body?.cancel();
        return response.status === 200;
      },
      30_000,
    );

    loopbackProxy = await startLoopbackProxy(port);
    const browserOrigin = loopbackProxy.origin;
    let page = await launchBrowser(profileOne, diagnostics, browserOrigin);
    await page.goto(`${browserOrigin}/`, {
      waitUntil: "domcontentloaded",
    });
    await passFirstRunOnboarding(page);

    const nativeAppServer = await waitFor(
      "server-owned native Codex app-server child",
      () => nativeAppServerProcess(server.pid),
      30_000,
    );
    const serverPid = server.pid;
    const appServerPids = appServerProcesses(serverPid).map(({ pid }) => pid);
    const appServerPid = nativeAppServer.pid;
    const appServerLauncherPid = appServerPids.find(
      (pid) => pid !== appServerPid,
    );
    assert(appServerLauncherPid, "Codex app-server launcher was not found");

    const reconnect = scenarios[0];
    await submitPrompt(page, reconnect.token);
    await waitForScenarioStarted(mockReady.baseUrl, reconnect);
    await waitForPartialOutput(page, reconnect);
    const originalIpcSocket = await waitFor(
      "original IPC WebSocket handshake",
      () =>
        diagnostics.ipcWebSockets.find(
          (socket) =>
            socket.sentControlFrames.some(
              (frame) =>
                frame.type === "bridge-hello" && frame.serverEpoch === null,
            ) &&
            socket.receivedControlFrames.some(
              (frame) => frame.type === "bridge-ready",
            ),
        ),
      30_000,
    );
    const originalHello = originalIpcSocket.sentControlFrames.find(
      (frame) => frame.type === "bridge-hello",
    );
    const originalReady = originalIpcSocket.receivedControlFrames.find(
      (frame) => frame.type === "bridge-ready",
    );
    assert.equal(originalHello.connectionId, originalReady.connectionId);
    assert.equal(originalHello.serverEpoch, null);
    const reconnectPage = page;
    const reconnectBrowserContext = browserContext;
    const activeProxyIpcConnections = loopbackProxy.activeIpcConnections();
    assert.equal(
      activeProxyIpcConnections.length,
      1,
      "expected exactly one active proxied IPC connection before severing",
    );
    const originalProxyIpcConnection = activeProxyIpcConnections[0];
    loopbackProxy.severIpcConnection(originalProxyIpcConnection);
    await waitFor(
      "both sides of the original proxied IPC TCP connection to close",
      () =>
        originalProxyIpcConnection.clientClosedAt !== null &&
        originalProxyIpcConnection.upstreamClosedAt !== null,
      30_000,
    );
    await waitFor(
      "Chromium to observe the original IPC WebSocket close",
      () => originalIpcSocket.closedAt !== null,
      30_000,
    );
    const replacementIpcSocket = await waitFor(
      "replacement IPC WebSocket handshake",
      () =>
        diagnostics.ipcWebSockets.find(
          (socket) =>
            socket.sequence > originalIpcSocket.sequence &&
            socket.sentControlFrames.some(
              (frame) =>
                frame.type === "bridge-hello" &&
                frame.connectionId === originalReady.connectionId &&
                frame.serverEpoch === originalReady.serverEpoch,
            ) &&
            socket.receivedControlFrames.some(
              (frame) =>
                frame.type === "bridge-ready" &&
                frame.connectionId === originalReady.connectionId &&
                frame.serverEpoch === originalReady.serverEpoch,
            ),
        ),
      30_000,
    );
    assert.notEqual(replacementIpcSocket.sequence, originalIpcSocket.sequence);
    const replacementProxyIpcConnection = await waitFor(
      "distinct replacement proxied IPC TCP connection",
      () =>
        loopbackProxy
          .activeIpcConnections()
          .find(
            (connection) =>
              connection.sequence > originalProxyIpcConnection.sequence,
          ),
      30_000,
    );
    const sameReconnectPage = page === reconnectPage;
    const sameReconnectBrowserContext =
      browserContext === reconnectBrowserContext;
    assert(sameReconnectPage, "reconnect replaced the Browser page");
    assert(
      sameReconnectBrowserContext,
      "reconnect replaced the Browser context",
    );
    assertRuntimeIdentity(server, serverPid, appServerPids);
    await waitForScenarioCompleted(mockReady.baseUrl, reconnect);
    await assertExactlyOnce(page, reconnect.output);
    assertRuntimeIdentity(server, serverPid, appServerPids);

    const refresh = scenarios[1];
    await submitPrompt(page, refresh.token);
    await waitForScenarioStarted(mockReady.baseUrl, refresh);
    await waitForPartialOutput(page, refresh);
    const threadUrl = page.url();
    const threadId = threadIdFromBrowserUrl(threadUrl);
    const framesBeforeRefresh = diagnostics.sentFrames.length;
    await page.reload({ waitUntil: "domcontentloaded" });
    await waitForRendererReadyThread(
      () => diagnostics.sentFrames.slice(framesBeforeRefresh),
      threadId,
      "hard refresh",
    );
    await waitForOfficialThreadRehydration(
      () => diagnostics.sentFrames.slice(framesBeforeRefresh),
      "hard refresh",
    );
    await waitForScenarioCompleted(mockReady.baseUrl, refresh);
    await assertExactlyOnce(page, refresh.output);
    assert.equal(page.url().split("?")[0], threadUrl.split("?")[0]);
    assertRuntimeIdentity(server, serverPid, appServerPids);

    const reopen = scenarios[2];
    await submitPrompt(page, reopen.token);
    await waitForScenarioStarted(mockReady.baseUrl, reopen);
    await waitForPartialOutput(page, reopen);
    const resumeUrl = page.url();
    const resumeThreadId = threadIdFromBrowserUrl(resumeUrl);
    await closeBrowser();
    await waitForScenarioCompleted(mockReady.baseUrl, reopen);
    await wait(1_200);
    assertRuntimeIdentity(server, serverPid, appServerPids);

    const framesBeforeReopen = diagnostics.sentFrames.length;
    page = await launchBrowser(profileTwo, diagnostics, browserOrigin);
    await page.goto(resumeUrl, { waitUntil: "domcontentloaded" });
    await passFirstRunOnboarding(page);
    await waitForRendererReadyThread(
      () => diagnostics.sentFrames.slice(framesBeforeReopen),
      resumeThreadId,
      "browser reopen",
    );
    await waitForOfficialThreadRehydration(
      () => diagnostics.sentFrames.slice(framesBeforeReopen),
      "browser reopen",
    );
    await assertExactlyOnce(page, reopen.output);
    assertRuntimeIdentity(server, serverPid, appServerPids);

    const finalMockState = await mockState(mockReady.baseUrl);
    for (const scenario of scenarios) {
      assert.equal(
        finalMockState.scenarios[scenario.token].requestCount,
        1,
        `${scenario.name} provider request must execute exactly once`,
      );
      await assertExactlyOnce(page, scenario.output);
    }
    assert(
      diagnostics.websockets.some((url) => url.endsWith("/__backend/ipc")),
      "official renderer did not use the WebSocket IPC bridge",
    );
    assert.deepEqual(
      diagnostics.blockedBrowserRequests,
      [],
      "renderer attempted non-loopback network requests",
    );
    const blockedServerRequests = (
      await fs.readFile(externalNetworkLog, "utf8")
    )
      .trim()
      .split("\n")
      .filter(Boolean);
    assert(
      blockedServerRequests.every((requestUrl) => {
        const hostname = new URL(requestUrl).hostname;
        return (
          hostname === "ab.chatgpt.com" ||
          hostname === "chatgpt.com" ||
          hostname === "chat.openai.com"
        );
      }),
      `unexpected non-loopback server request: ${blockedServerRequests.join(", ")}`,
    );

    serverDescendantPids = descendantsOf(serverPid).map(({ pid }) => pid);
    browserDescendantPids = descendantsOf(process.pid)
      .filter(({ args }) => /chrome|chromium/i.test(args))
      .map(({ pid }) => pid);

    console.log(
      JSON.stringify(
        {
          result: "passed",
          serverPid,
          appServerLauncherPid,
          appServerPid,
          mockProviderPid: mockReady.pid,
          blockedExternalServerRequests: blockedServerRequests.length,
          reconnectEvidence: {
            originalSocketSequence: originalIpcSocket.sequence,
            originalClosed: originalIpcSocket.closedAt !== null,
            replacementSocketSequence: replacementIpcSocket.sequence,
            originalProxyConnectionSequence:
              originalProxyIpcConnection.sequence,
            originalProxyConnectionSevered:
              originalProxyIpcConnection.severedAt !== null,
            replacementProxyConnectionSequence:
              replacementProxyIpcConnection.sequence,
            samePage: sameReconnectPage,
            sameBrowserContext: sameReconnectBrowserContext,
            reusedConnectionId: true,
            reusedServerEpoch: true,
          },
          scenarioRequestCounts: Object.fromEntries(
            scenarios.map((scenario) => [
              scenario.name,
              finalMockState.scenarios[scenario.token].requestCount,
            ]),
          ),
        },
        null,
        2,
      ),
    );
  } catch (error) {
    const page = browserContext?.pages()[0];
    const bodyText = await page
      ?.locator("body")
      .innerText()
      .catch(() => "<unavailable>");
    throw new Error(
      `${error?.stack ?? error}\nRenderer body:\n${bodyText ?? "<no page>"}\nRenderer diagnostics:\n${JSON.stringify(diagnostics, null, 2)}\nServer output:\n${server ? childOutput(server) : "<not started>"}\nMock output:\n${mockProvider ? childOutput(mockProvider) : "<not started>"}`,
      { cause: error },
    );
  } finally {
    if (server?.pid && processExists(server.pid)) {
      serverDescendantPids = [
        ...new Set([
          ...serverDescendantPids,
          ...descendantsOf(server.pid).map(({ pid }) => pid),
        ]),
      ];
    }
    browserDescendantPids = [
      ...new Set([
        ...browserDescendantPids,
        ...descendantsOf(process.pid)
          .filter(({ args }) => /chrome|chromium/i.test(args))
          .map(({ pid }) => pid),
      ]),
    ];
    await closeBrowser().catch(() => undefined);
    const proxyCleanupError = await loopbackProxy?.close().then(
      () => null,
      (error) => error,
    );
    await stopChild(server);
    await stopChild(mockProvider);
    const cleanupError = await waitFor(
      "lifecycle child-process cleanup",
      () =>
        [...serverDescendantPids, ...browserDescendantPids].every(
          (pid) => !processExists(pid),
        ),
      10_000,
    ).then(
      () => null,
      (error) => error,
    );
    await fs.rm(tempRoot, { recursive: true, force: true });
    if (proxyCleanupError) {
      throw proxyCleanupError;
    }
    if (cleanupError) {
      throw cleanupError;
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
