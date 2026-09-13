#!/usr/bin/env node
// Export a review-only diff and exact edit recipe without changing Desktop.
// Vendor context is limited to the changed hunks; ASAR archives stay in scratch.
const fs = require("node:fs");
const path = require("node:path");
const { createHash } = require("node:crypto");
const { spawnSync } = require("node:child_process");
const prettier = require("prettier");
const { openArchive } = require("./desktop/discovery.cjs");
const profile = require("./desktop/native/profile.cjs");
const sha = (value) => createHash("sha256").update(value).digest("hex");
async function exportReview(planDirectory, outputDirectory) {
  const directory = path.resolve(planDirectory),
    output = path.resolve(outputDirectory);
  const planBytes = fs.readFileSync(path.join(directory, "plan.json")),
    plan = JSON.parse(planBytes);
  if (
    sha(fs.readFileSync(path.join(directory, "original.asar"))) !==
      plan.originalSha256 ||
    sha(fs.readFileSync(path.join(directory, "prepared.asar"))) !==
      plan.patchedArchiveSha256
  )
    throw new Error("Review archives do not match the prepared plan");
  const before = openArchive(path.join(directory, "original.asar")),
    after = openArchive(path.join(directory, "prepared.asar"));
  const temporary = path.join(directory, "review-text");
  fs.mkdirSync(temporary, { recursive: true });
  fs.mkdirSync(output, { recursive: true });
  const normalization = {
    formatter: "prettier",
    version: prettier.version,
    parser: "babel",
    endOfLine: "lf",
  };
  const manifest = {
    schemaVersion: 1,
    purpose: "optional-compatibility-review-only",
    applied: false,
    desktopVersion: plan.desktopVersion,
    bindingId: plan.bindingId,
    originalArchiveSha256: plan.originalSha256,
    proposedArchiveSha256: plan.patchedArchiveSha256,
    localApprovalPlanSha256: sha(planBytes),
    normalization,
    sourceHashes: plan.sourceHashes,
    components: [],
  };
  const recipe = {
    schemaVersion: 1,
    desktopVersion: plan.desktopVersion,
    inputHashes: plan.sourceHashes,
    files: profile.files,
    edits: profile.edits,
    additions: [],
  };
  const chunks = [];
  try {
    for (const [index, component] of plan.components.entries()) {
      const modified = after.read(component.name);
      if (sha(modified) !== component.sha256)
        throw new Error("Component hash mismatch: " + component.name);
      const existing = Object.values(profile.files).includes(component.name);
      const original = existing ? before.read(component.name) : "";
      const normalizedBefore = existing
        ? await prettier.format(original, { parser: "babel", endOfLine: "lf" })
        : "";
      const normalizedAfter = await prettier.format(modified, {
        parser: "babel",
        endOfLine: "lf",
      });
      const a = path.join(temporary, `${index}-before.js`),
        b = path.join(temporary, `${index}-after.js`);
      fs.writeFileSync(a, normalizedBefore);
      fs.writeFileSync(b, normalizedAfter);
      const diff = spawnSync(
        "git",
        [
          "--no-pager",
          "diff",
          "--no-index",
          "--no-ext-diff",
          "--no-color",
          "--unified=3",
          a,
          b,
        ],
        { encoding: "utf8", maxBuffer: 4 * 1024 * 1024, windowsHide: true },
      );
      if (![0, 1].includes(diff.status))
        throw new Error("Cannot produce review diff");
      const lines = diff.stdout.replaceAll("\r\n", "\n").split("\n");
      const firstHunk = lines.findIndex((line) => line.startsWith("@@ "));
      if (firstHunk < 0)
        throw new Error("Prepared component has no diff: " + component.name);
      chunks.push(
        `diff --git a/${component.name} b/${component.name}\n${existing ? "" : "new file mode 100644\n"}--- ${existing ? "a/" + component.name : "/dev/null"}\n+++ b/${component.name}\n` +
          lines.slice(firstHunk).join("\n"),
      );
      manifest.components.push({
        path: component.name,
        change: existing ? "modify" : "add",
        inputSha256: existing ? sha(original) : null,
        outputSha256: component.sha256,
        normalizedInputSha256: sha(normalizedBefore),
        normalizedOutputSha256: sha(normalizedAfter),
      });
      if (!existing)
        recipe.additions.push({
          path: component.name,
          sha256: component.sha256,
          content: modified,
        });
    }
    const relayFile = ".vite/build/src-CCXHtyvY.js";
    manifest.remoteTransportEvidence = {
      file: relayFile,
      sha256: sha(before.read(relayFile)),
      symbols: ["b$.open", "S$.send", "S$.handleServerMessage", "C$", "A$"],
    };
  } finally {
    before.close();
    after.close();
  }
  const diffText = chunks.join("\n");
  manifest.reviewDiffSha256 = sha(diffText);
  fs.writeFileSync(path.join(output, "installed-files.diff"), diffText);
  fs.writeFileSync(
    path.join(output, "edits.json"),
    JSON.stringify(recipe, null, 2) + "\n",
  );
  manifest.editRecipeSha256 = sha(
    fs.readFileSync(path.join(output, "edits.json")),
  );
  fs.writeFileSync(
    path.join(output, "manifest.json"),
    JSON.stringify(manifest, null, 2) + "\n",
  );
  fs.writeFileSync(
    path.join(output, "README.md"),
    `# Optional Desktop compatibility patch — review artifacts\n\nThis is an unapplied proposal for Desktop ${plan.desktopVersion}; it is not a required dependency of the unmodified-Desktop bridge. See [the route analysis and review](../../native-adapter-review.md).\n\n- [installed-files.diff](installed-files.diff) contains every proposed changed hunk and added module. Both sides are formatted with Prettier ${prettier.version} to avoid publishing entire minified vendor bundles. **This is a review diff, not a patch to apply directly to the installed minified files.**\n- [edits.json](edits.json) is the exact hash-pinned edit recipe, including complete contents of the six added modules. It is the machine-readable representation of the proposal.\n- [manifest.json](manifest.json) records raw and normalized component hashes, archive hashes and the frozen local approval-plan hash. No account credentials or machine-specific user paths are included.\n\nThe original/proposed ASAR binaries and local approval file are not published. Applying anything to Desktop still requires separate approval, a matching installed package, and the documented rollback procedure. This publication does not grant installation approval.\n`,
  );
  return manifest;
}
if (require.main === module)
  exportReview(
    process.argv[2] ?? "scratch/native-adapter-plan",
    process.argv[3] ?? "docs/reviews/native-adapter-26.908.40834",
  )
    .then((m) =>
      console.log(
        JSON.stringify({
          components: m.components.length,
          reviewDiffSha256: m.reviewDiffSha256,
          applied: false,
        }),
      ),
    )
    .catch((e) => {
      console.error(e.message);
      process.exitCode = 1;
    });
module.exports = { exportReview };
