#!/usr/bin/env node

const fs = require("node:fs");

const networkLog = process.env.CODEX_WEB_E2E_NETWORK_LOG;
const originalFetch = globalThis.fetch;

function requestUrl(input) {
  if (typeof input === "string") {
    return input;
  }
  if (input instanceof URL) {
    return input.href;
  }
  return input?.url ?? String(input);
}

function isLoopback(urlValue) {
  try {
    const url = new URL(urlValue);
    return (
      (url.protocol === "http:" || url.protocol === "https:") &&
      (url.hostname === "127.0.0.1" || url.hostname === "localhost")
    );
  } catch {
    return false;
  }
}

globalThis.fetch = function loopbackOnlyFetch(input, init) {
  const url = requestUrl(input);
  if (isLoopback(url)) {
    return originalFetch(input, init);
  }

  if (networkLog) {
    fs.appendFileSync(networkLog, `${url}\n`, { encoding: "utf8" });
  }
  return Promise.resolve(
    new Response("{}", {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
  );
};
