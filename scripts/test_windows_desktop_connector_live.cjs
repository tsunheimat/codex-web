// Tests a disposable Windows setup against the running, unmodified Desktop.
// No scheduled task is installed and no prompt, upload or approval is sent.
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const { SessionService } = require("../src/server/gateway/service.js");
const { SessionStore } = require("../src/server/gateway/store.js");
const { createGateway } = require("../src/server/gateway/http.js");
const { desktopTlsProxy } = require("../test/fixtures/desktop-tls.cjs");
const { copyWindowsBundle } = require("./desktop/windows-bundle.cjs");

async function main() {
  if (process.platform !== "win32")
    throw new Error("This live check requires Windows Desktop");
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "desktop-connector-live-"),
  );
  let app, proxy;
  const token = randomUUID() + randomUUID();
  const tokenEnv = "CODEX_WEB_SETUP_VERIFY_TOKEN";
  const oldToken = process.env[tokenEnv];
  process.env[tokenEnv] = token;
  try {
    const backend = {
      id: "verify-windows",
      label: "Windows setup check",
      cwd: process.cwd(),
      transport: { type: "desktop", agentTokenEnv: tokenEnv },
    };
    const store = new SessionStore(":memory:");
    const service = new SessionService(store, [backend]);
    app = await createGateway(
      {
        host: "127.0.0.1",
        port: 0,
        statePath: ":memory:",
        token: randomUUID() + randomUUID(),
        allowedOrigins: [],
        backends: [backend],
      },
      service,
    );
    await app.listen({ host: "127.0.0.1", port: 0 });
    proxy = await desktopTlsProxy(app.server.address().port);
    const source = copyWindowsBundle(
      path.resolve(__dirname, ".."),
      path.join(root, "source"),
    );
    const script = path.join(source, "scripts/windows/codex-web-desktop.ps1");
    const run = (action, extra = [], target = script) =>
      promisify(execFile)(
        "powershell.exe",
        [
          "-NoProfile",
          "-NonInteractive",
          "-File",
          target,
          "-Action",
          action,
          "-Backend",
          backend.id,
          "-DataRoot",
          root,
          ...extra,
        ],
        {
          windowsHide: true,
          timeout: 90000,
          maxBuffer: 1024 * 1024,
          env: { ...process.env, CODEX_WEB_DESKTOP_AGENT_TOKEN: token },
        },
      ).catch((error) => {
        console.error(
          [error.stdout, error.stderr]
            .filter(Boolean)
            .join("\n")
            .replaceAll(token, "[redacted]"),
        );
        throw error;
      });
    await run("Configure", [
      "-Gateway",
      proxy.url,
      "-CaCertificate",
      path.resolve(__dirname, "../test/fixtures/desktop-tls/cert.pem"),
    ]);
    const connectionRoot = path.join(root, backend.id);
    assert.ok(
      !fs
        .readFileSync(path.join(connectionRoot, "bridge-token.dpapi"), "utf8")
        .includes(token),
    );
    assert.ok(
      !fs
        .readFileSync(path.join(connectionRoot, "connection.json"), "utf8")
        .includes(token),
    );
    const installed = path.join(
      connectionRoot,
      "runtime/scripts/windows/codex-web-desktop.ps1",
    );
    const status = JSON.parse((await run("Status", [], installed)).stdout);
    assert.equal(status.configured, true);
    assert.equal(status.startup, "Not installed");
    const { stdout, stderr } = await run("Check", [], installed);
    assert.ok(!stdout.includes(token) && !stderr.includes(token));
    const start = stdout.indexOf("{\r\n");
    const result = JSON.parse(
      stdout.slice(start < 0 ? stdout.indexOf("{\n") : start),
    );
    assert.equal(result.gatewayAuthenticated, true);
    assert.equal(result.desktopAttached, true);
    assert.equal(result.mutationsSent, 0);
    assert.equal(result.capabilities.chatgptAttachments, false);
    assert.equal(result.capabilities.computerUse, false);
    assert.ok(!fs.existsSync(path.join(connectionRoot, "commands.sqlite")));
    console.log(
      JSON.stringify(
        {
          ...result,
          windowsTokenProtection: true,
          copiedLocalRuntime: true,
          startupTaskInstalled: false,
        },
        null,
        2,
      ),
    );
  } finally {
    await app?.close();
    await proxy?.close();
    if (oldToken === undefined) delete process.env[tokenEnv];
    else process.env[tokenEnv] = oldToken;
    assert.equal(path.dirname(root), os.tmpdir());
    fs.rmSync(root, { recursive: true, force: true });
  }
}
main().catch((error) => {
  // execFile errors contain command/output text; keep setup failures credential-free.
  console.error(
    error.code
      ? `Windows connector live check failed (${error.code})`
      : error.message,
  );
  process.exitCode = 1;
});
