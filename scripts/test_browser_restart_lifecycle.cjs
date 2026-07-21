#!/usr/bin/env node

const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");
const { chromium } = require("playwright");
const {
  waitForAuthoritativeTerminalTurn,
} = require("../test/fixtures/app-server-evidence-client.cjs");
const {
  waitForAuthoritativeTerminalTurnViaCodexWeb,
} = require("../test/fixtures/codex-web-evidence-client.cjs");

const repositoryRoot = path.resolve(__dirname, "..");
const restartTopology = process.env.CODEX_WEB_RESTART_TOPOLOGY ?? "external";
assert(
  restartTopology === "external" || restartTopology === "owned",
  `unsupported restart topology: ${restartTopology}`,
);
const wholeInstanceRestart = restartTopology === "owned";
const scenario = wholeInstanceRestart
  ? {
      name: "controlled whole-instance restart continuity",
      token: "phase6-whole-instance-restart-request-4c82e1",
      output: "PHASE6_WHOLE_INSTANCE_RESTART_RESULT_61A7D4",
      delayMs: 4_000,
    }
  : {
      name: "server restart continuity",
      token: "phase4-server-restart-request-31f72c",
      output: "PHASE4_SERVER_RESTART_RESULT_B84E19",
      delayMs: 4_000,
    };
const children = new Set();
const childLogs = new Map();
let browserContext = null;

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitFor(description, predicate, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const result = await predicate();
      if (result) return result;
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
  const output = [];
  childLogs.set(child, { label, output });
  for (const stream of [child.stdout, child.stderr]) {
    stream?.on("data", (chunk) => {
      output.push(String(chunk));
      if (output.join("").length > 100_000) output.shift();
      if (process.env.CODEX_WEB_BROWSER_E2E_VERBOSE === "1") {
        process.stderr.write(`[${label}] ${chunk}`);
      }
    });
  }
  child.once("exit", () => children.delete(child));
  return child;
}

function childOutput(child) {
  return childLogs.get(child)?.output.join("") ?? "";
}

async function waitForChildMessage(child, predicate, timeoutMs = 15_000) {
  return await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.off("message", onMessage);
      reject(
        new Error(`Timed out waiting for child message\n${childOutput(child)}`),
      );
    }, timeoutMs);
    const onMessage = (message) => {
      if (!predicate(message)) return;
      clearTimeout(timeout);
      child.off("message", onMessage);
      resolve(message);
    };
    child.on("message", onMessage);
  });
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
      if (descendants.some(({ pid }) => pid === process.pid)) continue;
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
    return { forced: false };
  }
  child.kill("SIGTERM");
  const exited = await waitForChildExit(child, 3_000);
  if (!exited) {
    child.kill("SIGKILL");
    assert.equal(
      await waitForChildExit(child, 3_000),
      true,
      `child ${child.pid} did not exit after SIGKILL`,
    );
    return { forced: true };
  }
  return { forced: false };
}

async function waitForChildExit(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) return true;
  return await new Promise((resolve) => {
    const timeout = setTimeout(() => {
      child.off("exit", onExit);
      resolve(false);
    }, timeoutMs);
    const onExit = () => {
      clearTimeout(timeout);
      resolve(true);
    };
    child.once("exit", onExit);
  });
}

function ownedAppServerProcesses(parentPid) {
  const candidates = descendantsOf(parentPid).filter(
    ({ args }) =>
      /(?:^|[ /])codex(?: |$)/.test(args) &&
      /(?:^| )app-server(?: |$)/.test(args) &&
      !/(?:^| )proxy(?: |$)/.test(args),
  );
  return candidates.map((candidate) => ({
    ...candidate,
    leaf: !candidates.some(({ ppid }) => ppid === candidate.pid),
  }));
}

async function runtimeRoots(runtimeDirectory) {
  return (await fs.readdir(runtimeDirectory))
    .filter((entry) => entry.startsWith("codex-web-runtime-"))
    .sort();
}

async function pathIsSocket(socketPath) {
  return await fs
    .stat(socketPath)
    .then((stat) => stat.isSocket())
    .catch(() => false);
}

async function unixSocketIsUnavailable(socketPath) {
  return await new Promise((resolve, reject) => {
    const socket = net.createConnection({ path: socketPath });
    socket.setTimeout(1_000);
    socket.once("connect", () => {
      socket.destroy();
      resolve(false);
    });
    socket.once("error", (error) => {
      socket.destroy();
      if (["ECONNREFUSED", "ENOENT"].includes(error?.code)) {
        resolve(true);
        return;
      }
      reject(error);
    });
    socket.once("timeout", () => {
      socket.destroy();
      reject(new Error(`timed out checking Unix socket ${socketPath}`));
    });
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

async function loopbackPortIsUnavailable(port) {
  return await new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: "127.0.0.1", port });
    socket.setTimeout(1_000);
    socket.once("connect", () => {
      socket.destroy();
      resolve(false);
    });
    socket.once("error", (error) => {
      socket.destroy();
      if (error?.code === "ECONNREFUSED") {
        resolve(true);
        return;
      }
      reject(error);
    });
    socket.once("timeout", () => {
      socket.destroy();
      reject(new Error(`timed out checking codex-web port ${port}`));
    });
  });
}

