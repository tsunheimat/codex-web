const assert = require("node:assert/strict");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { Readable } = require("node:stream");
const test = require("node:test");
const {
  attachmentContentDisposition,
  canonicalizeBrowseRoot,
  getWorkspaceDirectoryEntries,
  resolveBoundedDirectory,
  safeDownloadName,
  WorkspaceFileAuthority,
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
  return { browseRoot, outsideRoot, temporaryRoot };
}

test("canonicalizes the configured root and fails clearly for invalid roots", async (t) => {
  const item = await fixture();
  t.after(() => fsp.rm(item.temporaryRoot, { recursive: true, force: true }));
  assert.equal(canonicalizeBrowseRoot(item.browseRoot), item.browseRoot);
  assert.throws(
    () => canonicalizeBrowseRoot(path.join(item.temporaryRoot, "missing")),
    /CODEX_WEBUI_BROWSE_ROOT does not exist/,
  );
  assert.throws(
    () => canonicalizeBrowseRoot(path.join(item.browseRoot, "a.txt")),
    /CODEX_WEBUI_BROWSE_ROOT is not a directory/,
  );
});

test("bounds directory navigation, parent paths, symlinks, and ordering", async (t) => {
  const item = await fixture();
  t.after(() => fsp.rm(item.temporaryRoot, { recursive: true, force: true }));
  const root = canonicalizeBrowseRoot(item.browseRoot);

  const allEntries = await getWorkspaceDirectoryEntries(null, false, root);
  assert.equal(allEntries.directoryPath, root);
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
    allEntries.entries.some(({ name }) => name === "escape-link"),
    false,
  );

  const directories = await getWorkspaceDirectoryEntries(null, true, root);
  assert.deepEqual(
    directories.entries.map(({ name }) => name),
    ["alpha", "zeta", ".hidden-dir"],
  );
  const nested = await getWorkspaceDirectoryEntries(
    path.join(root, "alpha", "nested"),
    true,
    root,
  );
  assert.equal(nested.parentPath, path.join(root, "alpha"));

  assert.throws(
    () => resolveBoundedDirectory(`${root}${path.sep}..`, root),
    /must not contain '\.\.'/,
  );
  assert.throws(
    () => resolveBoundedDirectory(item.outsideRoot, root),
    /outside CODEX_WEBUI_BROWSE_ROOT/,
  );
  assert.throws(
    () => resolveBoundedDirectory(path.join(root, "a.txt"), root),
    /not a directory/,
  );
  assert.throws(
    () => resolveBoundedDirectory(path.join(root, "escape-link"), root),
    /must not contain symlinks/,
  );
});

test("stores uploads under random names and resolves only allowed regular files", async (t) => {
  const item = await fixture();
  const authority = await WorkspaceFileAuthority.create(
    item.browseRoot,
    item.temporaryRoot,
  );
  t.after(() => fsp.rm(item.temporaryRoot, { recursive: true, force: true }));

  const upload = await authority.storeUpload(
    Readable.from([Buffer.from("uploaded bytes")]),
    "../../unsafe\r\nname.txt",
  );
  assert.equal(path.dirname(upload.path), authority.uploadRoot);
  assert.notEqual(path.basename(upload.path), "unsafe_name.txt");
  assert.equal(upload.label, "unsafe__name.txt");
  assert.equal(await fsp.readFile(upload.path, "utf8"), "uploaded bytes");
  assert.deepEqual(authority.resolveAllowedFile(upload.path), {
    path: upload.path,
    downloadName: "unsafe__name.txt",
    source: "upload",
  });

  const workspaceFile = path.join(item.browseRoot, "a.txt");
  assert.deepEqual(authority.resolveAllowedFile(workspaceFile), {
    path: workspaceFile,
    downloadName: "a.txt",
    source: "workspace",
  });
  assert.throws(
    () => authority.resolveAllowedFile(item.outsideRoot),
    /outside the allowed workspace and upload roots/,
  );
  assert.throws(
    () => authority.resolveAllowedFile(path.join(item.browseRoot, "alpha")),
    /not a regular file/,
  );
  assert.throws(
    () => authority.resolveAllowedFile(path.join(item.browseRoot, "missing")),
    /does not exist/,
  );
  assert.throws(
    () =>
      authority.resolveAllowedFile(
        `${item.browseRoot}${path.sep}alpha${path.sep}..${path.sep}a.txt`,
      ),
    /must not contain '\.\.'/,
  );
  assert.throws(
    () =>
      authority.resolveAllowedFile(
        path.join(item.browseRoot, "escape-link", "secret.txt"),
      ),
    /must not contain symlinks/,
  );

  const unregistered = path.join(authority.uploadRoot, "not-registered");
  await fsp.writeFile(unregistered, "unregistered");
  assert.throws(
    () => authority.resolveAllowedFile(unregistered),
    /not registered/,
  );

  const runtimeRoot = authority.runtimeRoot;
  await authority.cleanup();
  assert.equal(fs.existsSync(runtimeRoot), false);
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
