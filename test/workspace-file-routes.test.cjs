const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { Readable } = require("node:stream");
const test = require("node:test");
const Fastify = require("fastify");
const {
  registerWorkspaceFileRoutes,
} = require("../src/server/workspace-file-routes.js");
const {
  WORKSPACE_UPLOAD_LIMITS,
  WorkspaceFileAuthority,
} = require("../src/server/workspace-files.js");

async function serverFixture(t, uploadQuotaBytes, configureApp) {
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
    uploadQuotaBytes,
  );
  const app = Fastify({ logger: false });
  if (configureApp) {
    await configureApp({ app, authority });
  }
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

async function waitFor(label, predicate, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

function streamingMultipart(boundary, filename, bytes, waitBeforeEnding) {
  return Readable.from(
    (async function* () {
      yield Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="files"; filename="${filename}"\r\nContent-Type: application/octet-stream\r\n\r\n`,
      );
      yield bytes;
      if (waitBeforeEnding) await waitBeforeEnding;
      yield Buffer.from(`\r\n--${boundary}--\r\n`);
    })(),
  );
}

async function streamingUpload(baseUrl, filename, bytes, waitBeforeEnding) {
  const boundary = `codex-web-${randomUUID()}`;
  return fetch(`${baseUrl}/__backend/upload`, {
    method: "POST",
    headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
    body: streamingMultipart(boundary, filename, bytes, waitBeforeEnding),
    duplex: "half",
  });
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
  assert.equal(item.authority.getUploadAccounting().totalBytes, 0);

  const tooMany = await upload(
    item.baseUrl,
    Array.from({ length: WORKSPACE_UPLOAD_LIMITS.files + 1 }, (_, index) => ({
      name: `${index}.txt`,
      bytes: String(index),
    })),
  );
  assert.equal(tooMany.status, 413);
  assert.deepEqual(await fsp.readdir(item.authority.uploadRoot), []);
  assert.equal(item.authority.getUploadAccounting().totalBytes, 0);

  const withField = await upload(
    item.baseUrl,
    [{ name: "one.txt", bytes: "one" }],
    { name: "unexpected", value: "field" },
  );
  assert.notEqual(withField.status, 200);
  assert.deepEqual(await fsp.readdir(item.authority.uploadRoot), []);
  assert.equal(item.authority.getUploadAccounting().totalBytes, 0);
});

test("concurrent HTTP uploads share one quota and quota exhaustion is a bounded 413", async (t) => {
  const item = await serverFixture(t, 10);
  let releaseFirst;
  const firstEnding = new Promise((resolve) => {
    releaseFirst = resolve;
  });
  const firstResponsePromise = streamingUpload(
    item.baseUrl,
    "first.bin",
    Buffer.alloc(6, 0x61),
    firstEnding,
  );
  await waitFor(
    "first HTTP upload reservation",
    () => item.authority.getUploadAccounting().inFlightBytes === 6,
  );

  const secondResponse = await streamingUpload(
    item.baseUrl,
    "second.bin",
    Buffer.alloc(5, 0x62),
  );
  assert.equal(secondResponse.status, 413);
  const secondBody = await secondResponse.json();
  assert.deepEqual(secondBody, { error: "upload storage quota exceeded" });
  assert.equal(item.authority.getUploadAccounting().totalBytes, 6);
  assert.equal(item.authority.getUploadAccounting().peakBytes, 6);

  releaseFirst();
  const firstResponse = await firstResponsePromise;
  assert.equal(firstResponse.status, 200);
  const firstBody = await firstResponse.json();
  assert.equal(firstBody.files.length, 1);
  assert.equal(item.authority.getUploadAccounting().retainedBytes, 6);
  assert.equal((await fsp.readdir(item.authority.uploadRoot)).length, 1);

  await item.authority.discardUpload(firstBody.files[0].path);
  assert.equal(item.authority.getUploadAccounting().totalBytes, 0);
  assert.deepEqual(await fsp.readdir(item.authority.uploadRoot), []);
});

test("client request abort removes the incomplete file and releases in-flight quota", async (t) => {
  const item = await serverFixture(t, 64);
  const boundary = `codex-web-${randomUUID()}`;
  const url = new URL("/__backend/upload", item.baseUrl);
  const request = http.request({
    hostname: url.hostname,
    port: url.port,
    path: url.pathname,
    method: "POST",
    headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
  });
  request.on("error", () => undefined);
  request.write(
    `--${boundary}\r\nContent-Disposition: form-data; name="files"; filename="aborted.bin"\r\nContent-Type: application/octet-stream\r\n\r\n`,
  );
  request.write(Buffer.alloc(7, 0x61));
  await waitFor(
    "aborted request upload reservation",
    () => item.authority.getUploadAccounting().inFlightBytes === 7,
  );
  request.destroy();

  await waitFor("aborted request quota rollback", async () => {
    return (
      item.authority.getUploadAccounting().totalBytes === 0 &&
      (await fsp.readdir(item.authority.uploadRoot)).length === 0 &&
      item.authority.getActiveDescriptorState().uploadOperations === 0
    );
  });
  assert.equal(item.authority.getUploadAccounting().peakBytes, 7);
});

test("response close before a committed store returns discards the late upload", async (t) => {
  let committedPath;
  let markCommitted;
  let releaseStore;
  let markResponseClosed;
  const committed = new Promise((resolve) => {
    markCommitted = resolve;
  });
  const storeMayReturn = new Promise((resolve) => {
    releaseStore = resolve;
  });
  const responseClosed = new Promise((resolve) => {
    markResponseClosed = resolve;
  });
  t.after(() => releaseStore());

  const item = await serverFixture(t, 64, async ({ app, authority }) => {
    const storeUpload = authority.storeUpload.bind(authority);
    authority.storeUpload = async (...arguments_) => {
      const stored = await storeUpload(...arguments_);
      committedPath = stored.path;
      markCommitted();
      await storeMayReturn;
      return stored;
    };
    app.addHook("onRequest", (request, reply, done) => {
      if (request.url === "/__backend/upload") {
        reply.raw.once("close", () => markResponseClosed());
      }
      done();
    });
  });
  const boundary = `codex-web-${randomUUID()}`;
  const body = Buffer.concat([
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="files"; filename="late.bin"\r\nContent-Type: application/octet-stream\r\n\r\n`,
    ),
    Buffer.alloc(7, 0x61),
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  const url = new URL("/__backend/upload", item.baseUrl);
  const request = http.request({
    hostname: url.hostname,
    port: url.port,
    path: url.pathname,
    method: "POST",
    headers: {
      "content-length": body.byteLength,
      "content-type": `multipart/form-data; boundary=${boundary}`,
    },
  });
  request.on("error", () => undefined);
  request.end(body);

  await committed;
  assert.deepEqual(item.authority.getUploadAccounting(), {
    quotaBytes: 64,
    retainedBytes: 7,
    inFlightBytes: 0,
    totalBytes: 7,
    peakBytes: 7,
  });
  request.destroy();
  await responseClosed;
  releaseStore();

  await waitFor("late committed upload rollback", async () => {
    return (
      item.authority.getUploadAccounting().retainedBytes === 0 &&
      item.authority.getUploadAccounting().inFlightBytes === 0 &&
      item.authority.getUploadAccounting().totalBytes === 0 &&
      (await fsp.readdir(item.authority.uploadRoot)).length === 0
    );
  });
  assert.equal(fs.existsSync(committedPath), false);
  assert.equal(item.authority.getUploadAccounting().peakBytes, 7);
});

test("aborted download response closes its opened file descriptor", async (t) => {
  const item = await serverFixture(t);
  const largeFile = path.join(item.browseRoot, "large.bin");
  await fsp.writeFile(largeFile, Buffer.alloc(2 * 1024 * 1024, 0x61));
  const url = new URL(
    `/__backend/download?path=${encodeURIComponent(largeFile)}`,
    item.baseUrl,
  );

  await new Promise((resolve, reject) => {
    const request = http.get(url, (response) => {
      response.once("data", () => {
        response.destroy();
        resolve();
      });
      response.once("error", (error) => {
        if (error.code === "ECONNRESET") resolve();
        else reject(error);
      });
    });
    request.once("error", reject);
  });
  await waitFor(
    "aborted response descriptor close",
    () => item.authority.getActiveDescriptorState().readDescriptors === 0,
  );
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
