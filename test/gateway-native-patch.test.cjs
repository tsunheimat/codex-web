const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createHash } = require("node:crypto");
const {
  edit,
  rewriteArchive,
} = require("../scripts/prepare_desktop_native_adapter.cjs");
const { openArchive } = require("../scripts/desktop/discovery.cjs");
const profile = require("../scripts/desktop/native/profile.cjs");
const { NativeHost } = require("../scripts/desktop/native/host.cjs");
test("published review pins the prepared edit recipe and all added module bytes", () => {
  const root = path.resolve(__dirname, ".."),
    directory = path.join(root, "docs/reviews/native-adapter-26.908.40834"),
    manifest = JSON.parse(
      fs.readFileSync(path.join(directory, "manifest.json")),
    ),
    recipeBytes = fs.readFileSync(path.join(directory, "edits.json")),
    recipe = JSON.parse(recipeBytes),
    sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
  assert.equal(manifest.applied, false);
  assert.equal(sha(recipeBytes), manifest.editRecipeSha256);
  assert.equal(
    sha(fs.readFileSync(path.join(directory, "installed-files.diff"))),
    manifest.reviewDiffSha256,
  );
  assert.deepEqual(recipe.files, profile.files);
  assert.deepEqual(recipe.edits, profile.edits);
  assert.deepEqual(
    recipe.inputHashes,
    require("../scripts/desktop/native/profile-hashes.json"),
  );
  assert.equal(recipe.additions.length, 6);
  for (const addition of recipe.additions) {
    const filename = path.basename(addition.path),
      source =
        filename === "ipc.cjs"
          ? "scripts/desktop/ipc.cjs"
          : filename === "codex-web-native-renderer.mjs"
            ? "scripts/desktop/native/renderer.mjs"
            : "scripts/desktop/native/" + filename;
    // The reviewed archive is immutable. Source changes require a new proposal,
    // rather than silently presenting a stale installed-file diff for approval.
    assert.equal(sha(addition.content), addition.sha256, addition.path);
    assert.equal(
      sha(fs.readFileSync(path.join(root, source))),
      addition.sha256,
      source,
    );
    assert.equal(
      manifest.components.find((entry) => entry.path === addition.path)
        ?.outputSha256,
      addition.sha256,
    );
  }
});
test("native patch refuses missing or ambiguous lexical binding points", () => {
  assert.throws(
    () => edit("none", [{ anchor: "handler", after: "hook" }]),
    /mismatch/,
  );
  assert.throws(
    () => edit("handler handler", [{ anchor: "handler", after: "hook" }]),
    /mismatch/,
  );
  assert.equal(
    edit("handler", [{ anchor: "handler", after: ";hook()" }]),
    "handler;hook()",
  );
  assert.ok(
    profile.edits.some(
      (e) =>
        e.anchor === "createElicitation:e=>i.requestApprovalForSender(s,e)",
    ),
  );
  assert.ok(
    profile.edits.some((e) =>
      e.replacement?.includes("userCompletionMessages:p.prepared.bundle"),
    ),
  );
});
test("ASAR proposal preserves existing payloads and unpacked entries while appending the reviewed modules", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "asar-native-test-"));
  t.after(() => {
    assert.equal(path.dirname(dir), os.tmpdir());
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const header = Buffer.from(
    JSON.stringify({
      files: {
        "original.js": { size: 4, offset: "0" },
        "native.node": { size: 8, unpacked: true },
      },
    }),
  );
  const padded = Math.ceil(header.length / 4) * 4,
    prefix = Buffer.alloc(16 + padded);
  prefix.writeUInt32LE(4, 0);
  prefix.writeUInt32LE(8 + padded, 4);
  prefix.writeUInt32LE(4 + padded, 8);
  prefix.writeUInt32LE(header.length, 12);
  header.copy(prefix, 16);
  const input = Buffer.concat([prefix, Buffer.from("old;")]),
    modified = rewriteArchive(
      input,
      new Map([["binding/main.cjs", Buffer.from("module.exports={};")]]),
    );
  const file = path.join(dir, "proposal.asar");
  fs.writeFileSync(file, modified);
  const archive = openArchive(file);
  try {
    assert.equal(archive.read("original.js"), "old;");
    assert.equal(archive.read("binding/main.cjs"), "module.exports={};");
  } finally {
    archive.close();
  }
  const decoded = JSON.parse(
    modified.subarray(16, 16 + modified.readUInt32LE(12)).toString(),
  );
  assert.equal(decoded.files["native.node"].unpacked, true);
});
test("capture-updated keeps its native request scope and never guesses a Computer Use owner", () => {
  const host = new NativeHost({ renderer: async () => ({}) }),
    status = [];
  host.on("captureStatus", (value) => status.push(value));
  host.observePresentation(
    { id: 5 },
    {
      type: "computer-use-capture-updated",
      requestId: "capture-native-id",
      update: { type: "completed" },
    },
  );
  assert.equal(status[0].requestId, "capture-native-id");
  assert.equal(status[0].scope, "desktop");
  assert.equal(status[0].conversationId, undefined);
  assert.equal(host.owners.size, 0);
});
