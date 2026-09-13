// Full frontend -> gateway -> WSS bridge -> persistent native adapter fixture.
// The installed Desktop is neither loaded nor modified by this test.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { EventEmitter } = require("node:events");
const { chromium } = require("playwright");
const {
  nativeAdapterFixture,
  PNG,
} = require("../test/fixtures/native-adapter.cjs");
const { desktopTlsProxy } = require("../test/fixtures/desktop-tls.cjs");
const { SessionStore } = require("../src/server/gateway/store.js");
const { SessionService } = require("../src/server/gateway/service.js");
const { createGateway } = require("../src/server/gateway/http.js");
const { NativeAdapterClient } = require("./desktop/native-client.cjs");
const { NativeIntegration } = require("./desktop/native-integration.cjs");
const { DesktopSession } = require("./desktop/session.cjs");
const {
  DesktopBridge,
  CommandJournal,
  gatewayUrl,
} = require("./codex_web_desktop_bridge.cjs");
async function until(fn) {
  const end = Date.now() + 10000;
  while (!fn()) {
    if (Date.now() > end) throw new Error("Browser native fixture timed out");
    await new Promise((r) => setTimeout(r, 20));
  }
}
async function main() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "native-browser-"));
  const native = await nativeAdapterFixture(directory),
    ipc = new EventEmitter();
  ipc.clientId = "existing-desktop";
  ipc.connect = async () => {};
  ipc.close = () => {};
  const nativeTools = {
    originThreadId: "native-context",
    async call(method) {
      if (method === "list_threads")
        return {
          threads: [
            { id: "native-chat", kind: "chatgpt", title: "Photo conversation" },
          ],
        };
      if (method === "read_thread")
        return {
          thread: {
            id: "native-chat",
            kind: "chatgpt",
            title: "Photo conversation",
            status: { type: "idle" },
          },
          turns: [],
        };
      throw new Error("Photo submission incorrectly used a text-only handler");
    },
  };
  const session = new DesktopSession(ipc, {
    codexHome: directory,
    uploadRoot: path.join(directory, "staged"),
    nativeTools,
  });
  const journal = new CommandJournal(path.join(directory, "bridge.sqlite")),
    nativeClient = new NativeAdapterClient(native.config, "native-context", {
      retryMs: 100,
    });
  const nativeIntegration = new NativeIntegration({
    client: nativeClient,
    session,
    journal,
  });
  const backend = {
    id: "windows",
    label: "Windows Desktop",
    cwd: "C:\\project",
    transport: { type: "desktop", agentTokenEnv: "NATIVE_BROWSER_AGENT_TOKEN" },
  };
  process.env.NATIVE_BROWSER_AGENT_TOKEN = randomUUID() + randomUUID();
  const service = new SessionService(new SessionStore(":memory:"), [backend]);
  const token = randomUUID(),
    app = await createGateway(
      {
        host: "127.0.0.1",
        port: 8215,
        token,
        statePath: ":memory:",
        allowedOrigins: [],
        backends: [backend],
        webRoot: path.resolve(__dirname, "../scratch/gateway-web"),
      },
      service,
    );
  let bridge, proxy, browser;
  try {
    await app.listen({ host: "127.0.0.1", port: 0 });
    proxy = await desktopTlsProxy(app.server.address().port);
    bridge = new DesktopBridge({
      session,
      journal,
      nativeIntegration,
      info: { version: "26.908.40834" },
      backendId: backend.id,
      token: process.env.NATIVE_BROWSER_AGENT_TOKEN,
      url: gatewayUrl(proxy.url),
      tlsCa: proxy.ca,
    });
    bridge.start();
    await until(() => service.summaries()[0].capabilities.chatgptAttachments);
    browser = await chromium.launch({
      headless: true,
      ...(process.env.CODEX_WEB_BROWSER_EXECUTABLE
        ? { executablePath: process.env.CODEX_WEB_BROWSER_EXECUTABLE }
        : {}),
    });
    const context = await browser.newContext({
        viewport: { width: 390, height: 844 },
      }),
      errors = [];
    context.on("page", (page) =>
      page.on("pageerror", (error) => errors.push(error.message)),
    );
    const origin = `http://127.0.0.1:${app.server.address().port}`;
    const login = async (page) => {
      await page.getByLabel("Access token").fill(token);
      await page.getByRole("button", { name: "Connect to server" }).click();
    };
    let page = await context.newPage();
    await page.goto(origin);
    await login(page);
    await page
      .getByRole("button", { name: "Open Desktop conversation" })
      .last()
      .click();
    await page
      .getByRole("button", { name: "ChatGPT · Photo conversation" })
      .click();
    await page.getByRole("textbox", { name: "Message", exact: true }).waitFor();
    const sessionId = service.store.list()[0].id;
    native.holdUpload = true;
    await page
      .locator('input[type="file"]')
      .setInputFiles({
        name: "photo.png",
        mimeType: "image/png",
        buffer: Buffer.from(PNG, "base64"),
      });
    await until(() => !!native.releaseUpload);
    await page.close();
    native.releaseUpload();
    await until(
      () =>
        nativeIntegration.publicUploads("native-chat")[0]?.state === "ready",
    );
    page = await context.newPage();
    await page.goto(`${origin}/#${sessionId}`);
    await login(page);
    await page.getByRole("button", { name: "Remove photo.png" }).waitFor();
    await page
      .getByRole("textbox", { name: "Message", exact: true })
      .fill("Inspect this photo");
    await page.getByRole("button", { name: "Send ↑", exact: true }).click();
    await until(() => native.submissions.length === 1);
    const message = native.submissions[0].prepared.bundle.message;
    assert.equal(
      message.content.parts[0].asset_pointer,
      "sediment://file_native_1",
    );
    assert.equal(message.metadata.attachments[0].id, "file_native_1");
    assert.equal(native.uploads, 1);
    await page.getByRole("button", { name: "Observe Computer Use" }).click();
    await page
      .getByRole("region", { name: "Computer Use", exact: true })
      .waitFor();
    const approval = native.offerApproval({
      message: "Allow this existing Computer Use session?",
      meta: { method: "get_window_state" },
    });
    await page.getByRole("button", { name: "Allow once", exact: true }).click();
    await approval;
    assert.equal(native.nativeResponses[0].id, native.originalApprovals[0].id);
    assert.equal(native.helperCloses, 0);
    native.capture();
    await page
      .getByRole("img", { name: "Latest screenshot from Desktop Computer Use" })
      .waitFor();
    assert.equal(
      await page
        .getByRole("img", {
          name: "Latest screenshot from Desktop Computer Use",
        })
        .evaluate((img) => img.naturalWidth),
      1,
    );
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
      true,
    );
    const qa = path.resolve(__dirname, "../scratch/qa");
    fs.mkdirSync(qa, { recursive: true });
    await page.screenshot({
      path: path.join(qa, "native-integration-mobile.png"),
      fullPage: true,
    });
    await page
      .getByRole("button", { name: "Stop Computer Use", exact: true })
      .click();
    await until(() => native.helperCloses === 1);
    assert.deepEqual(errors, []);
    console.log(
      "PASS (fixture): mobile photo upload, viewer reconnect, native attachment references, existing-owner approvals/capture/stop; no duplicate native upload or message.",
    );
  } finally {
    native.releaseUpload?.();
    await browser?.close();
    await bridge?.close();
    await app.close();
    await proxy?.close();
    await native.close();
    assert.equal(path.dirname(directory), os.tmpdir());
    fs.rmSync(directory, { recursive: true, force: true });
    delete process.env.NATIVE_BROWSER_AGENT_TOKEN;
  }
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
