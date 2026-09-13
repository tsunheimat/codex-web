#!/usr/bin/env node
const path = require("node:path");
const { copyWindowsBundle } = require("./desktop/windows-bundle.cjs");
try {
  if (
    process.argv.length !== 4 ||
    process.argv[2] !== "--output" ||
    !path.isAbsolute(process.argv[3])
  )
    throw new Error(
      "Usage: node scripts/build_windows_desktop_connector.cjs --output C:\\absolute\\empty-folder",
    );
  const root = copyWindowsBundle(
    path.resolve(__dirname, ".."),
    process.argv[3],
  );
  console.log(
    `Windows connector created at ${root}. Run scripts/windows/codex-web-desktop.ps1 there to configure it.`,
  );
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
