const assert = require("node:assert/strict");
const { inspect } = require("node:util");
const test = require("node:test");

globalThis.__CODEX_SHIM_VALUES__ = { version: "test" };

test("Electron stub logs bounded metadata without IPC payload values", () => {
  const capturedLogs = [];
  const rendererMessages = [];
  const originalConsoleLog = console.log;
  globalThis.__codexElectronIpcBridge = {
    broadcastToRenderer(message) {
      rendererMessages.push(message);
    },
  };
  console.log = (...args) => capturedLogs.push(args);

  const secrets = {
    account: "private-account@example.test",
    authorization: "Bearer prepare-token-super-secret",
    bodyToken: "prepare-token-from-response-body",
    cookie: "__Secure-session=private-cookie-value",
    signedUrl:
      "https://storage.example.test/archive?X-Amz-Credential=private&X-Amz-Signature=signed-secret",
  };
  const responsePayload = {
    type: "fetch-response",
    response: {
      headers: {
        Authorization: secrets.authorization,
        "Set-Cookie": secrets.cookie,
      },
      bodyJsonString: JSON.stringify({
        account: { email: secrets.account },
        prepareToken: secrets.bodyToken,
      }),
    },
    nested: {
      arbitraryPayloadValue: "nested-private-value",
    },
  };
  const responseSnapshot = structuredClone(responsePayload);

  try {
    const electron = require("../src/server/electron/index.js");
    const { BrowserWindow, session } = electron;
    const window = new BrowserWindow({ account: secrets.account });
    const callable = () => secrets.bodyToken;
    const sensitiveError = new Error(secrets.authorization);
    sensitiveError.stack = `private-stack:${secrets.cookie}`;
    const extraArguments = Array.from(
      { length: 20 },
      (_, index) => `private-extra-${index}`,
    );

    window.webContents.send(
      "codex_desktop:fetch-response",
      responsePayload,
      secrets.signedUrl,
      callable,
      sensitiveError,
      ...extraArguments,
    );
    void session
      .fromPartition(`persist:${secrets.bodyToken}`)
      .cookies.get({ url: secrets.signedUrl });
    electron.default[secrets.authorization](secrets.cookie);

    assert.deepEqual(responsePayload, responseSnapshot);
    assert.deepEqual(rendererMessages, [
      {
        type: "ipc-main-event",
        channel: "codex_desktop:fetch-response",
        args: [
          responsePayload,
          secrets.signedUrl,
          callable,
          sensitiveError,
          ...extraArguments,
        ],
      },
    ]);

    assert.ok(capturedLogs.length > 0);
    for (const entry of capturedLogs) {
      assert.equal(entry.length, 1, "each log call should have one safe value");
      assert.equal(typeof entry[0], "string", "logs should contain only text");
      assert.ok(entry[0].length <= 320, "log output should remain bounded");
    }

    const output = inspect(capturedLogs, { depth: null });
    for (const secret of [
      ...Object.values(secrets),
      "nested-private-value",
      "private-stack",
      "private-extra-0",
    ]) {
      assert.equal(output.includes(secret), false, `stdout included ${secret}`);
    }

    const sendLog = capturedLogs.find(([message]) =>
      message.includes("BrowserWindow#1.webContents.send"),
    );
    assert.ok(sendLog, "webContents.send method shape should remain visible");
    assert.match(sendLog[0], /argc=25/);
    assert.match(sendLog[0], /string/);
    assert.match(sendLog[0], /object/);
    assert.match(sendLog[0], /callable/);
    assert.match(sendLog[0], /omitted=\d+/);
  } finally {
    console.log = originalConsoleLog;
    delete globalThis.__codexElectronIpcBridge;
  }
});
