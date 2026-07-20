const assert = require("node:assert/strict");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const Fastify = require("fastify");
const {
  registerWorkspaceFileRoutes,
} = require("../src/server/workspace-file-routes.js");
const {
  WORKSPACE_UPLOAD_LIMITS,
  WorkspaceFileAuthority,
} = require("../src/server/workspace-files.js");

async function serverFixture(t) {
  const temporaryRoot = await fsp.mkdtemp(
    path.join(os.tmpdir(), "codex-web-workspace-routes-test-"),
  );
  const browseRoot = path.join(temporaryRoot, "browse");
  const outsideRoot = path.join(temporaryRoot, "outside");
  await Promise.all([
    fsp.mkdir(path.join(browseRoot, "folder"), { recursive: true }),
    fsp.mkdir(outsideRoot, { recursive: true }),
  ]);
  const workspaceFile = path.join(browseRoot, "workspace.txt");
  const outsideFile = path.join(outsideRoot, "secret.txt");
  await Promise.all([
    fsp.writeFile(workspaceFile, "workspace endpoint bytes"),
    fsp.writeFile(outsideFile, "outside endpoint bytes"),
  ]);
  await fsp.symlink(outsideFile, path.join(browseRoot, "escape.txt"));

  const authority = await WorkspaceFileAuthority.create(
    browseRoot,
    temporaryRoot,
  );
  const app = Fastify({ logger: false });
  await registerWorkspaceFileRoutes(app, authority);
  await app.listen({ host: "127.0.0.1", port: 0 });
  const address = app.server.address();
  assert(address && typeof address !== "string");
  const baseUrl = `http://127.0.0.1:${address.port}`;
  t.after(async () => {
    await app.close();
    await fsp.rm(temporaryRoot, { recursive: true, force: true });
  });
  return {
    app,
    authority,
    baseUrl,
    browseRoot,
    outsideFile,
    temporaryRoot,
    workspaceFile,
  };
}

async function upload(baseUrl, files, field) {
  const body = new FormData();
  for (const item of files) {
    body.append("files", new Blob([item.bytes]), item.name);
  }
  if (field) {
    body.append(field.name, field.value);
  }
  return fetch(`${baseUrl}/__backend/upload`, { method: "POST", body });
}

function atFsUrl(baseUrl, filePath) {
  return `${baseUrl}/@fs${filePath
    .split(path.sep)
    .map(encodeURIComponent)
    .join("/")}`;
}

test("upload uses random storage names and download/static routes enforce authority", async (t) => {
  const item = await serverFixture(t);
  const uploadResponse = await upload(item.baseUrl, [
    { name: "../../unsafe\r\nname.txt", bytes: "upload endpoint bytes" },
  ]);
  assert.equal(uploadResponse.status, 200);
  const uploadBody = await uploadResponse.json();
  assert.equal(uploadBody.files.length, 1);
  const uploaded = uploadBody.files[0];
  assert.equal(path.dirname(uploaded.path), item.authority.uploadRoot);
  assert.match(path.basename(uploaded.path), /^[0-9a-f-]{36}$/);
  assert.equal(uploaded.label.includes("/"), false);
  assert.equal(uploaded.label.includes("\\"), false);

  const uploadedDownload = await fetch(
    `${item.baseUrl}/__backend/download?path=${encodeURIComponent(uploaded.path)}`,
  );
  assert.equal(uploadedDownload.status, 200);
  assert.equal(await uploadedDownload.text(), "upload endpoint bytes");
  assert.match(
    uploadedDownload.headers.get("content-disposition"),
    /^attachment; filename=/,
  );

  const workspaceDownload = await fetch(
    `${item.baseUrl}/__backend/download?path=${encodeURIComponent(item.workspaceFile)}`,
  );
  assert.equal(workspaceDownload.status, 200);
  assert.equal(await workspaceDownload.text(), "workspace endpoint bytes");
  assert.match(
    workspaceDownload.headers.get("content-disposition"),
    /filename="workspace\.txt"/,
  );

  const atFsPath = `/@fs${item.workspaceFile
    .split(path.sep)
    .map(encodeURIComponent)
    .join("/")}`;
  const staticResponse = await fetch(`${item.baseUrl}${atFsPath}`);
  assert.equal(staticResponse.status, 200);
  assert.equal(await staticResponse.text(), "workspace endpoint bytes");

  for (const forbiddenPath of [
    item.outsideFile,
    path.join(item.browseRoot, "folder"),
    path.join(item.browseRoot, "missing.txt"),
    path.join(item.browseRoot, "escape.txt"),
  ]) {
    const download = await fetch(
      `${item.baseUrl}/__backend/download?path=${encodeURIComponent(forbiddenPath)}`,
    );
    assert.notEqual(download.status, 200, forbiddenPath);
    const staticFile = await fetch(
      `${item.baseUrl}/@fs${forbiddenPath
        .split(path.sep)
        .map(encodeURIComponent)
        .join("/")}`,
    );
    assert.equal(staticFile.status, 404, forbiddenPath);
  }
});

