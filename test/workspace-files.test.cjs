const assert = require("node:assert/strict");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { once } = require("node:events");
const { Readable } = require("node:stream");
const test = require("node:test");
const {
  attachmentContentDisposition,
  canonicalizeBrowseRoot,
  DEFAULT_UPLOAD_QUOTA_BYTES,
  parseAllowAnyProject,
  parseUploadQuotaBytes,
  resolveConfiguredBrowseRoot,
  resolveProjectBrowseRoot,
  resolveBoundedDirectory,
  safeDownloadName,
  WorkspaceFileAuthority,
  WorkspacePathError,
} = require("../src/server/workspace-files.js");

async function fixture() {
  const temporaryRoot = await fsp.mkdtemp(
    path.join(os.tmpdir(), "codex-web-workspace-files-test-"),
  );
  const browseRoot = path.join(temporaryRoot, "browse");
  const outsideRoot = path.join(temporaryRoot, "outside");
  await Promise.all([
    fsp.mkdir(path.join(browseRoot, "alpha", "nested"), { recursive: true }),
    fsp.mkdir(path.join(browseRoot, "zeta"), { recursive: true }),
    fsp.mkdir(path.join(browseRoot, ".hidden-dir"), { recursive: true }),
    fsp.mkdir(outsideRoot, { recursive: true }),
  ]);
  await Promise.all([
    fsp.writeFile(path.join(browseRoot, "a.txt"), "workspace bytes"),
    fsp.writeFile(path.join(browseRoot, ".hidden.txt"), "hidden"),
    fsp.writeFile(path.join(outsideRoot, "secret.txt"), "outside"),
  ]);
  await fsp.symlink(outsideRoot, path.join(browseRoot, "escape-link"));
  await fsp.symlink(
    path.join(outsideRoot, "secret.txt"),
    path.join(browseRoot, "escape-file"),
  );
  return { browseRoot, outsideRoot, temporaryRoot };
}

async function authorityFixture(t, quota = DEFAULT_UPLOAD_QUOTA_BYTES) {
  const item = await fixture();
  const authority = await WorkspaceFileAuthority.create(
    item.browseRoot,
    item.temporaryRoot,
    quota,
  );
  t.after(async () => {
    await authority.cleanup();
    await fsp.rm(item.temporaryRoot, { recursive: true, force: true });
  });
  return { ...item, authority };
}

