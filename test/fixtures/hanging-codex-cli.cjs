#!/usr/bin/env node

process.stdin.resume();
process.stdin.once("end", () => process.exit(0));
process.stdin.once("error", () => process.exit(0));

setInterval(() => undefined, 1_000).unref();
