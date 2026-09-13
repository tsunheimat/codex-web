// Exercise the actual gateway image without Desktop credentials or an execution host.
// Only built-in Node modules are needed on the CI runner.
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const { randomBytes } = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const assert = require("node:assert/strict");
const { setTimeout: delay } = require("node:timers/promises");
const docker = (args) =>
  promisify(execFile)("docker", args, {
    timeout: 30000,
    maxBuffer: 1024 * 1024,
    windowsHide: true,
  });

async function main() {
  const image = process.argv[2];
  if (!image || image.startsWith("-"))
    throw new Error("Provide the gateway image tag to test");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gateway-container-"));
  const name = "gateway-smoke-" + randomBytes(6).toString("hex");
  const token = randomBytes(32).toString("hex");
  let started = false;
  try {
    const config = JSON.parse(
      fs.readFileSync(
        path.join(__dirname, "../deploy/k3s/gateway/gateway.config.json"),
        "utf8",
      ),
    );
    // The non-root container must be able to traverse this test config directory.
    fs.chmodSync(root, 0o755);
    fs.writeFileSync(path.join(root, "gateway.json"), JSON.stringify(config), {
      mode: 0o644,
    });
    fs.writeFileSync(
      path.join(root, "gateway.env"),
      `CODEX_WEB_GATEWAY_TOKEN=${token}\nCODEX_WEB_DESKTOP_AGENT_TOKEN=${randomBytes(32).toString("hex")}\n`,
      { mode: 0o600 },
    );
    await docker([
      "run",
      "--detach",
      "--rm",
      "--name",
      name,
      "--read-only",
      "--cap-drop=ALL",
      "--security-opt=no-new-privileges",
      "--tmpfs",
      "/data:rw,uid=1000,gid=1000,mode=0700",
      "--tmpfs",
      "/tmp:rw,uid=1000,gid=1000,mode=0700",
      "--env-file",
      path.join(root, "gateway.env"),
      "--mount",
      `type=bind,src=${path.join(root, "gateway.json")},dst=/config/gateway.json,readonly`,
      "--publish",
      "127.0.0.1::8215",
      image,
    ]);
    started = true;
    const { stdout } = await docker(["port", name, "8215/tcp"]);
    const address = stdout.trim();
    assert.match(address, /^127\.0\.0\.1:\d+$/);
    const base = `http://${address}`;
    const request = (url, options = {}) =>
      fetch(base + url, {
        ...options,
        signal: AbortSignal.timeout(3000),
      });
    let healthy = false;
    for (let attempt = 0; attempt < 30; attempt++) {
      try {
        healthy = (await request("/healthz")).ok;
      } catch {}
      if (healthy) break;
      await delay(1000);
    }
    assert.ok(healthy, "Packaged gateway failed to become healthy");
    const ui = await request("/");
    assert.equal(ui.status, 200);
    const html = await ui.text();
    const asset = html.match(/src="([^"]+\.js)"/);
    assert.ok(asset, "Built frontend script is absent");
    const assetPath = new URL(asset[1], base + "/").pathname;
    assert.equal((await request(assetPath)).status, 200);
    assert.equal((await request("/api/v1/backends")).status, 401);
    const response = await request("/api/v1/backends", {
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(response.status, 200);
    const backends = await response.json();
    assert.equal(backends.length, 1);
    assert.equal(backends[0].id, "windows-desktop");
    assert.equal(backends[0].connected, false);
    const processes = (await docker(["top", name, "-eo", "pid,args"])).stdout;
    assert.ok(processes.includes("src/server/gateway/main.js"));
    assert.ok(
      !processes.includes("codex app-server"),
      "Gateway must not spawn an execution runtime",
    );
    console.log(
      "Container passed: health, frontend assets, API authentication, Desktop backend, read-only non-root startup.",
    );
  } catch (error) {
    if (started) {
      const logs = await docker(["logs", "--tail", "40", name]).catch(
        () => null,
      );
      if (logs)
        console.error(
          (logs.stdout + logs.stderr).replaceAll(token, "[redacted]"),
        );
    }
    throw error;
  } finally {
    if (started) await docker(["rm", "--force", name]);
    assert.equal(path.dirname(root), os.tmpdir());
    fs.rmSync(root, { recursive: true, force: true });
  }
}
main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
