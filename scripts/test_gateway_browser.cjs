const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { chromium } = require("playwright");
const {
  MockRuntime,
  waitFor,
} = require("../test/fixtures/gateway-runtime.cjs");
const { SessionStore } = require("../src/server/gateway/store.js");
const { SessionService } = require("../src/server/gateway/service.js");
const { createGateway } = require("../src/server/gateway/http.js");

(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gateway-browser-"));
  const runtime = await new MockRuntime().listen();
  const token = "browser-fixture-token-not-a-real-credential";
  const config = {
    host: "127.0.0.1",
    port: 8215,
    token,
    allowedOrigins: [],
    statePath: path.join(root, "state.sqlite"),
    webRoot: path.resolve(__dirname, "../scratch/gateway-web"),
    backends: [
      {
        id: "desktop",
        label: "Development desktop",
        cwd: "/srv/projects/codex-web",
        transport: { type: "websocket", url: runtime.url },
      },
    ],
  };
  const service = new SessionService(
    new SessionStore(config.statePath),
    config.backends,
  );
  const app = await createGateway(config, service);
  let browser;
  try {
    await app.listen({ host: "127.0.0.1", port: 0 });
    service.start();
    const url = `http://127.0.0.1:${app.server.address().port}`;
    browser = await chromium.launch({
      headless: true,
      ...(process.env.CODEX_WEB_BROWSER_EXECUTABLE
        ? { executablePath: process.env.CODEX_WEB_BROWSER_EXECUTABLE }
        : {}),
      ...(process.env.CODEX_WEB_BROWSER_ARGS
        ? { args: JSON.parse(process.env.CODEX_WEB_BROWSER_ARGS) }
        : {}),
    });
    const context = await browser.newContext({
      viewport: { width: 1280, height: 850 },
    });
    context.setDefaultTimeout(10_000);
    const errors = [];
    context.on("page", (p) => p.on("pageerror", (e) => errors.push(e.message)));
    const login = async (page) => {
      await page.getByLabel("Access token").fill(token);
      await page.getByRole("button", { name: "Connect to server" }).click();
      await page
        .locator(".sidebar-footer")
        .filter({ hasText: "Connected to server" })
        .waitFor();
    };
    let page = await context.newPage();
    await page.goto(url);
    await login(page);
    await page
      .getByRole("button", { name: "New conversation" })
      .first()
      .click();
    await page
      .getByRole("textbox", { name: "Message", exact: true })
      .fill(
        "Review the remote session architecture and keep working while I close the app.",
      );
    await page.getByRole("button", { name: "Send ↑", exact: true }).click();
    await waitFor(() => runtime.starts === 1);
    const session = service.store.list()[0];
    await page.close();
    runtime.finish(session.threadId);
    await waitFor(() => service.store.get(session.id).status === "completed");

    page = await context.newPage();
    await page.goto(`${url}/#${session.id}`);
    await login(page);
    await page
      .getByText("Finished on the execution host.", { exact: true })
      .waitFor();
    assert.equal(runtime.starts, 1);
    await page.getByRole("textbox", { name: "Message", exact: true }).fill("");
    await page
      .getByRole("textbox", { name: "Message", exact: true })
      .press("Control+Enter");
    await page
      .getByRole("alert")
      .filter({ hasText: "Enter a message or attach a file" })
      .waitFor();
    assert.equal(
      await page.getByRole("button", { name: "Retry delivery" }).count(),
      0,
    );
    await context.setOffline(true);
    await page
      .getByRole("textbox", { name: "Message", exact: true })
      .fill("Continue checking the SSH implementation.");
    await page.getByRole("button", { name: "Send ↑", exact: true }).click();
    await page.getByRole("button", { name: "Retry delivery" }).waitFor();
    await context.setOffline(false);
    await page.getByRole("button", { name: "Retry delivery" }).click();
    await waitFor(() => runtime.starts === 2);
    runtime.approval(session.threadId);
    await page.getByRole("button", { name: "Allow once" }).click();
    await waitFor(() => runtime.responses.length === 1);
    runtime.finish(session.threadId);
    await waitFor(() => service.store.get(session.id).status === "completed");
    await page.getByRole("button", { name: "Send ↑", exact: true }).waitFor();
    fs.mkdirSync(path.resolve(__dirname, "../scratch/qa"), { recursive: true });
    await page.screenshot({
      path: path.resolve(__dirname, "../scratch/qa/gateway-desktop.png"),
      fullPage: true,
    });
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
      true,
    );
    await page.getByRole("button", { name: "Open navigation" }).click();
    await page
      .getByRole("button", { name: "Close navigation" })
      .first()
      .click();
    await page.waitForFunction(
      () =>
        document.querySelector(".sidebar").getBoundingClientRect().right <= 0,
    );
    await page.screenshot({
      path: path.resolve(__dirname, "../scratch/qa/gateway-mobile.png"),
      fullPage: true,
    });
    assert.deepEqual(errors, []);
    console.log(
      "PASS: desktop/mobile login, create/send, close/reopen catch-up, offline outbox retry, approval, and no duplicate turn.",
    );
  } finally {
    await browser?.close();
    await app.close();
    await runtime.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
