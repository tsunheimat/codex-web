const fs = require("node:fs");
const path = require("node:path");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const { DesktopError } = require("./ipc.cjs");

// Read just the ASAR header and requested files, without extracting or loading
// installed JavaScript. Node's ASAR helper has host-dependent path semantics.
function openArchive(filename) {
  const fd = fs.openSync(filename, "r");
  try {
    const prefix = Buffer.alloc(16);
    fs.readSync(fd, prefix, 0, 16, 0);
    const headerSize = prefix.readUInt32LE(4),
      jsonSize = prefix.readUInt32LE(12);
    if (jsonSize > 32 * 1024 * 1024 || jsonSize > headerSize)
      throw new Error("Invalid ASAR header");
    const json = Buffer.alloc(jsonSize);
    fs.readSync(fd, json, 0, jsonSize, 16);
    const header = JSON.parse(json.toString());
    return {
      read(name) {
        let entry = header;
        for (const part of name.split("/")) entry = entry?.files?.[part];
        if (!entry || entry.unpacked || entry.size > 32 * 1024 * 1024)
          throw new Error(`Cannot inspect installed ${name}`);
        const data = Buffer.alloc(entry.size);
        fs.readSync(
          fd,
          data,
          0,
          entry.size,
          8 + headerSize + Number(entry.offset),
        );
        return data.toString("utf8");
      },
      list(dir) {
        let entry = header;
        for (const part of dir.split("/")) entry = entry?.files?.[part];
        return Object.keys(entry?.files ?? {});
      },
      close() {
        fs.closeSync(fd);
      },
    };
  } catch (error) {
    fs.closeSync(fd);
    throw error;
  }
}

function inspectInstallation(installation) {
  const archive = openArchive(path.join(installation, "resources", "app.asar"));
  try {
    const pkg = JSON.parse(archive.read("package.json"));
    if (pkg.name !== "openai-codex-electron")
      throw new Error("Package is not Codex Desktop");
    let versions;
    const handlers = new Set();
    for (const file of archive
      .list(".vite/build")
      .filter((name) => name.endsWith(".js"))) {
      const source = archive.read(`.vite/build/${file}`);
      if (source.includes("thread-owner-discovery")) {
        // Parse the literal version table as data; never eval installed code.
        const match = source.match(
          /\{["']thread-stream-state-changed["']:\s*\d+[^{}]{1,6000}["']thread-queued-followups-changed["']:\s*\d+\}/,
        );
        if (match) versions = JSON.parse(match[0]);
      }
      for (const method of [
        "thread-owner-discovery",
        "thread-follower-start-turn",
        "thread-follower-load-complete-history",
        "thread-follower-interrupt-turn",
        "thread-follower-command-approval-decision",
        "thread-follower-file-approval-decision",
        "thread-follower-submit-user-input",
      ])
        if (source.includes("`" + method + "`")) handlers.add(method);
    }
    if (!versions || !handlers.has("thread-follower-start-turn"))
      throw new DesktopError(
        "PROTOCOL_UNRECOGNIZED",
        `Desktop ${pkg.version}: cannot identify the follower protocol; update the bridge for this build`,
      );
    return {
      version: pkg.version,
      installation,
      versions,
      handlers: [...handlers],
    };
  } finally {
    archive.close();
  }
}

async function discoverDesktop() {
  if (process.platform !== "win32")
    throw new DesktopError(
      "WINDOWS_HOST",
      "Launch codex-web-desktop-bridge on the Windows host running Desktop",
    );
  const script =
    "$ErrorActionPreference='Stop'; $desktopPackages=@(Get-AppxPackage *Codex*); $desktopProcesses=@(Get-CimInstance Win32_Process | Where-Object { $_.Name -in @('ChatGPT.exe','Codex.exe') -and $_.CommandLine -notmatch '--type=' } | Select-Object ProcessId,ExecutablePath); @{packages=@($desktopPackages | Select-Object Version,InstallLocation); processes=$desktopProcesses} | ConvertTo-Json -Depth 4 -Compress";
  const { stdout } = await promisify(execFile)(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", script],
    { windowsHide: true, timeout: 20000, maxBuffer: 1024 * 1024 },
  );
  const found = JSON.parse(stdout.replace(/^\uFEFF/, ""));
  const candidates = [];
  for (const proc of found.processes ?? []) {
    if (!proc.ExecutablePath) continue;
    const dir = path.dirname(proc.ExecutablePath);
    if (!fs.existsSync(path.join(dir, "resources", "app.asar"))) continue;
    try {
      const info = inspectInstallation(dir);
      const pkg = (found.packages ?? []).find((p) =>
        dir.startsWith(p.InstallLocation + path.sep),
      );
      candidates.push({
        ...info,
        pid: proc.ProcessId,
        packageVersion: pkg?.Version,
      });
    } catch (error) {
      if (error instanceof DesktopError) throw error;
    }
  }
  if (!candidates.length)
    throw new DesktopError(
      "DESKTOP_NOT_FOUND",
      "No running Codex Desktop package was found. Run the bridge as the signed-in Desktop Windows user; the CLI and VS Code extension are not Desktop",
    );
  const unique = [
    ...new Map(candidates.map((c) => [c.installation, c])).values(),
  ];
  if (unique.length !== 1)
    throw new DesktopError(
      "DESKTOP_AMBIGUOUS",
      "Multiple Codex Desktop installations are running; close the unused installation",
    );
  return { ...unique[0], endpoint: "\\\\.\\pipe\\codex-ipc" };
}
module.exports = { openArchive, inspectInstallation, discoverDesktop };
