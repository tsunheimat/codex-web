#!/usr/bin/env node
// Preparation is read-only with respect to Desktop. Apply/rollback are explicit,
// separately approved operations and refuse to run while Desktop is running.
const fs = require("node:fs");
const path = require("node:path");
const { createHash, randomUUID, randomBytes } = require("node:crypto");
const { execFileSync } = require("node:child_process");
const { discoverDesktop, openArchive } = require("./desktop/discovery.cjs");
const profile = require("./desktop/native/profile.cjs");
const hashes = require("./desktop/native/profile-hashes.json");
const { BINDING_ID } = require("./desktop/native/contract.cjs");
const sha = (data) => createHash("sha256").update(data).digest("hex");
function edit(source, changes) {
  let result = source;
  for (const change of changes) {
    if (change.prepend) {
      result = change.prepend + result;
      continue;
    }
    if (result.split(change.anchor).length - 1 !== (change.count ?? 1))
      throw new Error("Native binding anchor mismatch: " + change.anchor);
    result = result
      .split(change.anchor)
      .join(change.replacement ?? change.anchor + change.after);
  }
  return result;
}
function rewriteArchive(original, changes) {
  const headerSize = original.readUInt32LE(4),
    header = JSON.parse(
      original.subarray(16, 16 + original.readUInt32LE(12)).toString(),
    );
  const body = original.subarray(8 + headerSize),
    appended = [];
  let offset = body.length;
  for (const [name, data] of changes) {
    let node = header;
    const parts = name.split("/");
    for (const part of parts.slice(0, -1)) {
      node.files ??= {};
      node.files[part] ??= { files: {} };
      node = node.files[part];
    }
    const blocks = [];
    for (let p = 0; p < data.length; p += 4194304)
      blocks.push(sha(data.subarray(p, p + 4194304)));
    node.files ??= {};
    node.files[parts.at(-1)] = {
      size: data.length,
      offset: String(offset),
      integrity: {
        algorithm: "SHA256",
        hash: sha(data),
        blockSize: 4194304,
        blocks,
      },
    };
    offset += data.length;
    appended.push(data);
  }
  const json = Buffer.from(JSON.stringify(header)),
    padded = Math.ceil(json.length / 4) * 4,
    prefix = Buffer.alloc(16 + padded);
  prefix.writeUInt32LE(4, 0);
  prefix.writeUInt32LE(8 + padded, 4);
  prefix.writeUInt32LE(4 + padded, 8);
  prefix.writeUInt32LE(json.length, 12);
  json.copy(prefix, 16);
  return Buffer.concat([prefix, body, ...appended]);
}
async function prepare(installation, output) {
  output = path.resolve(output);
  const target = path.join(installation, "resources", "app.asar");
  if (output.startsWith(path.resolve(installation) + path.sep))
    throw new Error("Preparation output must be outside the installed Desktop");
  const archive = openArchive(target),
    changed = new Map();
  try {
    const pkg = JSON.parse(archive.read("package.json"));
    if (pkg.version !== profile.desktopVersion)
      throw new Error(
        "This patch is only for Desktop " + profile.desktopVersion,
      );
    for (const [key, name] of Object.entries(profile.files)) {
      const source = archive.read(name);
      if (sha(source) !== hashes[key])
        throw new Error(
          "Installed source hash differs from the inspected " +
            key +
            " binding",
        );
      const patched = edit(
        source,
        profile.edits.filter((e) => e.file === key),
      );
      const ts = require("typescript");
      const parsed = ts.createSourceFile(
        name,
        patched,
        ts.ScriptTarget.Latest,
        true,
        ts.ScriptKind.JS,
      );
      if (parsed.parseDiagnostics.length)
        throw new Error("Generated " + key + " patch does not parse");
      changed.set(name, Buffer.from(patched));
    }
  } finally {
    archive.close();
  }
  for (const name of ["entry.cjs", "host.cjs", "receipts.cjs", "contract.cjs"])
    changed.set(
      ".vite/build/codex-web-native/" + name,
      fs.readFileSync(path.join(__dirname, "desktop/native", name)),
    );
  changed.set(
    ".vite/build/codex-web-native/ipc.cjs",
    fs.readFileSync(path.join(__dirname, "desktop/ipc.cjs")),
  );
  changed.set(
    "webview/assets/codex-web-native-renderer.mjs",
    fs.readFileSync(path.join(__dirname, "desktop/native/renderer.mjs")),
  );
  const original = fs.readFileSync(target),
    patched = rewriteArchive(original, changed);
  fs.mkdirSync(output, { recursive: true });
  fs.writeFileSync(path.join(output, "original.asar"), original);
  fs.writeFileSync(path.join(output, "prepared.asar"), patched);
  const verify = openArchive(path.join(output, "prepared.asar"));
  try {
    for (const [name, data] of changed)
      if (sha(verify.read(name)) !== sha(data))
        throw new Error("Prepared ASAR verification failed: " + name);
  } finally {
    verify.close();
  }
  const plan = {
    schemaVersion: 1,
    bindingId: BINDING_ID,
    desktopVersion: profile.desktopVersion,
    installation: path.resolve(installation),
    target: path.resolve(target),
    originalSha256: sha(original),
    patchedArchiveSha256: sha(patched),
    sourceHashes: hashes,
    components: [...changed].map(([name, data]) => ({
      name,
      sha256: sha(data),
    })),
    edits: profile.edits,
    approvedConfigPath: path.join(
      process.env.APPDATA || "",
      "Codex",
      "codex-web-native",
      "approved.json",
    ),
    principal: `${process.env.USERDOMAIN}\\${process.env.USERNAME}`,
    requiresDesktopQuitAndRestart: true,
    installedFilesChanged: false,
    productionEnabled: false,
  };
  fs.writeFileSync(
    path.join(output, "plan.json"),
    JSON.stringify(plan, null, 2),
  );
  const planSha = sha(fs.readFileSync(path.join(output, "plan.json")));
  fs.writeFileSync(path.join(output, "plan.sha256"), planSha + "\n");
  fs.writeFileSync(
    path.join(output, "REVIEW.md"),
    `# Native adapter approval\n\nPlan SHA-256: \`${planSha}\`\n\nTarget: \`${plan.target}\`\n\nOriginal: \`${plan.originalSha256}\`\nPatched: \`${plan.patchedArchiveSha256}\`\n\nThis proposal modifies the two JavaScript bundles and adds the six adapter files listed in plan.json. It creates a private authenticated named pipe; it adds no network/debugging listener. It requires quitting and restarting the same Desktop executable. Installed files have not been changed.\n\nAfter explicit approval and quitting Desktop, run:\n\n\`node scripts/prepare_desktop_native_adapter.cjs --apply "${output}" --approval ${planSha}\`\n\nRollback after quitting Desktop:\n\n\`node scripts/prepare_desktop_native_adapter.cjs --rollback "${output}" --approval ${planSha}\`\n\nThen reopen \`${path.join(installation, "ChatGPT.exe")}\`. No alternate runtime, launch flags, authentication export, executable patch, ACL ownership takeover, or security-fuse changes are part of this proposal. OS package/integrity enforcement and live handler execution are untested until approval. If protected-package writes are denied, installation stops; it does not change package ownership or disable integrity enforcement.\n`,
  );
  return {
    output,
    planSha256: planSha,
    originalSha256: plan.originalSha256,
    patchedArchiveSha256: plan.patchedArchiveSha256,
    components: plan.components.map((c) => c.name),
    installedFilesChanged: false,
  };
}
function applyOrRollback(directory, approvedSha, rollback) {
  if (process.platform !== "win32")
    throw new Error("Installed Desktop changes must run on its Windows host");
  const raw = fs.readFileSync(path.join(directory, "plan.json"));
  if (sha(raw) !== approvedSha)
    throw new Error("Explicit approval must match this exact plan SHA-256");
  const plan = JSON.parse(raw),
    target = path.resolve(plan.target),
    root = path.resolve(plan.installation);
  if (
    target !== path.join(root, "resources", "app.asar") ||
    !path.isAbsolute(plan.approvedConfigPath)
  )
    throw new Error("Invalid reviewed target paths");
  const running = execFileSync(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "$target=Join-Path $env:CODEX_WEB_NATIVE_INSTALLATION 'ChatGPT.exe'; @(Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -eq $target }).Count",
    ],
    {
      env: { ...process.env, CODEX_WEB_NATIVE_INSTALLATION: root },
      windowsHide: true,
      encoding: "utf8",
    },
  ).trim();
  if (running !== "0")
    throw new Error(
      "Quit Desktop normally before applying or rolling back this reviewed patch",
    );
  const source = path.join(
      directory,
      rollback ? "original.asar" : "prepared.asar",
    ),
    expected = rollback ? plan.originalSha256 : plan.patchedArchiveSha256;
  if (
    sha(fs.readFileSync(source)) !== expected ||
    sha(fs.readFileSync(target)) !==
      (rollback ? plan.patchedArchiveSha256 : plan.originalSha256)
  )
    throw new Error(
      "ASAR hashes changed; refusing to overwrite unreviewed files",
    );
  fs.copyFileSync(source, target);
  if (sha(fs.readFileSync(target)) !== expected)
    throw new Error(
      "Installed copy verification failed; restore original.asar",
    );
  if (rollback) {
    if (fs.existsSync(plan.approvedConfigPath))
      fs.unlinkSync(plan.approvedConfigPath);
  } else {
    const folder = path.dirname(plan.approvedConfigPath);
    fs.mkdirSync(folder, { recursive: true });
    execFileSync(
      "icacls.exe",
      [
        folder,
        "/inheritance:r",
        "/grant:r",
        `${plan.principal}:(OI)(CI)F`,
        "SYSTEM:(OI)(CI)F",
      ],
      { windowsHide: true },
    );
    fs.writeFileSync(
      plan.approvedConfigPath,
      JSON.stringify(
        {
          enabled: true,
          bindingId: BINDING_ID,
          desktopVersion: plan.desktopVersion,
          planSha256: approvedSha,
          patchedArchiveSha256: expected,
          endpoint: "\\\\.\\pipe\\codex-web-native-" + randomUUID(),
          token: randomBytes(32).toString("hex"),
        },
        null,
        2,
      ),
      { mode: 0o600 },
    );
  }
  return {
    changed: target,
    rollback,
    restartRequired: true,
    bridgeConfig: plan.approvedConfigPath,
  };
}
async function main() {
  const args = process.argv.slice(2);
  if (["--apply", "--rollback"].includes(args[0])) {
    if (args[2] !== "--approval" || !args[3])
      throw new Error("Supply the exact reviewed plan SHA with --approval");
    return applyOrRollback(
      path.resolve(args[1]),
      args[3],
      args[0] === "--rollback",
    );
  }
  if (args[0] !== "--prepare" || !args[1])
    throw new Error(
      "Usage: --prepare OUTPUT_DIRECTORY (does not alter Desktop)",
    );
  const info = await discoverDesktop();
  return prepare(info.installation, args[1]);
}
if (require.main === module)
  main()
    .then((result) => console.log(JSON.stringify(result, null, 2)))
    .catch((error) => {
      console.error(error.message);
      process.exitCode = 1;
    });
module.exports = { prepare, edit, rewriteArchive, applyOrRollback };
