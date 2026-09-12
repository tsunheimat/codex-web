// Browser verification against a deterministic Desktop bridge fixture.
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");
const { chromium } = require("playwright");
const { WebSocket } = require("ws");
const { SessionStore } = require("../src/server/gateway/store.js");
const { SessionService } = require("../src/server/gateway/service.js");
const { createGateway } = require("../src/server/gateway/http.js");

async function main() {
  process.env.DESKTOP_BROWSER_TEST_TOKEN =
    "desktop-browser-fixture-agent-credential";
  const token = "desktop-browser-fixture-viewer-credential";
  const backend = {
    id: "desktop",
    label: "Windows Desktop",
    cwd: "C:\\project",
    transport: { type: "desktop", agentTokenEnv: "DESKTOP_BROWSER_TEST_TOKEN" },
  };
  const service = new SessionService(new SessionStore(":memory:"), [backend]);
  const app = await createGateway(
    {
      host: "127.0.0.1",
      port: 8215,
      statePath: ":memory:",
      token,
      allowedOrigins: [],
      backends: [backend],
      webRoot: path.resolve(__dirname, "../scratch/gateway-web"),
    },
    service,
  );
  let agent, browser;
  try {
    await app.listen({ host: "127.0.0.1", port: 0 });
    const origin = `http://127.0.0.1:${app.server.address().port}`;
    agent = new WebSocket(origin.replace("http:", "ws:") + "/api/v1/desktop");
    const calls = [],
      errors = [];
    let nativeReply = "Native chat history";
    agent.on("message", (raw) => {
      const m = JSON.parse(String(raw));
      if (m.type === "desktop-ready") return;
      calls.push(m);
      let result;
      if (m.method === "desktop/list")
        result = {
          data: [
            { id: "same-id", name: "Desktop task", conversationKind: "codex" },
          ],
        };
      else if (m.method === "desktop/chatgpt/list")
        result = {
          data: [
            { id: "same-id", name: "Native chat", conversationKind: "chatgpt" },
          ],
        };
      else if (m.method === "desktop/attach" || m.method === "desktop/read")
        result = {
          thread: {
            id: "same-id",
            name: "Desktop task",
            turns: [
              {
                id: "codex-turn",
                status: "completed",
                items: [
                  {
                    id: "codex-item",
                    type: "agentMessage",
                    text: "Desktop task history",
                  },
                ],
              },
            ],
          },
        };
      else if (m.method === "desktop/chatgpt/read")
        result = {
          conversationId: "same-id",
          conversationKind: "chatgpt",
          conversation: {
            thread: {
              id: "same-id",
              kind: "chatgpt",
              title: "Native chat",
              status: { type: "idle" },
            },
            turns: [
              {
                id: "native-turn",
                status: "completed",
                items: [
                  {
                    id: "native-item",
                    type: "agentMessage",
                    text: nativeReply,
                  },
                ],
              },
            ],
          },
        };
      else if (m.method === "desktop/chatgpt/send") {
        nativeReply = "Native handler received the prompt";
        result = { threadId: "same-id" };
      } else {
        errors.push("Unexpected bridge method " + m.method);
        return;
      }
      agent.send(JSON.stringify({ id: m.id, result }));
    });
    await new Promise((resolve) => agent.once("open", resolve));
    agent.send(
      JSON.stringify({
        type: "desktop-authenticate",
        version: 1,
        backendId: backend.id,
        token: process.env.DESKTOP_BROWSER_TEST_TOKEN,
        desktop: { version: "26.908.40834" },
        capabilities: {
          codex: true,
          chatgpt: true,
          attachments: true,
          chatgptAttachments: false,
          computerUse: false,
        },
      }),
    );
    browser = await chromium.launch({
      headless: true,
      ...(process.env.CODEX_WEB_BROWSER_EXECUTABLE
        ? { executablePath: process.env.CODEX_WEB_BROWSER_EXECUTABLE }
        : {}),
    });
    const context = await browser.newContext({
      viewport: { width: 1280, height: 850 },
    });
    const page = await context.newPage();
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(origin);
    await page.getByLabel("Access token").fill(token);
    await page.getByRole("button", { name: "Connect to server" }).click();
    await page
      .getByRole("button", { name: "Open Desktop conversation" })
      .first()
      .click();
    await page
      .getByRole("button", { name: "Desktop task", exact: true })
      .click();
    await page.getByText("Desktop task history", { exact: true }).waitFor();
    assert.equal(await page.locator('input[type="file"]').isEnabled(), true);
    assert.equal(
      await page
        .getByRole("button", { name: "Terminal", exact: true })
        .isDisabled(),
      true,
    );
    await page
      .getByRole("button", { name: "Existing threads", exact: true })
      .click();
    await page
      .getByRole("button", { name: "ChatGPT · Native chat", exact: true })
      .click();
    await page.getByText("Native chat history", { exact: true }).waitFor();
    assert.equal(await page.locator('input[type="file"]').isDisabled(), true);
    await page
      .getByRole("textbox", { name: "Message", exact: true })
      .fill("A native ChatGPT prompt");
    await page.getByRole("button", { name: "Send ↑", exact: true }).click();
    await page
      .getByText("Native handler received the prompt", { exact: true })
      .waitFor();
    const sent = calls.filter((c) => c.method === "desktop/chatgpt/send");
    assert.equal(sent.length, 1);
    assert.deepEqual(sent[0].params, {
      prompt: "A native ChatGPT prompt",
      conversationId: "same-id",
    });
    assert.equal(service.store.list().length, 2);
    const qa = path.resolve(__dirname, "../scratch/qa");
    fs.mkdirSync(qa, { recursive: true });
    await page.screenshot({
      path: path.join(qa, "remote-desktop-native.png"),
      fullPage: true,
    });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForFunction(
      () =>
        document.querySelector(".sidebar").getBoundingClientRect().right <= 0,
    );
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
      true,
    );
    await page.screenshot({
      path: path.join(qa, "remote-desktop-mobile.png"),
      fullPage: true,
    });
    assert.deepEqual(errors, []);
    console.log(
      "PASS: Desktop/native picker, separate identities, native text routing, capability controls and mobile layout.",
    );
  } finally {
    await browser?.close();
    agent?.terminate();
    await app.close();
    delete process.env.DESKTOP_BROWSER_TEST_TOKEN;
  }
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
