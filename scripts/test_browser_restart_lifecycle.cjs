#!/usr/bin/env node

const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");
const { chromium } = require("playwright");

const repositoryRoot = path.resolve(__dirname, "..");
const scenario = {
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
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
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

async function mockState(baseUrl) {
  const response = await fetch(`${baseUrl}/__control/state`);
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
      const response = await fetch(`http://127.0.0.1:${port}/`);
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
  const projectRoot = path.join(workspace, "phase4-project");
  const profile = path.join(tempRoot, "chromium-profile");
  const runtime = path.join(tempRoot, "runtime");
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

  try {
    await Promise.all([
      fs.mkdir(codexHome, { recursive: true }),
      fs.mkdir(projectRoot, { recursive: true }),
      fs.mkdir(runtime, { recursive: true }),
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

    const port = await unusedLoopbackPort();
    const serverEnvironment = {
      ...commonEnvironment,
      CODEX_CLI_PATH: path.join(
        repositoryRoot,
        "test/fixtures/codex-app-server-proxy.cjs",
      ),
      CODEX_WEB_REAL_CODEX_PATH: codexExecutable,
      CODEX_UNIX_SOCKET: socketPath,
      CODEX_WEBUI_BROWSE_ROOT: workspace,
    };
    serverA = spawnWebServer(
      port,
      projectRoot,
      serverEnvironment,
      "codex-web-a",
    );
    trackedPids.add(serverA.pid);
    await waitForWebServer(port, serverA);

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
    for (const { pid } of descendantsOf(serverA.pid)) trackedPids.add(pid);

    await stopChild(serverA);
    assert.equal(
      processExists(appServer.pid),
      true,
      "external app-server did not survive server A",
    );
    await waitFor(
      "provider completion while codex-web is unavailable",
      async () => {
        const state = await mockState(providerReady.baseUrl);
        return state.scenarios[scenario.token]?.completedAt;
      },
      30_000,
    );

    serverB = spawnWebServer(
      port,
      projectRoot,
      serverEnvironment,
      "codex-web-b",
    );
    trackedPids.add(serverB.pid);
    await waitForWebServer(port, serverB);
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
    assert.equal(processExists(appServer.pid), true);
    for (const { pid } of descendantsOf(serverB.pid)) trackedPids.add(pid);
    for (const { pid } of descendantsOf(appServer.pid)) trackedPids.add(pid);

    console.log(
      JSON.stringify(
        {
          result: "passed",
          port,
          threadId,
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
          externalAppServerPid: appServer.pid,
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
    const socketResidue = await fs
      .stat(socketPath)
      .then(() => true)
      .catch(() => false);
    await fs.rm(tempRoot, { recursive: true, force: true });
    const runtimeResidue = await fs
      .stat(tempRoot)
      .then(() => true)
      .catch(() => false);
    assert.equal(
      socketResidue,
      false,
      "external app-server socket survived cleanup",
    );
    assert.equal(
      runtimeResidue,
      false,
      "restart lifecycle runtime survived cleanup",
    );
    if (cleanupError) throw cleanupError;
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
