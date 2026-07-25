const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const fsp = require("node:fs/promises");
const http = require("node:http");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { randomUUID } = require("node:crypto");

const repositoryRoot = path.resolve(__dirname, "..");
const serverEntrypoint = path.join(repositoryRoot, "src/server/main.js");
const hangingCodexCli = path.join(
  repositoryRoot,
  "test/fixtures/hanging-codex-cli.cjs",
);
const runMarkerName = "CODEX_WEB_CLEANUP_TEST_RUN_ID";

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitFor(label, predicate, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const result = await predicate();
      if (result) return result;
    } catch (error) {
      lastError = error;
    }
    await wait(25);
  }
  throw new Error(
    `Timed out waiting for ${label}${lastError ? `: ${lastError}` : ""}`,
  );
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

async function listenOnLoopback() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert(address && typeof address !== "string");
  return { server, port: address.port };
}

function captureChild(child) {
  const output = [];
  for (const stream of [child.stdout, child.stderr]) {
    stream.setEncoding("utf8");
    stream.on("data", (chunk) => output.push(chunk));
  }
  return { child, output };
}

function childOutput(run) {
  return run.output.join("");
}

function waitForExit(run, timeoutMs = 20_000) {
  if (run.child.exitCode !== null || run.child.signalCode !== null) {
    return Promise.resolve({
      code: run.child.exitCode,
      signal: run.child.signalCode,
    });
  }
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(
        new Error(`Timed out waiting for server exit\n${childOutput(run)}`),
      );
    }, timeoutMs);
    run.child.once("exit", (code, signal) => {
      clearTimeout(timeout);
      resolve({ code, signal });
    });
  });
}

function processExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

async function markedProcessIds(runId) {
  const expected = Buffer.from(`${runMarkerName}=${runId}`);
  const entries = await fsp.readdir("/proc", { withFileTypes: true });
  const matches = [];
  await Promise.all(
    entries
      .filter((entry) => entry.isDirectory() && /^\d+$/.test(entry.name))
      .map(async (entry) => {
        const pid = Number(entry.name);
        if (pid === process.pid) return;
        try {
          const environment = await fsp.readFile(
            path.join("/proc", entry.name, "environ"),
          );
          if (
            environment
              .toString("utf8")
              .split("\0")
              .some((item) => Buffer.from(item).equals(expected))
          ) {
            matches.push(pid);
          }
        } catch (error) {
          if (!["EACCES", "ENOENT", "EPERM", "ESRCH"].includes(error.code)) {
            throw error;
          }
        }
      }),
  );
  return matches.sort((left, right) => left - right);
}

async function runtimeRoots(temporaryDirectory) {
  const entries = await fsp.readdir(temporaryDirectory);
  return entries.filter((entry) => entry.startsWith("codex-web-runtime-"));
}

async function pathIsSocket(socketPath) {
  return await fsp
    .stat(socketPath)
    .then((stat) => stat.isSocket())
    .catch(() => false);
}

async function assertPortClosed(port) {
  await new Promise((resolve, reject) => {
    const socket = net.connect({ host: "127.0.0.1", port });
    socket.once("connect", () => {
      socket.destroy();
      reject(new Error(`port ${port} is still accepting connections`));
    });
    socket.once("error", () => resolve());
  });
}

async function verifyAndRemoveFixtureRoot(
  root,
  verifyCleanliness,
  removeRoot = (fixtureRoot) =>
    fsp.rm(fixtureRoot, { recursive: true, force: true }),
) {
  let verificationFailed = false;
  let verificationError;
  try {
    await verifyCleanliness();
  } catch (error) {
    verificationFailed = true;
    verificationError = error;
  } finally {
    try {
      await removeRoot(root);
    } catch (removalError) {
      if (verificationFailed) {
        throw new AggregateError(
          [verificationError, removalError],
          `Fixture verification and root removal both failed for ${root}`,
        );
      }
      throw removalError;
    }
  }

  if (verificationFailed) throw verificationError;
}

