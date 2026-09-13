const { setTimeout: delay } = require("node:timers/promises");
const { discoverDesktop } = require("./discovery.cjs");
const { DesktopIpc, DesktopError } = require("./ipc.cjs");

const RETRYABLE = new Set([
  "DESKTOP_NOT_FOUND",
  "ENOENT",
  "ECONNREFUSED",
  "IPC_TIMEOUT",
  "IPC_DISCONNECTED",
]);

// Wait for the user's Desktop. This never launches a replacement execution runtime.
async function waitForDesktop({
  wait = false,
  signal,
  retryMs = 3000,
  discover = discoverDesktop,
  makeIpc = (info) => new DesktopIpc(info),
  diagnose = () => {},
} = {}) {
  let previousCode;
  for (;;) {
    signal?.throwIfAborted();
    let ipc;
    try {
      const info = await discover();
      signal?.throwIfAborted();
      ipc = makeIpc(info);
      await ipc.connect();
      signal?.throwIfAborted();
      return { info, ipc };
    } catch (error) {
      ipc?.close();
      signal?.throwIfAborted();
      if (!wait || !RETRYABLE.has(error.code)) throw error;
      if (error.code !== previousCode) {
        diagnose(
          "Waiting for Codex Desktop. Open it under this Windows account; the bridge will attach automatically.",
        );
        previousCode = error.code;
      }
      await delay(retryMs, undefined, { signal });
    }
  }
}

function checkGateway(bridge, timeoutMs = 20000) {
  if (!bridge.readOnly)
    throw new Error("Connection checks require a read-only bridge");
  return new Promise((resolve, reject) => {
    const finish = (error) => {
      clearTimeout(timer);
      bridge.off("ready", ready);
      bridge.off("fatal", fatal);
      if (error) return reject(error);
      resolve({
        gatewayAuthenticated: true,
        desktopAttached: !!bridge.session.ipc.clientId,
        desktopVersion: bridge.info.version,
        windowsPackageVersion: bridge.info.packageVersion,
        capabilities: bridge.capabilities(),
        mutationsSent: 0,
        note: "Connection verified. This check closes its connection when finished; Run keeps it available.",
      });
    };
    const ready = () =>
      finish(
        bridge.session.ipc.clientId
          ? null
          : new DesktopError(
              "IPC_DISCONNECTED",
              "Desktop disconnected during the gateway check",
            ),
      );
    const fatal = (error) => finish(error);
    const timer = setTimeout(
      () =>
        finish(
          new DesktopError(
            "GATEWAY_TIMEOUT",
            "Gateway did not accept the connection within 20 seconds; check the URL, certificate trust and WebSocket proxy route",
          ),
        ),
      timeoutMs,
    );
    bridge.once("ready", ready);
    bridge.once("fatal", fatal);
    try {
      bridge.start();
    } catch (error) {
      finish(error);
    }
  });
}

module.exports = { waitForDesktop, checkGateway };
