#!/usr/bin/env node

const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");

const ipcDirectory = path.join(os.tmpdir(), "codex-ipc");
const ipcSocketPath = path.join(ipcDirectory, "ipc.sock");
fs.mkdirSync(ipcDirectory, { recursive: true });
const ipcServer = net.createServer();
ipcServer.listen(ipcSocketPath);

process.stdin.resume();
process.stdin.once("end", () => process.exit(0));
process.stdin.once("error", () => process.exit(0));

setInterval(() => undefined, 1_000).unref();
