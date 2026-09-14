const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  parseConfig,
  sshArguments,
  shellQuote,
} = require("../src/server/gateway/config.js");
const { fileOperation } = require("../src/server/gateway/files.js");
const token = "test-only-token-longer-than-32-characters";
const config = (transport) => ({
  statePath: "/tmp/test.sqlite",
  backends: [{ id: "host", cwd: "/workspace", transport }],
});

test("configuration requires credentials, TLS, stable identities and pinned SSH host keys", () => {
  assert.throws(() => parseConfig(config({ type: "stdio" }), "short"), /32/);
  assert.throws(
    () =>
      parseConfig(
        config({ type: "websocket", url: "ws://remote.example:4500" }),
        token,
      ),
    /require wss/,
  );
  assert.throws(
    () =>
      parseConfig(
        config({ type: "websocket", url: "wss://user:secret@remote.example" }),
        token,
      ),
    /credentials/,
  );
  assert.throws(
    () =>
      parseConfig(
        config({
          type: "ssh",
          ssh: {
            host: "-oProxyCommand=oops",
            knownHostsFile: "/keys/known_hosts",
          },
        }),
        token,
      ),
    /SSH host/,
  );
  assert.throws(
    () => parseConfig(config({ type: "ssh", ssh: { host: "dev" } }), token),
    /knownHostsFile/,
  );
  const valid = parseConfig(
    {
      ...config({
        type: "ssh",
        ssh: { host: "user@dev", knownHostsFile: "/keys/known_hosts" },
      }),
      allowedOrigins: ["https://codex-ui.example.com", "https://localhost"],
    },
    token,
  );
  assert.equal(valid.backends[0].transport.type, "ssh");
  assert.ok(
    sshArguments(valid.backends[0].transport.ssh).includes(
      "StrictHostKeyChecking=yes",
    ),
  );
  assert.ok(
    sshArguments(valid.backends[0].transport.ssh).includes("BatchMode=yes"),
  );
  assert.equal(
    shellQuote("a'b $(not-a-command)"),
    "'a'\\''b $(not-a-command)'",
  );
  const companion = parseConfig(
    {
      ...config({
        type: "companion",
        agentTokenEnv: "COMPANION_TOKEN",
        command: "codex",
        args: ["app-server", "--listen", "stdio://"],
      }),
      allowedOrigins: [],
    },
    token,
  );
  assert.equal(companion.backends[0].transport.type, "companion");
});

test(
  "files use the selected host root and uploads persist without accepting traversal or symlinks",
  {
    skip:
      process.platform === "win32"
        ? "POSIX O_NOFOLLOW helper; exercised by the full Linux suite"
        : false,
  },
  async (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gateway-files-"));
    const root = path.join(dir, "project");
    fs.mkdirSync(root);
    fs.writeFileSync(path.join(dir, "outside.txt"), "outside secret");
    fs.writeFileSync(path.join(root, "inside.txt"), "inside");
    fs.symlinkSync(path.join(dir, "outside.txt"), path.join(root, "escape"));
    const backend = {
      id: "local",
      label: "Local",
      cwd: root,
      transport: { type: "stdio", command: "codex", args: [] },
    };
    t.after(() => fs.rmSync(dir, { force: true, recursive: true }));
    const listing = await fileOperation(backend, { action: "list" });
    assert.equal(listing.root, root);
    assert.deepEqual(
      listing.entries.map((e) => e.name),
      ["inside.txt"],
    );
    for (const unsafe of ["../outside.txt", "escape"])
      await assert.rejects(
        () => fileOperation(backend, { action: "read", path: unsafe }),
        /outside/,
      );
    const uploaded = await fileOperation(backend, {
      action: "upload",
      name: "../../weird;$(echo bad).txt",
      data: Buffer.from("photo bytes").toString("base64"),
    });
    assert.ok(uploaded.path.startsWith(root + "/.codex-web-uploads/"));
    assert.equal(fs.readFileSync(uploaded.path, "utf8"), "photo bytes");
    assert.equal(fs.statSync(uploaded.path).mode & 0o777, 0o600);
    const read = await fileOperation(backend, {
      action: "read",
      path: uploaded.path,
    });
    assert.equal(Buffer.from(read.data, "base64").toString(), "photo bytes");
    await assert.rejects(
      () =>
        fileOperation(
          {
            ...backend,
            transport: { type: "websocket", url: "ws://localhost" },
          },
          { action: "list" },
        ),
      /no host file channel/,
    );
  },
);