async function readStream(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

async function fdCount() {
  return (await fsp.readdir("/proc/self/fd")).length;
}

async function waitFor(label, predicate, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

test("canonicalizes the configured root and fails clearly for invalid roots", async (t) => {
  const item = await fixture();
  t.after(() => fsp.rm(item.temporaryRoot, { recursive: true, force: true }));
  assert.equal(canonicalizeBrowseRoot(item.browseRoot), item.browseRoot);
  assert.throws(
    () => canonicalizeBrowseRoot(""),
    /CODEX_WEBUI_BROWSE_ROOT must not be empty/,
  );
  assert.throws(
    () => canonicalizeBrowseRoot(path.join(item.temporaryRoot, "missing")),
    /CODEX_WEBUI_BROWSE_ROOT does not exist/,
  );
  assert.throws(
    () => canonicalizeBrowseRoot(path.join(item.browseRoot, "a.txt")),
    /CODEX_WEBUI_BROWSE_ROOT is not a directory/,
  );
});

test("parses the exact default and only positive decimal safe upload quotas", () => {
  assert.equal(parseUploadQuotaBytes(undefined), 512 * 1024 * 1024);
  assert.equal(parseUploadQuotaBytes("1"), 1);
  assert.equal(parseUploadQuotaBytes("00042"), 42);
  assert.equal(
    parseUploadQuotaBytes(String(Number.MAX_SAFE_INTEGER)),
    Number.MAX_SAFE_INTEGER,
  );
  for (const invalid of [
    "",
    "0",
    "-1",
    "+1",
    "1.5",
    " 1",
    "1 ",
    "1e3",
    String(Number.MAX_SAFE_INTEGER + 1),
  ]) {
    assert.throws(
      () => parseUploadQuotaBytes(invalid),
      /positive decimal safe integer/,
      invalid,
    );
  }
});

test("parses the allow-any-project opt-in without weakening the default", () => {
  assert.equal(parseAllowAnyProject(undefined), false);
  assert.equal(parseAllowAnyProject("false"), false);
  assert.equal(parseAllowAnyProject("true"), true);

  for (const invalid of ["", "0", "1", "TRUE", "yes", " true "]) {
    assert.throws(
      () => parseAllowAnyProject(invalid),
      /CODEX_WEBUI_ALLOW_ANY_PROJECT must be true or false/,
      invalid,
    );
  }
});

test("keeps the configured browse root separate from the allow-any project root", () => {
  const homeDirectory = path.join(path.parse(process.cwd()).root, "home", "user");
  const configuredRoot = path.join(homeDirectory, "projects");

  assert.equal(
    resolveConfiguredBrowseRoot(configuredRoot, homeDirectory),
    configuredRoot,
  );
  assert.equal(
    resolveConfiguredBrowseRoot(undefined, homeDirectory),
    homeDirectory,
  );
  assert.equal(
    resolveConfiguredBrowseRoot(configuredRoot, homeDirectory),
    configuredRoot,
  );
  assert.equal(
    resolveProjectBrowseRoot(configuredRoot, homeDirectory, false),
    configuredRoot,
  );
  assert.equal(
    resolveProjectBrowseRoot(configuredRoot, homeDirectory, true),
    path.parse(path.resolve(homeDirectory)).root,
  );
});

test("picker consumes the pinned directory authority and preserves bounded ordering", async (t) => {
  const item = await authorityFixture(t);
  const { authority } = item;

  const allEntries = await authority.getWorkspaceDirectoryEntries(null, false);
  assert.equal(allEntries.directoryPath, item.browseRoot);
  assert.equal(allEntries.parentPath, null);
  assert.deepEqual(
    allEntries.entries.map(({ name, type }) => [name, type]),
    [
      ["alpha", "directory"],
      ["zeta", "directory"],
      [".hidden-dir", "directory"],
      ["a.txt", "file"],
      [".hidden.txt", "file"],
    ],
  );
  assert.equal(
    allEntries.entries.some(({ name }) => name.startsWith("escape-")),
    false,
  );

  const directories = await authority.getWorkspaceDirectoryEntries(null, true);
  assert.deepEqual(
    directories.entries.map(({ name }) => name),
    ["alpha", "zeta", ".hidden-dir"],
  );
  const nested = await authority.getWorkspaceDirectoryEntries(
    path.join(item.browseRoot, "alpha", "nested"),
    true,
  );
  assert.equal(nested.parentPath, path.join(item.browseRoot, "alpha"));

  await assert.rejects(
    authority.getWorkspaceDirectoryEntries(
      `${item.browseRoot}${path.sep}..`,
      false,
    ),
    /must not contain '\.\.'/,
  );
  await assert.rejects(
    authority.getWorkspaceDirectoryEntries(item.outsideRoot, false),
    /outside CODEX_WEBUI_BROWSE_ROOT/,
  );
  await assert.rejects(
    authority.getWorkspaceDirectoryEntries(
      path.join(item.browseRoot, "a.txt"),
      false,
    ),
    /does not exist|not a directory/,
  );
  await assert.rejects(
    authority.getWorkspaceDirectoryEntries(
      path.join(item.browseRoot, "escape-link"),
      false,
    ),
    /outside its pinned authority root/,
  );

  // This helper is deliberately retained only for strings forwarded to the
  // separate app-server process; it must keep its Phase 3 behavior.
  assert.throws(
    () =>
      resolveBoundedDirectory(
        path.join(item.browseRoot, "escape-link"),
        item.browseRoot,
      ),
    /must not contain symlinks/,
  );
  assert.throws(
    () => resolveBoundedDirectory("invalid\0path", item.browseRoot),
    /is invalid/,
  );
  assert.throws(
    () =>
      resolveBoundedDirectory(
        `${item.browseRoot}${path.sep}..`,
        item.browseRoot,
      ),
    /must not contain '\.\.'/,
  );
  assert.throws(
    () => resolveBoundedDirectory(item.outsideRoot, item.browseRoot),
    /outside CODEX_WEBUI_BROWSE_ROOT/,
  );
});

test("filesystem-root authority can browse and open an outside project", async (t) => {
  const item = await fixture();
  const filesystemRoot = path.parse(path.resolve(item.temporaryRoot)).root;
  const authority = await WorkspaceFileAuthority.create(
    filesystemRoot,
    item.temporaryRoot,
  );
  t.after(async () => {
    await authority.cleanup();
    await fsp.rm(item.temporaryRoot, { recursive: true, force: true });
  });

  const entries = await authority.getWorkspaceDirectoryEntries(
    item.outsideRoot,
    true,
  );
  assert.equal(entries.directoryPath, item.outsideRoot);

  const opened = await authority.openAllowedFile(
    path.join(item.outsideRoot, "secret.txt"),
  );
  assert.equal((await readStream(opened.stream)).toString(), "outside");
});

test("project picker can use a separate filesystem-root authority", async (t) => {
  const item = await fixture();
  const filesystemRoot = path.parse(path.resolve(item.temporaryRoot)).root;
  const authority = await WorkspaceFileAuthority.create(
    item.browseRoot,
    item.temporaryRoot,
    DEFAULT_UPLOAD_QUOTA_BYTES,
    filesystemRoot,
  );
  t.after(async () => {
    await authority.cleanup();
    await fsp.rm(item.temporaryRoot, { recursive: true, force: true });
  });

  await assert.rejects(
    authority.getWorkspaceDirectoryEntries(item.outsideRoot, true),
    /outside CODEX_WEBUI_BROWSE_ROOT/,
  );
  await assert.rejects(
    authority.openAllowedFile(path.join(item.outsideRoot, "secret.txt")),
    /outside the allowed workspace and upload roots/,
  );
  const entries = await authority.getWorkspaceDirectoryEntries(
    item.outsideRoot,
    true,
    "project",
  );
  assert.equal(entries.directoryPath, item.outsideRoot);
  assert.equal(authority.browseRoot, item.browseRoot);
  assert.equal(authority.projectBrowseRoot, filesystemRoot);
});

test("browse and picker operations stay rooted in the lifetime-pinned inode", async (t) => {
  const item = await authorityFixture(t);
  const movedRoot = path.join(item.temporaryRoot, "original-browse");
  await fsp.rename(item.browseRoot, movedRoot);
  await fsp.mkdir(item.browseRoot);
  await fsp.writeFile(
    path.join(item.browseRoot, "replacement.txt"),
    "replacement",
  );

  const entries = await item.authority.getWorkspaceDirectoryEntries(
    null,
    false,
  );
  assert.equal(
    entries.entries.some((entry) => entry.name === "a.txt"),
    true,
  );
  assert.equal(
    entries.entries.some((entry) => entry.name === "replacement.txt"),
    false,
  );

  const opened = await item.authority.openAllowedFile(
    path.join(item.browseRoot, "a.txt"),
  );
  assert.equal((await readStream(opened.stream)).toString(), "workspace bytes");
});

test("startup rejects browse root substitution between identity capture and open without leaks", async (t) => {
  const item = await fixture();
  t.after(() => fsp.rm(item.temporaryRoot, { recursive: true, force: true }));
  const baseline = await fdCount();
  const originalOpen = fsp.open;
  const originalStat = fsp.stat;
  const originalBrowseRoot = `${item.browseRoot}.original`;
  const substitutedRoot = path.join(item.temporaryRoot, "substituted-browse");
  await fsp.mkdir(substitutedRoot);
  await fsp.writeFile(
    path.join(substitutedRoot, "substituted.txt"),
    "wrong root",
  );
  let identityCaptured = false;
  let rootOpenReached = false;
  let swapped = false;
  t.after(() => {
    fsp.open = originalOpen;
    fsp.stat = originalStat;
  });

  fsp.stat = async (...arguments_) => {
    const result = await originalStat(...arguments_);
    const target = arguments_[0];
    const options = arguments_[1];
    if (
      target === item.browseRoot &&
      typeof options === "object" &&
      options !== null &&
      options.bigint === true
    ) {
      identityCaptured = true;
    }
    return result;
  };

  fsp.open = async (...arguments_) => {
    const target = arguments_[0];
    if (target === item.browseRoot && !swapped) {
      rootOpenReached = true;
      await fsp.rename(item.browseRoot, originalBrowseRoot);
      await fsp.rename(substitutedRoot, item.browseRoot);
      swapped = true;
    }
    return originalOpen(...arguments_);
  };

  const result = await WorkspaceFileAuthority.create(
    item.browseRoot,
    item.temporaryRoot,
  ).then(
    (authority) => ({ status: "fulfilled", authority }),
    (error) => ({ status: "rejected", error }),
  );
  if (result.status === "fulfilled") {
    await result.authority.cleanup();
    assert.fail("create() accepted a substituted browse root");
  }

  assert.equal(identityCaptured, true);
  assert.equal(rootOpenReached, true);
  assert.equal(swapped, true);
  assert.match(
    result.error.message,
    /CODEX_WEBUI_BROWSE_ROOT changed while its authority was pinned/,
  );
  assert.equal(await fdCount(), baseline);
  assert.deepEqual(
    (await fsp.readdir(item.temporaryRoot)).filter((entry) =>
      entry.startsWith("codex-web-runtime-"),
    ),
    [],
  );
});

test("opened workspace descriptor is consumed after deterministic pathname replacement", async (t) => {
  const item = await authorityFixture(t);
  const requestedPath = path.join(item.browseRoot, "a.txt");
  const opened = await item.authority.openAllowedFile(requestedPath);

  await fsp.rename(
    requestedPath,
    path.join(item.browseRoot, "authorized-inode.txt"),
  );
  await fsp.writeFile(requestedPath, "replacement outside decision");

  assert.equal((await readStream(opened.stream)).toString(), "workspace bytes");
  assert.equal(
    await fsp.readFile(requestedPath, "utf8"),
    "replacement outside decision",
  );
  assert.deepEqual(item.authority.getActiveDescriptorState(), {
    rootDescriptors: 3,
    readDescriptors: 0,
    uploadOperations: 0,
  });
});

test("actual-open validation rejects intermediate and final symlink escapes", async (t) => {
  const item = await authorityFixture(t);
  for (const escapedPath of [
    path.join(item.browseRoot, "escape-link", "secret.txt"),
    path.join(item.browseRoot, "escape-file"),
  ]) {
    await assert.rejects(
      item.authority.openAllowedFile(escapedPath),
      (error) =>
        error instanceof WorkspacePathError &&
        error.statusCode === 403 &&
        /outside its pinned authority root/.test(error.message),
    );
  }
  assert.equal(item.authority.getActiveDescriptorState().readDescriptors, 0);
});

test("component walk rejects a procfd link-text race that swaps in a symlink target", async (t) => {
  const item = await authorityFixture(t);
  const escapedPath = path.join(item.browseRoot, "escape-file");
  const outsideRaceFile = path.join(item.outsideRoot, "secret.txt");

  const originalOpen = fsp.open;
  const originalReadlink = fsp.readlink;
  const originalRename = fsp.rename;
  let releaseReadlink;
  let settleRaceMutation;
  let openAttempted = false;
  const readlinkBarrier = new Promise((resolve) => {
    releaseReadlink = resolve;
  });
  const raceMutation = new Promise((resolve, reject) => {
    settleRaceMutation = { resolve, reject };
  });
  t.after(() => {
    fsp.open = originalOpen;
    fsp.readlink = originalReadlink;
    fsp.rename = originalRename;
  });

  fsp.readlink = async (...arguments_) => {
    const target = arguments_[0];
    if (typeof target === "string" && target.startsWith("/proc/self/fd/")) {
      await readlinkBarrier;
    }
    return originalReadlink(...arguments_);
  };

  fsp.open = async (...arguments_) => {
    const target = arguments_[0];
    if (
      typeof target === "string" &&
      target.startsWith("/proc/self/fd/") &&
      target.endsWith(`${path.sep}escape-file`)
    ) {
      try {
        return await originalOpen(...arguments_);
      } finally {
        openAttempted = true;
        void (async () => {
          try {
            await originalRename(outsideRaceFile, escapedPath);
            settleRaceMutation.resolve();
          } catch (error) {
            settleRaceMutation.reject(error);
          } finally {
            releaseReadlink();
          }
        })();
      }
    }
    return originalOpen(...arguments_);
  };

  const openResultPromise = item.authority.openAllowedFile(escapedPath).then(
    (value) => ({ status: "fulfilled", value }),
    (error) => ({ status: "rejected", error }),
  );

  await waitFor("symlink open attempt", () => openAttempted);
  await raceMutation;
  const openResult = await openResultPromise;
  assert.equal(openResult.status, "rejected");
  assert(openResult.error instanceof WorkspacePathError);
  assert.match(
    openResult.error.message,
    /pinned authority root|does not exist|not authorized|cannot be opened/,
  );
  assert.equal(await fsp.readFile(escapedPath, "utf8"), "outside");
});

test("substituted upload discard fails closed and retains registration until authority cleanup", async (t) => {
  const item = await authorityFixture(t, 64);
  const upload = await item.authority.storeUpload(
    Readable.from([Buffer.from("uploaded bytes")]),
    "../../unsafe\r\nname.txt",
  );
  assert.equal(path.dirname(upload.path), item.authority.uploadRoot);
  assert.notEqual(path.basename(upload.path), "unsafe_name.txt");
  assert.equal(upload.label, "unsafe__name.txt");
  assert.equal(await fsp.readFile(upload.path, "utf8"), "uploaded bytes");
  assert.deepEqual(item.authority.getUploadAccounting(), {
    quotaBytes: 64,
    retainedBytes: 14,
    inFlightBytes: 0,
    totalBytes: 14,
    peakBytes: 14,
  });

  const openedUpload = await item.authority.openAllowedFile(upload.path);
  assert.equal(openedUpload.downloadName, "unsafe__name.txt");
  assert.equal(openedUpload.source, "upload");
  assert.equal(
    (await readStream(openedUpload.stream)).toString(),
    "uploaded bytes",
  );

  const originalInode = `${upload.path}.original`;
  await fsp.rename(upload.path, originalInode);
  await fsp.writeFile(upload.path, "different inode");
  await assert.rejects(
    item.authority.openAllowedFile(upload.path),
    /identity no longer matches its registration/,
  );

  await assert.rejects(
    item.authority.discardUpload(upload.path),
    (error) =>
      error instanceof WorkspacePathError &&
      error.statusCode === 403 &&
      error.message === "Registered upload cannot be safely discarded",
  );
  assert.equal(await fsp.readFile(upload.path, "utf8"), "different inode");
  assert.equal(await fsp.readFile(originalInode, "utf8"), "uploaded bytes");
  assert.deepEqual(item.authority.getUploadAccounting(), {
    quotaBytes: 64,
    retainedBytes: 14,
    inFlightBytes: 0,
    totalBytes: 14,
    peakBytes: 14,
  });

  const runtimeRoot = item.authority.runtimeRoot;
  await item.authority.cleanup();
  assert.equal(fs.existsSync(upload.path), false);
  assert.equal(fs.existsSync(originalInode), false);
  assert.equal(fs.existsSync(runtimeRoot), false);
  assert.equal(item.authority.getUploadAccounting().totalBytes, 0);
});

test("missing and symlinked registered discard paths fail with the same bounded error", async (t) => {
  const item = await authorityFixture(t, 64);
  const missing = await item.authority.storeUpload(
    Readable.from([Buffer.from("missing")]),
    "missing.bin",
  );
  const symlinked = await item.authority.storeUpload(
    Readable.from([Buffer.from("symlink")]),
    "symlink.bin",
  );
  const missingOriginal = `${missing.path}.original`;
  const symlinkOriginal = `${symlinked.path}.original`;
  await fsp.rename(missing.path, missingOriginal);
  await fsp.rename(symlinked.path, symlinkOriginal);
  await fsp.symlink(symlinkOriginal, symlinked.path);

  for (const registeredPath of [missing.path, symlinked.path]) {
    await assert.rejects(
      item.authority.discardUpload(registeredPath),
      (error) =>
        error instanceof WorkspacePathError &&
        error.statusCode === 403 &&
        error.message === "Registered upload cannot be safely discarded",
    );
  }
  assert.equal(fs.existsSync(missing.path), false);
  assert.equal((await fsp.lstat(symlinked.path)).isSymbolicLink(), true);
  assert.equal(await fsp.readFile(missingOriginal, "utf8"), "missing");
  assert.equal(await fsp.readFile(symlinkOriginal, "utf8"), "symlink");
  assert.deepEqual(item.authority.getUploadAccounting(), {
    quotaBytes: 64,
    retainedBytes: 14,
    inFlightBytes: 0,
    totalBytes: 14,
    peakBytes: 14,
  });
});

test("aggregate concurrent reservations never oversubscribe process quota", async (t) => {
  const item = await authorityFixture(t, 10);
  let releaseFirst;
  const firstMayFinish = new Promise((resolve) => {
    releaseFirst = resolve;
  });
  t.after(() => releaseFirst());
  const firstSource = Readable.from(
    (async function* () {
      yield Buffer.alloc(6, 0x61);
      await firstMayFinish;
    })(),
  );
  const firstUploadPromise = item.authority.storeUpload(
    firstSource,
    "first.bin",
  );
  await waitFor(
    "first direct upload reservation",
    () => item.authority.getUploadAccounting().inFlightBytes === 6,
  );
  assert.deepEqual(item.authority.getUploadAccounting(), {
    quotaBytes: 10,
    retainedBytes: 0,
    inFlightBytes: 6,
    totalBytes: 6,
    peakBytes: 6,
  });

  await assert.rejects(
    item.authority.storeUpload(Readable.from([Buffer.alloc(5)]), "second.bin"),
    (error) => error instanceof WorkspacePathError && error.statusCode === 413,
  );
  assert.equal(item.authority.getUploadAccounting().totalBytes, 6);
  assert.equal(item.authority.getUploadAccounting().peakBytes, 6);

  releaseFirst();
  const firstUpload = await firstUploadPromise;
  assert.equal(item.authority.getUploadAccounting().retainedBytes, 6);
  assert.deepEqual(await fsp.readdir(item.authority.uploadRoot), [
    path.basename(firstUpload.path),
  ]);
  await Promise.all([
    item.authority.discardUpload(firstUpload.path),
    item.authority.discardUpload(firstUpload.path),
  ]);
  assert.equal(item.authority.getUploadAccounting().totalBytes, 0);
  assert.deepEqual(await fsp.readdir(item.authority.uploadRoot), []);
  await item.authority.discardUpload(firstUpload.path);
  assert.equal(item.authority.getUploadAccounting().totalBytes, 0);
});

test("stream failure rolls back every byte and incomplete upload file exactly once", async (t) => {
  const item = await authorityFixture(t, 64);
  const failure = new Error("deterministic upload stream failure");
  const source = Readable.from(
    (async function* () {
      yield Buffer.alloc(7);
      throw failure;
    })(),
  );
  await assert.rejects(
    item.authority.storeUpload(source, "failed.bin"),
    failure,
  );
  assert.deepEqual(item.authority.getUploadAccounting(), {
    quotaBytes: 64,
    retainedBytes: 0,
    inFlightBytes: 0,
    totalBytes: 0,
    peakBytes: 7,
  });
  assert.deepEqual(await fsp.readdir(item.authority.uploadRoot), []);
  assert.equal(item.authority.getActiveDescriptorState().uploadOperations, 0);
});

test("rejections and destroyed reads close request descriptors and cleanup closes pinned roots", async (t) => {
  const item = await fixture();
  t.after(() => fsp.rm(item.temporaryRoot, { recursive: true, force: true }));
  const baseline = await fdCount();
  const authority = await WorkspaceFileAuthority.create(
    item.browseRoot,
    item.temporaryRoot,
  );
  assert.equal(await fdCount(), baseline + 3);

  await assert.rejects(
    authority.openAllowedFile(path.join(item.browseRoot, "escape-file")),
    /outside its pinned authority root/,
  );
  assert.equal(await fdCount(), baseline + 3);

  const opened = await authority.openAllowedFile(
    path.join(item.browseRoot, "a.txt"),
  );
  const closed = once(opened.stream, "close");
  opened.stream.destroy();
  await closed;
  assert.equal(await fdCount(), baseline + 3);
  assert.equal(authority.getActiveDescriptorState().readDescriptors, 0);

  const runtimeRoot = authority.runtimeRoot;
  await authority.cleanup();
  assert.equal(await fdCount(), baseline);
  assert.equal(fs.existsSync(runtimeRoot), false);
  assert.deepEqual(authority.getActiveDescriptorState(), {
    rootDescriptors: 0,
    readDescriptors: 0,
    uploadOperations: 0,
  });
});

test("cleanup force-closes a stalled upload descriptor without waiting for its producer", async (t) => {
  const item = await fixture();
  t.after(() => fsp.rm(item.temporaryRoot, { recursive: true, force: true }));
  const baseline = await fdCount();
  const authority = await WorkspaceFileAuthority.create(
    item.browseRoot,
    item.temporaryRoot,
    64,
  );
  let releaseProducer;
  const producerGate = new Promise((resolve) => {
    releaseProducer = resolve;
  });
  t.after(() => releaseProducer());
  const storeResult = authority
    .storeUpload(
      Readable.from(
        (async function* () {
          yield Buffer.alloc(4);
          await producerGate;
        })(),
      ),
      "stalled.bin",
    )
    .then(
      () => null,
      (error) => error,
    );
  await waitFor(
    "stalled upload reservation",
    () => authority.getUploadAccounting().inFlightBytes === 4,
  );
  const runtimeRoot = authority.runtimeRoot;
  let cleanupTimeout;
  try {
    await Promise.race([
      authority.cleanup(),
      new Promise((_, reject) => {
        cleanupTimeout = setTimeout(
          () => reject(new Error("authority cleanup stalled")),
          2_000,
        );
      }),
    ]);
  } finally {
    clearTimeout(cleanupTimeout);
  }
  assert.equal(await fdCount(), baseline);
  assert.equal(fs.existsSync(runtimeRoot), false);
  assert.equal(authority.getUploadAccounting().totalBytes, 0);
  assert.deepEqual(authority.getActiveDescriptorState(), {
    rootDescriptors: 0,
    readDescriptors: 0,
    uploadOperations: 0,
  });

  releaseProducer();
  assert(await storeResult);
});

test("sanitizes download labels and produces injection-safe content disposition", () => {
  assert.equal(safeDownloadName("../../report.txt"), "report.txt");
  assert.equal(safeDownloadName("..\\windows.txt"), "windows.txt");
  assert.equal(safeDownloadName('bad\r\n"name.txt'), "bad___name.txt");
  const disposition = attachmentContentDisposition("résumé\r\n.txt");
  assert.match(disposition, /^attachment; filename="r_sum___\.txt";/);
  assert.match(disposition, /filename\*=UTF-8''r%C3%A9sum%C3%A9__\.txt$/);
  assert.equal(disposition.includes("\r"), false);
  assert.equal(disposition.includes("\n"), false);
});