test("multipart rejects per-file size, file count, fields, and excess parts", async (t) => {
  const item = await serverFixture(t);

  const oversized = await upload(item.baseUrl, [
    {
      name: "large.bin",
      bytes: Buffer.alloc(WORKSPACE_UPLOAD_LIMITS.fileSize + 1, 0x61),
    },
  ]);
  assert.equal(oversized.status, 413);
  assert.deepEqual(await fsp.readdir(item.authority.uploadRoot), []);

  const tooMany = await upload(
    item.baseUrl,
    Array.from({ length: WORKSPACE_UPLOAD_LIMITS.files + 1 }, (_, index) => ({
      name: `${index}.txt`,
      bytes: String(index),
    })),
  );
  assert.equal(tooMany.status, 413);
  assert.deepEqual(await fsp.readdir(item.authority.uploadRoot), []);

  const withField = await upload(
    item.baseUrl,
    [{ name: "one.txt", bytes: "one" }],
    { name: "unexpected", value: "field" },
  );
  assert.notEqual(withField.status, 200);
  assert.deepEqual(await fsp.readdir(item.authority.uploadRoot), []);
});

test("/@fs keeps only raster images inline and forces active content to download", async (t) => {
  const item = await serverFixture(t);
  const fixtures = [
    ["hostile\r\npage.html", "<script>globalThis.__active = true</script>"],
    ["hostile.htm", "<script>globalThis.__active = true</script>"],
    ["hostile.js", "globalThis.__active = true"],
    ["hostile.svg", '<svg onload="globalThis.__active = true"/>'],
    ["hostile.css", "body { display: none }"],
    ["hostile.pdf", "%PDF-1.4"],
    ["hostile.txt", "plain text"],
    ["hostile.md", "# markdown"],
    ["hostile.json", '{"active":true}'],
    ["hostile.unknown", "unknown"],
  ];
  await Promise.all(
    fixtures.map(([name, bytes]) =>
      fsp.writeFile(path.join(item.browseRoot, name), bytes),
    ),
  );

  for (const [name, bytes] of fixtures) {
    const response = await fetch(
      atFsUrl(item.baseUrl, path.join(item.browseRoot, name)),
    );
    assert.equal(response.status, 200, name);
    assert.equal(
      response.headers.get("content-type"),
      "application/octet-stream",
    );
    assert.match(response.headers.get("content-disposition"), /^attachment;/);
    assert.equal(
      response.headers.get("content-disposition").includes("\r"),
      false,
    );
    assert.equal(
      response.headers.get("content-disposition").includes("\n"),
      false,
    );
    assert.equal(
      response.headers.get("content-security-policy"),
      "sandbox; default-src 'none'",
    );
    assert.equal(response.headers.get("x-content-type-options"), "nosniff");
    assert.equal(await response.text(), bytes);
  }

  for (const [name, contentType] of [
    ["preview.png", "image/png"],
    ["preview.jpg", "image/jpeg"],
    ["preview.jpeg", "image/jpeg"],
    ["preview.gif", "image/gif"],
    ["preview.webp", "image/webp"],
  ]) {
    const filePath = path.join(item.browseRoot, name);
    await fsp.writeFile(filePath, Buffer.from([0x00, 0x01, 0x02]));
    const response = await fetch(atFsUrl(item.baseUrl, filePath));
    assert.equal(response.status, 200, name);
    assert.equal(response.headers.get("content-type"), contentType);
    assert.equal(response.headers.get("content-disposition"), null);
    assert.equal(
      response.headers.get("content-security-policy"),
      "sandbox; default-src 'none'",
    );
    assert.equal(response.headers.get("x-content-type-options"), "nosniff");
    assert.deepEqual(
      Buffer.from(await response.arrayBuffer()),
      Buffer.from([0, 1, 2]),
    );
  }
});

test("closing the server removes its disposable upload runtime", async (t) => {
  const item = await serverFixture(t);
  const runtimeRoot = item.authority.runtimeRoot;
  assert.equal(fs.existsSync(runtimeRoot), true);
  await item.app.close();
  assert.equal(fs.existsSync(runtimeRoot), false);
});
