// Exercise the deployed browser path as containers: the original renderer's
// compatibility server (default Dockerfile) in gateway mode next to the
// packaged gateway (Dockerfile.gateway), with the k3s manifests' security
// model (UID 1000, read-only root filesystem, emptyDir-style volumes).
// GET / must serve the Desktop UI; a green gateway alone proves nothing.
// Only built-in Node modules are needed on the CI runner.
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const { randomBytes } = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const assert = require("node:assert/strict");
const { setTimeout: delay } = require("node:timers/promises");

const docker = (args, timeout = 30000) =>
  promisify(execFile)("docker", args, {
    timeout,
    maxBuffer: 4 * 1024 * 1024,
    windowsHide: true,
  });

const HOSTNAME = "codex-test.test.tsunhei.com";
// Mirrors web-deployment.yaml. Kubernetes emptyDir volumes are root-owned
// and world-writable, which is what a plain tmpfs gives us here; nothing
// is pre-chowned for UID 1000 so an image that needs that would fail.
const RENDERER_VOLUMES = [
  "/home/codex-web",
  "/home/codex-web/.codex",
  "/workspace",
  "/tmp",
];

async function waitFor(label, probe, attempts, intervalMs = 1000) {
  let last;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      const result = await probe();
      if (result.ok) return result;
      last = `status ${result.status}`;
    } catch (error) {
      last = error.message;
    }
    await delay(intervalMs);
  }
  throw new Error(`${label} did not become ready: ${last}`);
}

