// The compatibility server in gateway mode as the k3s renderer runs it: the
// page must be served and readiness must follow the Desktop shell's startup,
// which writes under CODEX_HOME and exits the process when it fails. These
// are the failure modes that took the deployed page down (EACCES on
// .codex/sqlite; a gateway that was not reachable yet).
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const test = require("node:test");
const { startDesktopStack, until } = require("./fixtures/desktop-stack.cjs");

const repositoryRoot = path.resolve(__dirname, "..");
const entrypoint = path.join(repositoryRoot, "src/server/main.js");
const HOSTNAME = "codex-test.test.tsunhei.com";
// The prepared Desktop bundle (scripts/prepare) is not part of the checkout;
// CI covers this path with scripts/test_renderer_container.cjs instead.
const bundlePrepared = fs.existsSync(
  path.join(repositoryRoot, "scratch/asar/webview/index.html"),
);
const bundleTest = bundlePrepared
  ? test
  : (name, fn) => test(name, { skip: "run scripts/prepare first" }, fn);

function freePort() {
  const net = require("node:net");
  return new Promise((resolve) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

async function startRenderer({ gatewayUrl, token, prepareHome = () => {} }) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "codex-web-renderer-"));
  fs.mkdirSync(path.join(home, "workspace"));
  prepareHome(home);
  const port = await freePort();
  const output = [];
  const child = spawn(
    process.execPath,
    [entrypoint, "--host", "127.0.0.1", "--port", String(port)],
    {
      cwd: repositoryRoot,
      env: {
        ...process.env,
        NODE_ENV: "production",
        HOME: home,
        CODEX_HOME: path.join(home, ".codex"),
        CODEX_WEB_RUNTIME_OWNERSHIP: "external",
        CODEX_WEBUI_BROWSE_ROOT: path.join(home, "workspace"),
        CODEX_WEB_GATEWAY_URL: gatewayUrl,
        CODEX_WEB_GATEWAY_TOKEN: token,
        CODEX_WEB_GATEWAY_BACKEND: "windows",
        CODEX_WEB_ALLOWED_ORIGINS: `https://${HOSTNAME}`,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  child.stdout.on("data", (chunk) => output.push(String(chunk)));
  child.stderr.on("data", (chunk) => output.push(String(chunk)));
  const exit = new Promise((resolve) =>
    child.on("exit", (code, signal) => resolve({ code, signal })),
  );
  let exited = null;
  exit.then((result) => {
    exited = result;
  });
  const base = `http://127.0.0.1:${port}`;
  return {
    home,
    base,
    output: () => output.join(""),
    exited: () => exited,
    exit,
    request: (route, options = {}) =>
      fetch(base + route, { ...options, signal: AbortSignal.timeout(5000) }),
    async close() {
      if (!exited) {
        child.kill("SIGKILL");
        await exit;
      }
      fs.chmodSync(path.join(home, ".codex"), 0o755);
      fs.rmSync(home, { recursive: true, force: true });
    },
  };
}

bundleTest("gateway-mode renderer serves the page and reports ready after shell startup", async () => {
  const stack = await startDesktopStack();
  const renderer = await startRenderer(stack);
  try {
    await until(() => renderer.output().includes("IPC bridge listening"), 30000);
    // The shell starts after the socket listens; its app-server handshake
    // through the gateway adapter is the last startup step that can exit
    // the process, so wait for it before judging the page.
    await until(() => renderer.output().includes("Codex CLI initialized"), 60000);
    assert.equal(renderer.exited(), null);
    const health = await renderer.request("/healthz");
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), { ok: true });

    const page = await renderer.request("/");
    assert.equal(page.status, 200);
    assert.match(page.headers.get("content-type"), /^text\/html/);
    const html = await page.text();
    assert.match(html, /<title>Codex<\/title>/);
    assert.match(html, /assets\/preload\.js/);
    assert.equal((await renderer.request("/assets/preload.js")).status, 200);
    assert.equal((await renderer.request("/threads/anything")).status, 200);
    const blocked = await renderer.request("/__backend/", {
      headers: { origin: "https://evil.example" },
    });
    assert.equal(blocked.status, 403);

    // State lands under the mounted home directories, nowhere else.
    assert.ok(fs.existsSync(path.join(renderer.home, ".codex", "sqlite")));
    assert.doesNotMatch(renderer.output(), /EACCES|EROFS/);
  } finally {
    await renderer.close();
    await stack.close();
  }
});

bundleTest("a Codex home the renderer cannot write is fatal, not silently degraded", async (t) => {
  const stack = await startDesktopStack();
  const renderer = await startRenderer({
    ...stack,
    prepareHome(home) {
      fs.mkdirSync(path.join(home, ".codex"));
      fs.chmodSync(path.join(home, ".codex"), 0o555);
    },
  });
  try {
    // A filesystem that ignores mode bits (root, some network shares)
    // cannot demonstrate the failure.
    let enforced = true;
    try {
      fs.writeFileSync(path.join(renderer.home, ".codex", "probe"), "");
      enforced = false;
    } catch {}
    if (!enforced) {
      t.skip("directory permissions are not enforced on this filesystem");
      return;
    }
    const result = await Promise.race([
      renderer.exit,
      new Promise((resolve) => setTimeout(() => resolve("still running"), 60000)),
    ]);
    assert.deepEqual(result, { code: 1, signal: null });
    assert.match(renderer.output(), /EACCES: permission denied, mkdir '.*\.codex\/sqlite'/);
  } finally {
    await renderer.close();
    await stack.close();
  }
});

bundleTest("a gateway that refuses the shell's connection at startup ends the process", async () => {
  const port = await freePort();
  const renderer = await startRenderer({
    gatewayUrl: `http://127.0.0.1:${port}`,
    token: "viewer-token-with-more-than-32-characters",
  });
  try {
    const result = await Promise.race([
      renderer.exit,
      new Promise((resolve) => setTimeout(() => resolve("still running"), 60000)),
    ]);
    assert.deepEqual(result, { code: 1, signal: null });
    assert.match(renderer.output(), /ECONNREFUSED/);
  } finally {
    await renderer.close();
  }
});