async function mockState(baseUrl) {
  const response = await fetch(`${baseUrl}/__control/state`, {
    signal: AbortSignal.timeout(2_000),
  });
  assert.equal(response.status, 200);
  return await response.json();
}

async function waitForWebServer(port, expectedProcess) {
  await waitFor(
    `codex-web ${expectedProcess.pid} HTTP listener`,
    async () => {
      assert.equal(
        expectedProcess.exitCode,
        null,
        childOutput(expectedProcess),
      );
      const response = await fetch(`http://127.0.0.1:${port}/`, {
        signal: AbortSignal.timeout(2_000),
      });
      await response.body?.cancel();
      return response.status === 200;
    },
    30_000,
  );
}

function spawnWebServer(port, cwd, environment, label) {
  return captureChild(
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
      { cwd, env: environment, stdio: ["ignore", "pipe", "pipe"] },
    ),
    label,
  );
}

function boundedPush(values, value, maximum) {
  values.push(value);
  if (values.length > maximum) values.splice(0, values.length - maximum);
}

function compactControlFrame(payload) {
  try {
    const frame = JSON.parse(payload);
    if (frame.type === "bridge-hello" || frame.type === "bridge-ready") {
      return {
        type: frame.type,
        connectionId: frame.connectionId,
        serverEpoch: frame.serverEpoch,
      };
    }
    if (frame.type === "bridge-reset") {
      return { type: frame.type, reason: frame.reason };
    }
  } catch {}
  return null;
}

function compactDataFrame(payload) {
  try {
    const frame = JSON.parse(payload);
    if (frame.type !== "bridge-data") return null;
    const message = frame.message;
    const first = message?.args?.[0];
    const method = first?.request?.method ?? first?.method;
    if (
      message?.type !== "renderer-bridge-ready" &&
      !method?.startsWith("thread/") &&
      !method?.startsWith("turn/") &&
      first?.type !== "codex-app-server-connection-changed" &&
      !(first?.type === "mcp-response" && first?.message?.result?.thread)
    ) {
      return null;
    }
    return {
      directionMessageId: frame.id,
      messageType: message?.type,
      currentThreadId: message?.currentThreadId,
      recoveryReason: message?.recoveryReason,
      argumentType: first?.type,
      method,
      requestId: first?.request?.id,
      requestThreadId: first?.request?.params?.threadId,
      notificationThreadId: first?.params?.threadId,
      notificationTurnId: first?.params?.turn?.id,
      notificationTurnStatus: first?.params?.turn?.status,
      responseThreadId: first?.message?.result?.thread?.id,
      responseTurnCount: first?.message?.result?.thread?.turns?.length,
    };
  } catch {
    return null;
  }
}

function attachDiagnostics(page, diagnostics) {
  page.on("console", (message) =>
    boundedPush(
      diagnostics.console,
      `${message.type()}: ${message.text()}`,
      200,
    ),
  );
  page.on("pageerror", (error) =>
    boundedPush(diagnostics.pageErrors, String(error), 200),
  );
  page.on("framenavigated", (frame) => {
    if (frame === page.mainFrame()) diagnostics.mainFrameNavigations += 1;
  });
  page.on("websocket", (websocket) => {
    if (!websocket.url().endsWith("/__backend/ipc")) return;
    const record = {
      sequence: diagnostics.sockets.length + 1,
      closedAt: null,
      sent: [],
      received: [],
    };
    diagnostics.sockets.push(record);
    websocket.on("close", () => {
      record.closedAt = Date.now();
    });
    websocket.on("framesent", ({ payload }) => {
      const text = String(payload);
      const control = compactControlFrame(text);
      if (control) record.sent.push(control);
      const data = compactDataFrame(text);
      if (data) diagnostics.sentData.push(data);
    });
    websocket.on("framereceived", ({ payload }) => {
      const text = String(payload);
      const control = compactControlFrame(text);
      if (control) record.received.push(control);
      const data = compactDataFrame(text);
      if (data) diagnostics.receivedData.push(data);
    });
  });
}

