#!/usr/bin/env node
// End-to-end: the original Codex Desktop renderer, served by the compatibility
// server in gateway mode, drives a (fixture) Windows Desktop through the
// gateway and bridge. Requires `npm run build:server && npm run build:browser`.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { chromium } = require("playwright");
const { startDesktopStack, until } = require("../test/fixtures/desktop-stack.cjs");

const repositoryRoot = path.resolve(__dirname, "..");

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

/**
 * The shell attaches the Desktop account's ChatGPT token to chatgpt.com calls.
 * The test account is a fixture, so answer the two calls that gate the UI
 * (signed-in account check and completed onboarding) from a loopback stub.
 * The shell only attaches authentication to OpenAI hosts or localhost:8000,
 * so the stub must own that port.
 */
async function startChatGptStub() {
  const requests = [];
  const server = http.createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://stub");
    requests.push(`${request.method} ${url.pathname}`);
    const json = (status, body) => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(body));
    };
    if (url.pathname === "/backend-api/wham/accounts/check")
      return json(200, {
        account_ordering: ["fixture-account"],
        accounts: [{ id: "fixture-account", plan_type: "pro", name: "Fixture" }],
      });
    if (url.pathname === "/backend-api/wham/onboarding/context")
      return json(200, { desktop_onboarding_completed_at: "2026-01-01T00:00:00Z" });
    request.resume();
    request.on("end", () => json(200, {}));
  });
  await new Promise((resolve, reject) => {
    server.once("error", (error) =>
      reject(new Error(`ChatGPT stub needs 127.0.0.1:8000: ${error.message}`)),
    );
    server.listen(8000, "127.0.0.1", resolve);
  });
  return {
    requests,
    baseUrl: "http://localhost:8000/backend-api",
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

async function main() {
  const stack = await startDesktopStack();
  const chatgpt = await startChatGptStub();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "codex-web-renderer-e2e-"));
  fs.mkdirSync(path.join(home, "workspace"), { recursive: true });
  const port = await freePort();
  const logs = [];
  const server = spawn(
    process.execPath,
    [path.join(repositoryRoot, "src/server/main.js"), "--host", "127.0.0.1", "--port", String(port)],
    {
      cwd: repositoryRoot,
      env: {
        ...process.env,
        HOME: home,
        CODEX_HOME: path.join(home, ".codex"),
        CODEX_WEBUI_BROWSE_ROOT: path.join(home, "workspace"),
        CODEX_WEB_GATEWAY_URL: stack.gatewayUrl,
        CODEX_WEB_GATEWAY_TOKEN: stack.token,
        CODEX_WEB_GATEWAY_BACKEND: "windows",
        CODEX_API_BASE_URL: chatgpt.baseUrl,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  for (const stream of [server.stdout, server.stderr])
    stream.on("data", (chunk) => {
      logs.push(String(chunk));
      if (process.env.CODEX_WEB_BROWSER_E2E_VERBOSE === "1")
        process.stderr.write(String(chunk));
    });
  let browser;
  let page;
  const errors = [];
  try {
    await until(() => logs.join("").includes("IPC bridge listening"), 30000);
    browser = await chromium.launch({
      headless: true,
      ...(process.env.CODEX_WEB_BROWSER_EXECUTABLE
        ? { executablePath: process.env.CODEX_WEB_BROWSER_EXECUTABLE }
        : {}),
      args: process.getuid?.() === 0 ? ["--no-sandbox"] : [],
    });
    const context = await browser.newContext({ viewport: { width: 1360, height: 900 } });
    page = await context.newPage();
    page.on("pageerror", (error) => errors.push(String(error)));
    const consoleLines = [];
    page.on("console", (message) => {
      if (["error", "warning"].includes(message.type()))
        consoleLines.push(`${message.type()}: ${message.text().slice(0, 600)}`);
    });
    page.consoleLines = consoleLines;
    const origin = `http://127.0.0.1:${port}`;
    await page.goto(`${origin}/`, { waitUntil: "domcontentloaded" });

    // The Desktop conversation appears in the original sidebar.
    const entry = page.getByText("Desktop conversation", { exact: false }).first();
    await entry.waitFor({ state: "visible", timeout: 30000 });
    await entry.click();
    await page.getByText("Hello from Desktop").first().waitFor({ timeout: 30000 });
    await page.getByText("Hi! This is the Desktop reply.").first().waitFor({ timeout: 30000 });

    // The image attached in Desktop is served through the gateway.
    const image = page.locator('img[src*="/@fs/"]').first();
    await image.waitFor({ state: "attached", timeout: 30000 });
    await until(
      () => image.evaluate((el) => el.complete && el.naturalWidth > 0).catch(() => false),
      30000,
    );

    // Send a prompt from the original composer; Desktop (fixture) answers.
    const composer = page.locator('[contenteditable="true"]:visible').last();
    await composer.waitFor({ timeout: 30000 });
    await composer.click();
    await composer.fill("Ping from browser");
    await composer.press("Enter");
    await until(() => stack.fixture.starts === 1, 30000);
    await page.getByText("Desktop echo: Ping from browser").first().waitFor({ timeout: 30000 });
    const start = stack.fixture.calls.find((c) => c.method === "thread-follower-start-turn");
    // The original composer keeps the trailing newline Enter inserted.
    assert.equal(start.params.turnStart.request.input[0].text.trim(), "Ping from browser");
    assert.equal(start.params.turnStart.context.inheritThreadSettings, true);

    // The mutation is owned by the gateway journal, not replayed by the page.
    const session = stack.store.findThread("windows", stack.threadId);
    assert.ok(stack.store.commands(session.id).some((c) => c.method === "turn/start" && c.state === "accepted"));

    fs.mkdirSync(path.join(repositoryRoot, "scratch/qa"), { recursive: true });
    await page.screenshot({ path: path.join(repositoryRoot, "scratch/qa/renderer-desktop.png") });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForTimeout(500);
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
    );
    assert.equal(overflow, false, "mobile viewport must not overflow horizontally");
    await page.screenshot({ path: path.join(repositoryRoot, "scratch/qa/renderer-desktop-mobile.png") });
    const fatal = errors.filter((e) => !/ResizeObserver|Statsig/.test(e));
    assert.deepEqual(fatal, [], "page errors");
    console.log("renderer-desktop browser test passed");
  } catch (error) {
    if (page) {
      fs.mkdirSync(path.join(repositoryRoot, "scratch/qa"), { recursive: true });
      await page
        .screenshot({ path: path.join(repositoryRoot, "scratch/qa/renderer-desktop-failure.png") })
        .catch(() => {});
      const text = await page.evaluate(() => document.body.innerText).catch(() => "");
      console.error("---- page text ----\n" + text.slice(0, 2000));
      console.error("---- console ----\n" + (page.consoleLines ?? []).join("\n"));
    }
    console.error("---- chatgpt stub requests ----\n" + chatgpt.requests.join("\n"));
    console.error("---- server log tail ----\n" + logs.join("").split("\n").filter((l) => !/electron-main-stub|state_changed|response_routed/.test(l)).slice(-40).join("\n"));
    throw error;
  } finally {
    await browser?.close();
    server.kill("SIGTERM");
    await new Promise((resolve) => server.once("exit", resolve));
    await stack.close();
    await chatgpt.close();
    fs.rmSync(home, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
