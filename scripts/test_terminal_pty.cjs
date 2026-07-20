#!/usr/bin/env node

const { spawn } = require("node-pty");

if (process.platform === "win32") {
  console.log("Skipping PTY smoke test on Windows.");
  process.exit(0);
}

const shell = process.env.SHELL || "/bin/sh";
const terminal = spawn(shell, [], {
  cols: 100,
  cwd: process.cwd(),
  env: { ...process.env, TERM: "xterm-256color" },
  name: "xterm-256color",
  rows: 30,
});
const marker = "codex-web-pty-ready";
let output = "";

const timeout = setTimeout(() => {
  terminal.kill();
  console.error(`Timed out waiting for terminal output: ${output}`);
  process.exitCode = 1;
}, 5_000);

terminal.onData((data) => {
  output += data;
  if (!output.includes(marker)) {
    return;
  }
  clearTimeout(timeout);
  terminal.resize(120, 40);
  terminal.kill();
  console.log("node-pty terminal smoke test passed.");
});

// Keep the full marker out of the echoed command so success proves that the
// child shell executed the write, rather than merely echoing terminal input.
terminal.write("printf 'codex-web-pty-%s\\n' ready\r");