async function launchBrowser(profileDirectory, origin, diagnostics) {
  browserContext = await chromium.launchPersistentContext(profileDirectory, {
    headless: false,
    args: process.getuid?.() === 0 ? ["--no-sandbox"] : [],
    viewport: { width: 1440, height: 1000 },
  });
  await browserContext.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (
      url.origin === origin ||
      url.protocol === "data:" ||
      url.protocol === "blob:"
    ) {
      await route.continue();
      return;
    }
    diagnostics.blockedBrowserRequests.push(url.toString());
    await route.abort("blockedbyclient");
  });
  const page = browserContext.pages()[0] ?? (await browserContext.newPage());
  attachDiagnostics(page, diagnostics);
  return page;
}

async function closeBrowser() {
  if (!browserContext) return;
  const context = browserContext;
  browserContext = null;
  await context.close();
}

async function waitForComposer(page) {
  const composer = page.locator('[contenteditable="true"]:visible').last();
  await composer.waitFor({ state: "visible", timeout: 60_000 });
  return composer;
}

async function passFirstRunOnboarding(page) {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const engineering = page.getByRole("button", {
      exact: true,
      name: "Engineering",
    });
    if (await engineering.isVisible().catch(() => false)) {
      await engineering.click();
      await page.getByRole("button", { exact: true, name: "Continue" }).click();
      await wait(100);
      continue;
    }
    for (const name of ["Skip", "Continue with current model"]) {
      const button = page.getByRole("button", { exact: true, name });
      if (await button.isVisible().catch(() => false)) {
        await button.click();
        await wait(100);
      }
    }
    const composer = page.locator('[contenteditable="true"]:visible').last();
    if (await composer.isVisible().catch(() => false)) return composer;
    await wait(100);
  }
  return await waitForComposer(page);
}

async function selectWorkspaceProject(page, browseRoot, projectRoot) {
  const projectSelector = page.locator(
    '[data-composer-navigation-target="workspace-project"]',
  );
  await projectSelector.waitFor({ state: "visible", timeout: 30_000 });
  await projectSelector.click();
  const newProjectItem = page.getByRole("menuitem", {
    exact: true,
    name: "New project",
  });
  await newProjectItem.hover();
  await page
    .getByRole("menuitem", { exact: true, name: "Use an existing folder" })
    .click();

  const dialog = page.getByRole("dialog", { name: "Add remote project" });
  await dialog.waitFor({ state: "visible", timeout: 30_000 });
  const selectedPath = dialog.getByLabel("Selected folder path");
  await waitFor(
    "restart workspace picker browse root",
    async () => (await selectedPath.inputValue()) === browseRoot,
  );
  await dialog
    .locator(`button[data-path=${JSON.stringify(projectRoot)}]`)
    .click();
  await dialog
    .getByRole("button", { exact: true, name: "Add project" })
    .click();
  await dialog.waitFor({ state: "detached", timeout: 30_000 });
  await waitForComposer(page);
}

async function submitPrompt(page, prompt) {
  const composer = await waitForComposer(page);
  await composer.click();
  await composer.fill(prompt);
  await composer.press("Enter");
}

function threadIdFromUrl(url) {
  const match = new URL(url).pathname.match(/^\/thread\/([^/]+)$/);
  assert(match, `expected canonical thread route, got ${url}`);
  return decodeURIComponent(match[1]);
}

function rendererReadyMessages(diagnostics) {
  return diagnostics.sentData.filter(
    ({ messageType }) => messageType === "renderer-bridge-ready",
  );
}