async function main() {
  const [rendererImage, gatewayImage] = process.argv.slice(2);
  if (!rendererImage || !gatewayImage || rendererImage.startsWith("-"))
    throw new Error(
      "Usage: test_renderer_container.cjs <renderer image> <gateway image>",
    );
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "renderer-container-"));
  const suffix = randomBytes(6).toString("hex");
  const network = `renderer-smoke-${suffix}`;
  const gatewayName = `gateway-smoke-${suffix}`;
  const rendererName = `renderer-smoke-${suffix}`;
  const viewerToken = randomBytes(32).toString("hex");
  const started = new Set();
  let networkCreated = false;
  try {
    const config = JSON.parse(
      fs.readFileSync(
        path.join(__dirname, "../deploy/k3s/gateway/gateway.config.json"),
        "utf8",
      ),
    );
    assert.equal(config.backends[0].id, "windows-desktop");
    fs.chmodSync(root, 0o755);
    fs.writeFileSync(path.join(root, "gateway.json"), JSON.stringify(config), {
      mode: 0o644,
    });
    fs.writeFileSync(
      path.join(root, "gateway.env"),
      `CODEX_WEB_GATEWAY_TOKEN=${viewerToken}\nCODEX_WEB_DESKTOP_AGENT_TOKEN=${randomBytes(32).toString("hex")}\n`,
      { mode: 0o600 },
    );
    // The renderer receives only the viewer token, as in the manifests.
    fs.writeFileSync(
      path.join(root, "renderer.env"),
      `CODEX_WEB_GATEWAY_TOKEN=${viewerToken}\n`,
      { mode: 0o600 },
    );
    await docker(["network", "create", network]);
    networkCreated = true;

    await docker([
      "run",
      "--detach",
      "--name",
      gatewayName,
      "--network",
      network,
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
      gatewayImage,
    ]);
    started.add(gatewayName);

    const rendererArgs = [
      "run",
      "--detach",
      "--name",
      rendererName,
      "--network",
      network,
      // web-deployment.yaml: runAsUser/runAsGroup 1000 and a read-only root.
      "--user",
      "1000:1000",
      "--read-only",
      "--cap-drop=ALL",
      "--security-opt=no-new-privileges",
      "--env-file",
      path.join(root, "renderer.env"),
      "--env",
      "NODE_ENV=production",
      "--env",
      "HOME=/home/codex-web",
      "--env",
      "CODEX_HOME=/home/codex-web/.codex",
      "--env",
      "CODEX_WEB_RUNTIME_OWNERSHIP=external",
      "--env",
      `CODEX_WEB_GATEWAY_URL=http://${gatewayName}:8215`,
      "--env",
      "CODEX_WEB_GATEWAY_ALLOW_PLAIN_HTTP=true",
      "--env",
      "CODEX_WEB_GATEWAY_BACKEND=windows-desktop",
      "--env",
      "CODEX_WEBUI_BROWSE_ROOT=/workspace",
      "--env",
      "CODEX_WEBUI_ALLOW_ANY_PROJECT=false",
      "--env",
      `CODEX_WEB_ALLOWED_ORIGINS=https://${HOSTNAME}`,
      "--publish",
      "127.0.0.1::8214",
    ];
    for (const mountPath of RENDERER_VOLUMES)
      rendererArgs.push("--tmpfs", `${mountPath}:rw,mode=0777`);
    rendererArgs.push(
      rendererImage,
      "node",
      "src/server/main.js",
      "--host",
      "0.0.0.0",
      "--port",
      "8214",
    );
    await docker(rendererArgs);
    started.add(rendererName);

    const { stdout } = await docker(["port", rendererName, "8214/tcp"]);
    const address = stdout.trim().split("\n")[0];
    assert.match(address, /^127\.0\.0\.1:\d+$/);
    const base = `http://${address}`;
    const request = (url, options = {}) =>
      fetch(base + url, { ...options, signal: AbortSignal.timeout(5000) });

    await waitFor("Renderer /healthz", () => request("/healthz"), 60);
    // The socket listens before the Desktop shell starts. The shell's
    // app-server handshake through the gateway is its last startup step that
    // exits the process on failure (after the state directories under
    // CODEX_HOME), so wait for it before judging the page.
    const containerLogs = async () => {
      const logs = await docker(["logs", rendererName]);
      return logs.stdout + logs.stderr;
    };
    await waitFor(
      "Renderer shell startup",
      async () => ({ ok: (await containerLogs()).includes("Codex CLI initialized") }),
      120,
    );
    const inspect = JSON.parse(
      (await docker(["inspect", rendererName])).stdout,
    )[0];
    assert.equal(inspect.State.Running, true, "Renderer container exited");

    const page = await request("/");
    assert.equal(page.status, 200, "GET / must serve the Desktop UI");
    assert.match(page.headers.get("content-type") ?? "", /^text\/html/);
    const html = await page.text();
    assert.match(html, /<title>Codex<\/title>/);
    assert.match(html, /assets\/preload\.js/);
    const preload = await request("/assets/preload.js");
    assert.equal(preload.status, 200, "Renderer assets must be packaged");
    // Client-side routes fall back to the page; the IPC bridge stays guarded.
    assert.equal((await request("/some/client/route")).status, 200);
    assert.equal(
      (await request("/__backend/", { headers: { origin: "https://evil.example" } }))
        .status,
      403,
    );

    // The shell must have run without a Codex execution runtime.
    const processes = (await docker(["top", rendererName, "-eo", "pid,args"]))
      .stdout;
    assert.ok(processes.includes("src/server/main.js"));
    assert.ok(
      !processes.includes("codex app-server"),
      "Renderer must not spawn an execution runtime in gateway mode",
    );
    assert.ok(
      !/EACCES|EROFS/.test(await containerLogs()),
      "Renderer wrote outside its writable volumes",
    );

    // The gateway side of the same network still authenticates API callers.
    const gatewayProbe = await docker([
      "exec",
      rendererName,
      "node",
      "-e",
      `fetch(process.env.CODEX_WEB_GATEWAY_URL + "/api/v1/backends").then((r) => { console.log(r.status); });`,
    ]);
    assert.equal(gatewayProbe.stdout.trim(), "401");

    console.log(
      "Containers passed: renderer serves the Desktop UI at / through the gateway as UID 1000 on a read-only root with emptyDir-style volumes; gateway API stays authenticated.",
    );
  } catch (error) {
    for (const name of started) {
      const logs = await docker(["logs", "--tail", "60", name]).catch(
        () => null,
      );
      if (logs)
        console.error(
          `--- ${name}\n` +
            (logs.stdout + logs.stderr).replaceAll(viewerToken, "[redacted]"),
        );
    }
    throw error;
  } finally {
    for (const name of started)
      await docker(["rm", "--force", name]).catch(() => {});
    if (networkCreated) await docker(["network", "rm", network]).catch(() => {});
    assert.equal(path.dirname(root), os.tmpdir());
    fs.rmSync(root, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