async function createIsolatedRun(t, { codexCliPath, environment = {}, port }) {
  const root = await fsp.mkdtemp(
    path.join(os.tmpdir(), "codex-web-server-cleanup-test-"),
  );
  const home = path.join(root, "home");
  const codexHome = path.join(root, "codex-home");
  const browseRoot = path.join(root, "browse-root");
  const temporaryDirectory = path.join(root, "tmp");
  await Promise.all(
    [home, codexHome, browseRoot, temporaryDirectory].map((directory) =>
      fsp.mkdir(directory, { recursive: true }),
    ),
  );

  const runId = randomUUID();
  const run = captureChild(
    spawn(
      process.execPath,
      [serverEntrypoint, "--host", "127.0.0.1", "--port", String(port)],
      {
        cwd: browseRoot,
        env: {
          ...process.env,
          HOME: home,
          CODEX_HOME: codexHome,
          CODEX_CLI_PATH: codexCliPath,
          CODEX_WEBUI_BROWSE_ROOT: browseRoot,
          TMPDIR: temporaryDirectory,
          [runMarkerName]: runId,
          ...environment,
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    ),
  );

  t.after(() =>
    verifyAndRemoveFixtureRoot(root, async () => {
      if (processExists(run.child.pid)) {
        run.child.kill("SIGKILL");
        await waitForExit(run).catch(() => undefined);
      }
      const leftoverProcesses = await waitFor(
        "run-owned process teardown",
        async () => {
          const pids = await markedProcessIds(runId);
          return pids.length === 0 ? [] : false;
        },
      );
      assert.deepEqual(leftoverProcesses, []);
      assert.deepEqual(await runtimeRoots(temporaryDirectory), []);
    }),
  );

  return { ...run, port, runId, temporaryDirectory };
}

async function assertRunClean(run) {
  assert.deepEqual(await runtimeRoots(run.temporaryDirectory), []);
  await waitFor("run-owned processes to exit", async () => {
    const pids = await markedProcessIds(run.runId);
    return pids.length === 0;
  });
  assert.deepEqual(await markedProcessIds(run.runId), []);
  await assertPortClosed(run.port);
}

test("failed teardown verification still removes its exact fixture root", async (t) => {
  const root = await fsp.mkdtemp(
    path.join(os.tmpdir(), "codex-web-server-cleanup-test-"),
  );
  const otherRoot = await fsp.mkdtemp(
    path.join(os.tmpdir(), "codex-web-server-cleanup-test-"),
  );
  t.after(() =>
    Promise.all(
      [root, otherRoot].map((fixtureRoot) =>
        fsp.rm(fixtureRoot, { recursive: true, force: true }),
      ),
    ),
  );
  await fsp.writeFile(path.join(root, "verification-sentinel"), "owned");
  const verificationError = new Error(
    "deliberate teardown verification failure",
  );

  await assert.rejects(
    verifyAndRemoveFixtureRoot(root, async () => {
      throw verificationError;
    }),
    (error) => error === verificationError,
  );

  await assert.rejects(fsp.access(root), { code: "ENOENT" });
  await fsp.access(otherRoot);
});

test("teardown reports verification and root-removal failures together", async () => {
  const root = path.join(
    os.tmpdir(),
    `codex-web-server-cleanup-test-${randomUUID()}`,
  );
  const verificationError = new Error("deliberate verification failure");
  const removalError = new Error("deliberate root removal failure");

  await assert.rejects(
    verifyAndRemoveFixtureRoot(
      root,
      async () => {
        throw verificationError;
      },
      async () => {
        throw removalError;
      },
    ),
    (error) => {
      assert(error instanceof AggregateError);
      assert.deepEqual(error.errors, [verificationError, removalError]);
      assert.match(error.message, /verification and root removal both failed/i);
      return true;
    },
  );
});

test("invalid Desktop CLI startup failure exits nonzero and cleans server ownership", async (t) => {
  const port = await unusedLoopbackPort();
  const invalidCli = path.join(os.tmpdir(), `missing-codex-${randomUUID()}`);
  const run = await createIsolatedRun(t, { codexCliPath: invalidCli, port });

  const result = await waitForExit(run);
  assert.notEqual(result.code, 0, childOutput(run));
  assert.match(
    childOutput(run),
    /Unable to locate the Codex CLI binary|ENOENT|no such file/i,
  );
  await assertRunClean(run);
});

test("invalid upload quotas fail before listen without runtime residue", async (t) => {
  for (const value of [
    "",
    "0",
    "-1",
    "1.5",
    "1e3",
    String(Number.MAX_SAFE_INTEGER + 1),
  ]) {
    await t.test(JSON.stringify(value), async (t) => {
      const port = await unusedLoopbackPort();
      const run = await createIsolatedRun(t, {
        codexCliPath: hangingCodexCli,
        environment: { CODEX_WEBUI_UPLOAD_QUOTA_BYTES: value },
        port,
      });
      const result = await waitForExit(run);
      assert.notEqual(result.code, 0, childOutput(run));
      assert.match(childOutput(run), /positive decimal safe integer/);
      assert.equal(childOutput(run).includes("IPC bridge listening at"), false);
      await assertRunClean(run);
    });
  }
});

test("invalid allow-any-project values fail before listen", async (t) => {
  for (const value of ["", "0", "1", "TRUE", "yes", " true "]) {
    await t.test(JSON.stringify(value), async (t) => {
      const port = await unusedLoopbackPort();
      const run = await createIsolatedRun(t, {
        codexCliPath: hangingCodexCli,
        environment: { CODEX_WEBUI_ALLOW_ANY_PROJECT: value },
        port,
      });
      const result = await waitForExit(run);
      assert.notEqual(result.code, 0, childOutput(run));
      assert.match(
        childOutput(run),
        /CODEX_WEBUI_ALLOW_ANY_PROJECT must be true or false/,
      );
      assert.equal(childOutput(run).includes("IPC bridge listening at"), false);
      await assertRunClean(run);
    });
  }
});

test("allow-any-project starts with the filesystem root authority", async (t) => {
  const port = await unusedLoopbackPort();
  const run = await createIsolatedRun(t, {
    codexCliPath: hangingCodexCli,
    environment: { CODEX_WEBUI_ALLOW_ANY_PROJECT: "true" },
    port,
  });

  await waitFor("allow-any bridge listener", () =>
    childOutput(run).includes("IPC bridge listening at"),
  );
  const filesystemRoot = path.parse(path.resolve(os.homedir())).root;
  assert.equal(
    childOutput(run).includes(`Workspace browse root: ${filesystemRoot}`),
    true,
    childOutput(run),
  );

  run.child.kill("SIGTERM");
  const result = await waitForExit(run);
  assert.equal(result.code, 0, childOutput(run));
  await assertRunClean(run);
});

test("synchronous listen failure cleans the created runtime and remains nonzero", async (t) => {
  const occupied = await listenOnLoopback();
  t.after(
    () =>
      new Promise((resolve, reject) =>
        occupied.server.close((error) => (error ? reject(error) : resolve())),
      ),
  );
  const invalidCli = path.join(os.tmpdir(), `unused-codex-${randomUUID()}`);
  const run = await createIsolatedRun(t, {
    codexCliPath: invalidCli,
    port: occupied.port,
  });

  const result = await waitForExit(run);
  assert.notEqual(result.code, 0, childOutput(run));
  assert.match(childOutput(run), /EADDRINUSE|address already in use/i);
  assert.deepEqual(await runtimeRoots(run.temporaryDirectory), []);
  assert.deepEqual(await markedProcessIds(run.runId), []);
});

test("SIGTERM performs normal cleanup and closes run-owned app-server child", async (t) => {
  const port = await unusedLoopbackPort();
  const run = await createIsolatedRun(t, {
    codexCliPath: hangingCodexCli,
    port,
  });

  await waitFor("bridge listener", () =>
    childOutput(run).includes("IPC bridge listening at"),
  );
  await waitFor("run-owned app-server child", async () => {
    const pids = await markedProcessIds(run.runId);
    return pids.some((pid) => pid !== run.child.pid);
  });
  const ownedRuntimeRoot = await waitFor(
    "run-owned app-server IPC socket",
    async () => {
      for (const entry of await runtimeRoots(run.temporaryDirectory)) {
        const runtimeRoot = path.join(run.temporaryDirectory, entry);
        if (await pathIsSocket(path.join(runtimeRoot, "codex-ipc/ipc.sock"))) {
          return runtimeRoot;
        }
      }
      return false;
    },
  );
  const ownedSocketPath = path.join(ownedRuntimeRoot, "codex-ipc/ipc.sock");
  run.child.kill("SIGTERM");

  const result = await waitForExit(run);
  assert.equal(result.code, 0, childOutput(run));
  await waitFor("run-owned app-server exit", async () => {
    const pids = await markedProcessIds(run.runId);
    return pids.length === 0;
  });
  assert.equal(
    await pathIsSocket(ownedSocketPath),
    false,
    "run-owned app-server socket survived server cleanup",
  );
  await assertRunClean(run);
});

test("SIGTERM drains a hung multipart upload before exit", async (t) => {
  const port = await unusedLoopbackPort();
  const run = await createIsolatedRun(t, {
    codexCliPath: hangingCodexCli,
    port,
  });

  await waitFor("bridge listener", () =>
    childOutput(run).includes("IPC bridge listening at"),
  );
  await waitFor("run-owned app-server child", async () => {
    const pids = await markedProcessIds(run.runId);
    return pids.some((pid) => pid !== run.child.pid);
  });
  await waitFor("run-owned app-server IPC socket", async () => {
    for (const entry of await runtimeRoots(run.temporaryDirectory)) {
      const runtimeRoot = path.join(run.temporaryDirectory, entry);
      if (await pathIsSocket(path.join(runtimeRoot, "codex-ipc/ipc.sock"))) {
        return true;
      }
    }
    return false;
  });

  const boundary = `codex-web-${randomUUID()}`;
  const uploadRequest = http.request({
    hostname: "127.0.0.1",
    port: run.port,
    path: "/__backend/upload",
    method: "POST",
    headers: {
      "content-type": `multipart/form-data; boundary=${boundary}`,
    },
  });
  uploadRequest.on("error", () => undefined);
  uploadRequest.write(
    `--${boundary}\r\nContent-Disposition: form-data; name="files"; filename="stalled.bin"\r\nContent-Type: application/octet-stream\r\n\r\n`,
  );
  uploadRequest.write(Buffer.alloc(8, 0x61));
  await waitFor(
    "multipart upload bytes to flush",
    () =>
      uploadRequest.socket !== null &&
      !uploadRequest.socket.destroyed &&
      uploadRequest.socket.bytesWritten > 0,
  );

  run.child.kill("SIGTERM");
  const result = await waitForExit(run, 10_000);
  assert.equal(result.code, 0, childOutput(run));
  uploadRequest.destroy();
  await assertRunClean(run);
});

test("external app-server topology does not delete shared runtime state", async (t) => {
  const port = await unusedLoopbackPort();
  const externalSocketPath = path.join(
    os.tmpdir(),
    `external-app-server-${randomUUID()}.sock`,
  );
  const run = await createIsolatedRun(t, {
    codexCliPath: hangingCodexCli,
    environment: { CODEX_UNIX_SOCKET: externalSocketPath },
    port,
  });
  const sharedSocketPath = path.join(
    run.temporaryDirectory,
    "codex-ipc/ipc.sock",
  );

  await waitFor("shared app-server IPC socket", () =>
    pathIsSocket(sharedSocketPath),
  );
  run.child.kill("SIGTERM");
  const result = await waitForExit(run);
  assert.equal(result.code, 0, childOutput(run));
  await waitFor("external-topology process exit", async () => {
    const pids = await markedProcessIds(run.runId);
    return pids.length === 0;
  });
  assert.equal(
    await pathIsSocket(sharedSocketPath),
    true,
    "codex-web deleted shared external-topology runtime state",
  );

  await fsp.rm(path.dirname(sharedSocketPath), {
    recursive: true,
    force: true,
  });
  await assertRunClean(run);
});