async function main() {
  const tempRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "codex-web-browser-restart-"),
  );
  const isolatedHome = path.join(tempRoot, "home");
  const codexHome = path.join(isolatedHome, ".codex");
  const workspace = path.join(tempRoot, "workspace");
  const projectRoot = path.join(
    workspace,
    wholeInstanceRestart ? "phase6-project" : "phase4-project",
  );
  const profile = path.join(tempRoot, "chromium-profile");
  const runtime = path.join(tempRoot, "runtime");
  const ownedRuntimeA = path.join(tempRoot, "runtime-a");
  const ownedRuntimeB = path.join(tempRoot, "runtime-b");
  const socketPath = path.join(runtime, "codex-app-server.sock");
  const externalNetworkLog = path.join(tempRoot, "external-network.log");
  const diagnostics = {
    blockedBrowserRequests: [],
    console: [],
    mainFrameNavigations: 0,
    pageErrors: [],
    receivedData: [],
    sentData: [],
    sockets: [],
  };
  const trackedPids = new Set();
  let provider = null;
  let appServer = null;
  let serverA = null;
  let serverB = null;
  let page = null;
  let port = null;
  let appServerAPid = null;
  let appServerBPid = null;
  let runtimeRootA = null;
  let runtimeRootB = null;
  let serverAStoppedAt = null;
  let serverBStartedAt = null;

  try {
    await Promise.all([
      fs.mkdir(codexHome, { recursive: true }),
      fs.mkdir(projectRoot, { recursive: true }),
      fs.mkdir(runtime, { recursive: true }),
      fs.mkdir(ownedRuntimeA, { recursive: true }),
      fs.mkdir(ownedRuntimeB, { recursive: true }),
      fs.mkdir(path.join(tempRoot, "tmp"), { recursive: true }),
      fs.mkdir(path.join(tempRoot, "xdg-cache"), { recursive: true }),
      fs.mkdir(path.join(tempRoot, "xdg-config"), { recursive: true }),
      fs.mkdir(path.join(tempRoot, "xdg-data"), { recursive: true }),
      fs.mkdir(path.join(tempRoot, "xdg-state"), { recursive: true }),
      fs.writeFile(externalNetworkLog, "", { mode: 0o600 }),
    ]);

    provider = captureChild(
      spawn(process.execPath, ["test/fixtures/mock-responses-provider.cjs"], {
        cwd: repositoryRoot,
        env: {
          PATH: process.env.PATH,
          CODEX_WEB_MOCK_SCENARIOS: JSON.stringify([scenario]),
        },
        stdio: ["ignore", "pipe", "pipe", "ipc"],
      }),
      "mock-provider",
    );
    trackedPids.add(provider.pid);
    const providerReady = await waitForChildMessage(
      provider,
      (message) => message?.type === "ready",
    );

    const config = [
      'model = "mock-model"',
      'model_provider = "codex_web_restart_mock"',
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
      "[model_providers.codex_web_restart_mock]",
      'name = "Codex Web restart deterministic mock"',
      `base_url = "${providerReady.baseUrl}/v1"`,
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
    await fs.mkdir(path.join(codexHome, "vendor_imports"), { recursive: true });
    await fs.writeFile(
      path.join(codexHome, "vendor_imports", "skills-curated-cache.json"),
      JSON.stringify({ fetchedAt: Date.now(), skills: [] }),
      { mode: 0o600 },
    );

    const codexExecutable = findExecutable("codex");
    const codexVersion = spawnSync(codexExecutable, ["--version"], {
      encoding: "utf8",
    });
    assert.equal(codexVersion.status, 0, codexVersion.stderr);
    if (wholeInstanceRestart) {
      assert.equal(
        codexVersion.stdout.trim(),
        "codex-cli 0.144.6",
        "whole-instance restart witness requires exact Codex 0.144.6",
      );
    }
    const commonEnvironment = {
      PATH: process.env.PATH,
      LANG: process.env.LANG ?? "C.UTF-8",
      LC_ALL: process.env.LC_ALL ?? "C.UTF-8",
      SHELL: "/bin/sh",
      HOME: isolatedHome,
      CODEX_HOME: codexHome,
      TMPDIR: path.join(tempRoot, "tmp"),
      XDG_CACHE_HOME: path.join(tempRoot, "xdg-cache"),
      XDG_CONFIG_HOME: path.join(tempRoot, "xdg-config"),
      XDG_DATA_HOME: path.join(tempRoot, "xdg-data"),
      XDG_STATE_HOME: path.join(tempRoot, "xdg-state"),
      NO_PROXY: "127.0.0.1,localhost",
      no_proxy: "127.0.0.1,localhost",
      ALL_PROXY: "http://127.0.0.1:9",
      HTTP_PROXY: "http://127.0.0.1:9",
      HTTPS_PROXY: "http://127.0.0.1:9",
      all_proxy: "http://127.0.0.1:9",
      http_proxy: "http://127.0.0.1:9",
      https_proxy: "http://127.0.0.1:9",
      CODEX_WEB_E2E_NETWORK_LOG: externalNetworkLog,
    };
    assert.deepEqual(await runtimeRoots(runtime), []);
    if (!wholeInstanceRestart) {
      appServer = captureChild(
        spawn(
          codexExecutable,
          ["app-server", "--listen", `unix://${socketPath}`],
          {
            cwd: projectRoot,
            env: commonEnvironment,
            stdio: ["ignore", "pipe", "pipe"],
          },
        ),
        "external-app-server",
      );
      trackedPids.add(appServer.pid);
      await waitFor(
        "external app-server Unix socket",
        async () => {
          assert.equal(appServer.exitCode, null, childOutput(appServer));
          return await fs
            .stat(socketPath)
            .then((stat) => stat.isSocket())
            .catch(() => false);
        },
        30_000,
      );
    }

    port = await unusedLoopbackPort();
    const serverEnvironment = {
      ...commonEnvironment,
      CODEX_CLI_PATH: wholeInstanceRestart
        ? codexExecutable
        : path.join(repositoryRoot, "test/fixtures/codex-app-server-proxy.cjs"),
      CODEX_WEB_REAL_CODEX_PATH: codexExecutable,
      CODEX_WEBUI_BROWSE_ROOT: workspace,
      ...(wholeInstanceRestart ? {} : { CODEX_UNIX_SOCKET: socketPath }),
    };
    const serverAEnvironment = wholeInstanceRestart
      ? { ...serverEnvironment, TMPDIR: ownedRuntimeA }
      : serverEnvironment;
    const serverBEnvironment = wholeInstanceRestart
      ? { ...serverEnvironment, TMPDIR: ownedRuntimeB }
      : serverEnvironment;
    serverA = spawnWebServer(
      port,
      projectRoot,
      serverAEnvironment,
      "codex-web-a",
    );
    trackedPids.add(serverA.pid);
    await waitForWebServer(port, serverA);

    if (wholeInstanceRestart) {
      const serverAAppServers = await waitFor(
        "server A default owned app-server",
        () => {
          assert.equal(serverA.exitCode, null, childOutput(serverA));
          const candidates = ownedAppServerProcesses(serverA.pid);
          return candidates.some(({ leaf }) => leaf) ? candidates : null;
        },
        30_000,
      );
      for (const { pid } of descendantsOf(serverA.pid)) trackedPids.add(pid);
      const leaf = serverAAppServers.find((candidate) => candidate.leaf);
      assert(leaf, "server A app-server process tree had no leaf process");
      appServerAPid = leaf.pid;
      runtimeRootA = await waitFor(
        "server A isolated runtime socket",
        async () => {
          for (const entry of await runtimeRoots(ownedRuntimeA)) {
            const runtimeRoot = path.join(ownedRuntimeA, entry);
            if (
              await pathIsSocket(path.join(runtimeRoot, "codex-ipc/ipc.sock"))
            ) {
              return runtimeRoot;
            }
          }
          return false;
        },
        30_000,
      );
    }

    const origin = `http://127.0.0.1:${port}`;
    page = await launchBrowser(profile, origin, diagnostics);
    const originalPage = page;
    await page.goto(origin, { waitUntil: "domcontentloaded" });
    await passFirstRunOnboarding(page);
    await selectWorkspaceProject(page, workspace, projectRoot);
    await submitPrompt(page, scenario.token);
    await waitFor(
      "app-server acceptance and provider first chunk",
      async () => {
        const state = await mockState(providerReady.baseUrl);
        return (
          state.scenarios[scenario.token]?.requestCount === 1 &&
          state.scenarios[scenario.token]?.firstChunkSentAt
        );
      },
      30_000,
    );
    await waitFor(
      "partial assistant output",
      async () =>
        (await page.locator("body").innerText()).includes(
          scenario.output.slice(0, Math.floor(scenario.output.length / 2)),
        ),
      30_000,
    );

    const canonicalUrl = page.url();
    const threadId = threadIdFromUrl(canonicalUrl);
    const targetTurnStarted = await waitFor(
      "authoritative server A turn/started notification",
      () =>
        diagnostics.receivedData.find(
          ({
            argumentType,
            method,
            notificationThreadId,
            notificationTurnId,
          }) =>
            argumentType === "mcp-notification" &&
            method === "turn/started" &&
            notificationThreadId === threadId &&
            typeof notificationTurnId === "string" &&
            notificationTurnId.length > 0,
        ),
      30_000,
    );
    const turnId = targetTurnStarted.notificationTurnId;
    const oldReady = await waitFor(
      "server A bridge epoch",
      () =>
        diagnostics.sockets
          .flatMap(({ received }) => received)
          .find(({ type }) => type === "bridge-ready"),
      30_000,
    );
    const navigationsBeforeRestart = diagnostics.mainFrameNavigations;
    const readyCountBeforeRestart = rendererReadyMessages(diagnostics).length;
    let authoritativeTerminalEvidence;

    if (wholeInstanceRestart) {
      await waitFor(
        "provider completion before controlled whole-instance shutdown",
        async () => {
          const state = await mockState(providerReady.baseUrl);
          return state.scenarios[scenario.token]?.completedAt;
        },
        30_000,
      );
      await waitFor(
        "complete assistant result before controlled whole-instance shutdown",
        async () =>
          (await page.locator("body").innerText()).includes(scenario.output),
        30_000,
      );
      assert.equal(serverB, null, "server B started before terminal evidence");
      authoritativeTerminalEvidence =
        await waitForAuthoritativeTerminalTurnViaCodexWeb({
          baseUrl: origin,
          threadId,
          turnId,
        });
      assert.equal(
        authoritativeTerminalEvidence.serverEpoch,
        oldReady.serverEpoch,
        "terminal evidence did not come from server A",
      );
      assert.equal(
        authoritativeTerminalEvidence.status,
        "completed",
        "controlled restart requires the exact successful turn to be terminal",
      );

      const serverADescendantPids = descendantsOf(serverA.pid).map(
        ({ pid }) => pid,
      );
      for (const pid of serverADescendantPids) trackedPids.add(pid);
      assert(
        serverADescendantPids.includes(appServerAPid),
        "server A no longer owned its recorded app-server before shutdown",
      );
      const stopResult = await stopChild(serverA);
      assert.equal(stopResult.forced, false, "server A required SIGKILL");
      assert.equal(serverA.exitCode, 0, childOutput(serverA));
      await waitFor(
        "server A owned process tree to exit",
        () => serverADescendantPids.every((pid) => !processExists(pid)),
        10_000,
      );
      await waitFor(
        "server A web port to become unavailable",
        () => loopbackPortIsUnavailable(port),
        10_000,
      );
      assert.equal(
        await fs
          .stat(runtimeRootA)
          .then(() => true)
          .catch(() => false),
        false,
        "server A run-owned app-server runtime survived cleanup",
      );
      assert.equal(
        await pathIsSocket(path.join(runtimeRootA, "codex-ipc/ipc.sock")),
        false,
      );
      assert.equal(serverB, null, "server B overlapped server A teardown");
      assert.equal(processExists(appServerAPid), false);
      serverAStoppedAt = Date.now();
    } else {
      for (const { pid } of descendantsOf(serverA.pid)) trackedPids.add(pid);
      await stopChild(serverA);
      assert.equal(
        processExists(appServer.pid),
        true,
        "external app-server did not survive server A",
      );
      await waitFor(
        "codex-web port to be unavailable before authoritative evidence",
        () => loopbackPortIsUnavailable(port),
        10_000,
      );
      await waitFor(
        "provider completion while codex-web is unavailable",
        async () => {
          const state = await mockState(providerReady.baseUrl);
          return state.scenarios[scenario.token]?.completedAt;
        },
        30_000,
      );
      assert.equal(serverB, null, "server B started before terminal evidence");
      assert.equal(
        await loopbackPortIsUnavailable(port),
        true,
        "codex-web port became available before terminal evidence",
      );
      authoritativeTerminalEvidence = await waitForAuthoritativeTerminalTurn({
        socketPath,
        threadId,
        turnId,
      });
      serverAStoppedAt = Date.now();
    }
    assert(
      ["completed", "interrupted", "failed"].includes(
        authoritativeTerminalEvidence.status,
      ),
      `target turn was not terminal: ${JSON.stringify(authoritativeTerminalEvidence)}`,
    );
    assert.equal(serverB, null, "server B started during terminal evidence");
    assert.equal(
      await loopbackPortIsUnavailable(port),
      true,
      "codex-web port became available during terminal evidence",
    );

    serverBStartedAt = Date.now();
    assert(serverAStoppedAt <= serverBStartedAt);
    serverB = spawnWebServer(
      port,
      projectRoot,
      serverBEnvironment,
      "codex-web-b",
    );
    trackedPids.add(serverB.pid);
    await waitForWebServer(port, serverB);
    if (wholeInstanceRestart) {
      const serverBAppServers = await waitFor(
        "server B fresh default owned app-server",
        () => {
          assert.equal(serverB.exitCode, null, childOutput(serverB));
          const candidates = ownedAppServerProcesses(serverB.pid);
          return candidates.some(({ leaf }) => leaf) ? candidates : null;
        },
        30_000,
      );
      for (const { pid } of descendantsOf(serverB.pid)) trackedPids.add(pid);
      const leaf = serverBAppServers.find((candidate) => candidate.leaf);
      assert(leaf, "server B app-server process tree had no leaf process");
      appServerBPid = leaf.pid;
      assert.notEqual(appServerBPid, appServerAPid);
      runtimeRootB = await waitFor(
        "server B fresh isolated runtime socket",
        async () => {
          for (const entry of await runtimeRoots(ownedRuntimeB)) {
            const runtimeRoot = path.join(ownedRuntimeB, entry);
            if (
              await pathIsSocket(path.join(runtimeRoot, "codex-ipc/ipc.sock"))
            ) {
              return runtimeRoot;
            }
          }
          return false;
        },
        30_000,
      );
      assert.notEqual(runtimeRootB, runtimeRootA);
      assert.equal(processExists(appServerAPid), false);
      assert.equal(processExists(appServerBPid), true);
    }
    const newReady = await waitFor(
      "server B bridge epoch",
      () =>
        diagnostics.sockets
          .flatMap(({ received }) => received)
          .filter(({ type }) => type === "bridge-ready")
          .find(({ serverEpoch }) => serverEpoch !== oldReady.serverEpoch),
      45_000,
    );
    assert.notEqual(oldReady.serverEpoch, newReady.serverEpoch);
    assert.equal(
      page,
      originalPage,
      "backend restart replaced the Browser tab",
    );
    await waitFor(
      "same-tab backend restart reload",
      () => diagnostics.mainFrameNavigations > navigationsBeforeRestart,
      30_000,
    );
    assert.equal(page.url().split("?")[0], canonicalUrl.split("?")[0]);

    const restartReady = await waitFor(
      "restart-tagged renderer readiness",
      () =>
        rendererReadyMessages(diagnostics)
          .slice(readyCountBeforeRestart)
          .find(
            (message) =>
              message.currentThreadId === threadId &&
              message.recoveryReason === "backend-restarted",
          ),
      30_000,
    );
    assert(restartReady);
    await waitFor(
      "official history hydration after restart",
      () =>
        diagnostics.sentData
          .slice(diagnostics.sentData.indexOf(restartReady))
          .some(
            ({ method, requestThreadId }) =>
              (method === "thread/read" || method === "thread/resume") &&
              requestThreadId === threadId,
          ),
      30_000,
    );
    await waitFor(
      "final result hydrated from app-server history",
      async () =>
        (await page.locator("body").innerText()).includes(scenario.output),
      60_000,
    );
    let bodyText = await page.locator("body").innerText();
    assert.equal(bodyText.split(scenario.output).length - 1, 1);

    const readyCountBeforeOrdinaryReload =
      rendererReadyMessages(diagnostics).length;
    await page.reload({ waitUntil: "domcontentloaded" });
    const ordinaryReady = await waitFor(
      "ordinary renderer readiness after marker consumption",
      () =>
        rendererReadyMessages(diagnostics)
          .slice(readyCountBeforeOrdinaryReload)
          .find(({ currentThreadId }) => currentThreadId === threadId),
      30_000,
    );
    assert.equal(ordinaryReady.recoveryReason, null);
    assert.equal(page.url().split("?")[0], canonicalUrl.split("?")[0]);
    await waitFor(
      "final result after ordinary reload",
      async () =>
        (await page.locator("body").innerText()).includes(scenario.output),
      30_000,
    );
    bodyText = await page.locator("body").innerText();
    assert.equal(bodyText.split(scenario.output).length - 1, 1);

    const finalProviderState = await mockState(providerReady.baseUrl);
    assert.equal(finalProviderState.scenarios[scenario.token].requestCount, 1);
    assert.equal(
      diagnostics.sentData.filter(
        ({ argumentType, method }) =>
          argumentType === "mcp-request" && method === "turn/start",
      ).length,
      1,
      "the original turn/start invoke was replayed",
    );
    assert.equal(diagnostics.blockedBrowserRequests.length, 0);
    assert.equal(
      diagnostics.pageErrors.length,
      0,
      diagnostics.pageErrors.join("\n"),
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
    if (wholeInstanceRestart) {
      assert.equal(processExists(appServerBPid), true);
      assert.equal(
        await pathIsSocket(path.join(runtimeRootB, "codex-ipc/ipc.sock")),
        true,
      );
    } else {
      assert.equal(processExists(appServer.pid), true);
      for (const { pid } of descendantsOf(appServer.pid)) trackedPids.add(pid);
    }
    for (const { pid } of descendantsOf(serverB.pid)) trackedPids.add(pid);

    console.log(
      JSON.stringify(
        {
          result: "passed",
          topology: restartTopology,
          codexVersion: codexVersion.stdout.trim(),
          port,
          threadId,
          turnId,
          authoritativeTerminalEvidence,
          oldServerEpoch: oldReady.serverEpoch,
          newServerEpoch: newReady.serverEpoch,
          sameTab: page === originalPage,
          routePreserved:
            page.url().split("?")[0] === canonicalUrl.split("?")[0],
          restartMarker: restartReady.recoveryReason,
          markerAfterOrdinaryReload: ordinaryReady.recoveryReason,
          providerRequestCount:
            finalProviderState.scenarios[scenario.token].requestCount,
          turnStartInvokeCount: diagnostics.sentData.filter(
            ({ argumentType, method }) =>
              argumentType === "mcp-request" && method === "turn/start",
          ).length,
          navigationCount: diagnostics.mainFrameNavigations,
          blockedExternalServerRequests: blockedServerRequests.length,
          serverAStoppedAt,
          serverBStartedAt,
          nonOverlappingReplacement: serverAStoppedAt <= serverBStartedAt,
          externalAppServerPid: appServer?.pid ?? null,
          appServerAPid,
          appServerBPid,
          runtimeRootA,
          runtimeRootB,
          serverAPid: serverA.pid,
          serverBPid: serverB.pid,
        },
        null,
        2,
      ),
    );
  } catch (error) {
    const body = await page
      ?.locator("body")
      .innerText()
      .catch(() => "<unavailable>");
    throw new Error(
      `${error?.stack ?? error}\nRenderer body:\n${body ?? "<no page>"}\nDiagnostics:\n${JSON.stringify(diagnostics, null, 2)}\nServer A:\n${serverA ? childOutput(serverA) : "<not started>"}\nServer B:\n${serverB ? childOutput(serverB) : "<not started>"}\nApp-server:\n${appServer ? childOutput(appServer) : "<not started>"}\nProvider:\n${provider ? childOutput(provider) : "<not started>"}`,
      { cause: error },
    );
  } finally {
    for (const child of [serverA, serverB, appServer, provider]) {
      if (child?.pid && processExists(child.pid)) {
        trackedPids.add(child.pid);
        for (const { pid } of descendantsOf(child.pid)) trackedPids.add(pid);
      }
    }
    if (browserContext) {
      for (const { pid, args } of descendantsOf(process.pid)) {
        if (/chrome|chromium/i.test(args)) trackedPids.add(pid);
      }
    }
    await closeBrowser().catch(() => undefined);
    await stopChild(serverA);
    await stopChild(serverB);
    await stopChild(appServer);
    await stopChild(provider);
    const cleanupError = await waitFor(
      "Browser/server/proxy/app-server/provider cleanup",
      () => [...trackedPids].every((pid) => !processExists(pid)),
      10_000,
    ).then(
      () => null,
      (error) => error,
    );
    let teardownVerificationError = cleanupError;
    try {
      const listenerResidue = port
        ? !(await loopbackPortIsUnavailable(port).catch(() => false))
        : false;
      if (!wholeInstanceRestart) {
        assert.equal(
          await unixSocketIsUnavailable(socketPath),
          true,
          "external app-server listener survived cleanup",
        );
        // Codex leaves its Unix socket pathname behind. This harness created
        // the exact enclosing fixture root, so it may remove that stale path
        // after proving the external process and listener are gone.
        await fs.rm(socketPath, { force: true });
      }
      const socketResidue = await fs
        .stat(socketPath)
        .then(() => true)
        .catch(() => false);
      const ownedRuntimeSocketResidue = wholeInstanceRestart
        ? await Promise.all(
            [runtimeRootA, runtimeRootB]
              .filter(Boolean)
              .map((root) =>
                pathIsSocket(path.join(root, "codex-ipc/ipc.sock")),
              ),
          )
        : [];
      const ownedRuntimeRootResidue = wholeInstanceRestart
        ? await Promise.all(
            [runtimeRootA, runtimeRootB].filter(Boolean).map((root) =>
              fs
                .stat(root)
                .then(() => true)
                .catch(() => false),
            ),
          )
        : [];
      assert.equal(
        socketResidue,
        false,
        "external app-server socket survived cleanup",
      );
      assert.equal(
        ownedRuntimeSocketResidue.some(Boolean),
        false,
        "owned instance runtime socket survived cleanup",
      );
      assert.equal(
        ownedRuntimeRootResidue.some(Boolean),
        false,
        "owned instance runtime root survived cleanup",
      );
      assert.equal(
        listenerResidue,
        false,
        "codex-web listener survived cleanup",
      );
    } catch (error) {
      teardownVerificationError = teardownVerificationError
        ? new AggregateError(
            [teardownVerificationError, error],
            "restart lifecycle teardown checks failed",
          )
        : error;
    }

    let fixtureRemovalError = null;
    try {
      await fs.rm(tempRoot, { recursive: true, force: true });
    } catch (error) {
      fixtureRemovalError = error;
    }
    const runtimeResidue = await fs
      .stat(tempRoot)
      .then(() => true)
      .catch(() => false);
    if (runtimeResidue && !fixtureRemovalError) {
      fixtureRemovalError = new Error(
        "restart lifecycle runtime survived cleanup",
      );
    }
    if (teardownVerificationError && fixtureRemovalError) {
      throw new AggregateError(
        [teardownVerificationError, fixtureRemovalError],
        "restart lifecycle verification and fixture removal failed",
      );
    }
    if (teardownVerificationError) throw teardownVerificationError;
    if (fixtureRemovalError) throw fixtureRemovalError;
  }
}

main().then(
  () => process.exit(0),
  (error) => {
    console.error(error);
    process.exit(1);
  },
);
