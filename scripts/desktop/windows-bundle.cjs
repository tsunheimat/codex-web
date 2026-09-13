const fs = require("node:fs");
const path = require("node:path");

// A standalone connector needs Node, ws and our bridge modules, not Electron or
// any copy of the Desktop application. Keep this explicit so no account data,
// gateway configuration, vendor bundle or proposed patch enters the package.
function copyWindowsBundle(source, destination) {
  const root = path.resolve(destination);
  if (fs.existsSync(root) && fs.readdirSync(root).length)
    throw new Error(
      "Choose an empty output directory for the Windows connector",
    );
  const files = [
    "scripts/codex_web_desktop_bridge.cjs",
    "scripts/windows/codex-web-desktop.ps1",
    "scripts/desktop/native/contract.cjs",
    ...fs
      .readdirSync(path.join(source, "scripts/desktop"))
      .filter((name) => name.endsWith(".cjs"))
      .map((name) => "scripts/desktop/" + name),
  ];
  for (const name of files) {
    const target = path.join(root, name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(path.join(source, name), target);
  }
  fs.cpSync(
    path.join(source, "node_modules/ws"),
    path.join(root, "node_modules/ws"),
    { recursive: true },
  );
  const guide = path.join(source, "docs/windows-desktop-connector.md");
  if (fs.existsSync(guide))
    fs.copyFileSync(guide, path.join(root, "README.md"));
  return root;
}

module.exports = { copyWindowsBundle };
