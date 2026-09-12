// Opt-in verification of the bridge, using read-only attachment to an existing
// conversation. Never sends a prompt, uploads a file, or performs Computer Use.
const { randomUUID } = require("node:crypto");
const { discoverDesktop } = require("./desktop/discovery.cjs");
const { DesktopIpc } = require("./desktop/ipc.cjs");
const { DesktopSession } = require("./desktop/session.cjs");
const {
  discoverNativeTools,
  NativeTools,
} = require("./desktop/native-tools.cjs");
const {
  DesktopBridge,
  CommandJournal,
  gatewayUrl,
} = require("./codex_web_desktop_bridge.cjs");
const { SessionService } = require("../src/server/gateway/service.js");
const { SessionStore } = require("../src/server/gateway/store.js");
const { createGateway } = require("../src/server/gateway/http.js");
const { desktopTlsProxy } = require("../test/fixtures/desktop-tls.cjs");
async function until(predicate) {
  const end = Date.now() + 20000;
  while (!predicate()) {
    if (Date.now() > end) throw new Error("Live bridge verification timed out");
    await new Promise((r) => setTimeout(r, 20));
  }
}
async function main() {
  const threadId =
    process.env.CODEX_WEB_DESKTOP_VERIFY_THREAD || process.env.CODEX_THREAD_ID;
  if (!threadId)
    throw new Error(
      "Set CODEX_WEB_DESKTOP_VERIFY_THREAD to an existing Desktop-owned Codex thread",
    );
  const info = await discoverDesktop(),
    ipc = new DesktopIpc(info);
  let app, proxy, bridge;
  try {
    await ipc.connect();
    const native = await discoverNativeTools();
    const session = new DesktopSession(ipc, {
      nativeTools: native ? new NativeTools(native.endpoint, threadId) : null,
    });
    const backend = {
      id: "verify-desktop",
      label: "Desktop verification",
      cwd: process.cwd(),
      transport: {
        type: "desktop",
        agentTokenEnv: "CODEX_WEB_LIVE_VERIFY_TOKEN",
      },
    };
    process.env.CODEX_WEB_LIVE_VERIFY_TOKEN = randomUUID() + randomUUID();
    const store = new SessionStore(":memory:"),
      service = new SessionService(store, [backend]);
    const config = {
      host: "127.0.0.1",
      port: 8215,
      statePath: ":memory:",
      token: randomUUID(),
      allowedOrigins: [],
      backends: [backend],
    };
    app = await createGateway(config, service);
    await app.listen({ host: "127.0.0.1", port: 0 });
    proxy = await desktopTlsProxy(app.server.address().port);
    bridge = new DesktopBridge({
      session,
      info,
      url: gatewayUrl(proxy.url),
      tlsCa: proxy.ca,
      backendId: backend.id,
      token: process.env.CODEX_WEB_LIVE_VERIFY_TOKEN,
      journal: new CommandJournal(":memory:"),
    });
    bridge.start();
    await until(
      () => bridge.ready && service.connections.get(backend.id).connected,
    );
    const headers = { authorization: `Bearer ${config.token}` };
    const attach = async (body) => {
      const response = await app.inject({
        method: "POST",
        url: "/api/v1/sessions",
        headers,
        payload: {
          backendId: backend.id,
          clientCommandId: randomUUID(),
          ...body,
        },
      });
      if (response.statusCode !== 202) throw new Error(response.body);
      const command = response.json();
      await until(() =>
        ["accepted", "failed", "unknown"].includes(
          store.command(command.id).state,
        ),
      );
      if (store.command(command.id).state !== "accepted")
        throw new Error(store.command(command.id).error);
      return store.get(command.sessionId);
    };
    const codex = await attach({ threadId });
    const epoch = service.connections.get(backend.id).epoch;
    bridge.socket.terminate();
    await until(
      () => bridge.ready && service.connections.get(backend.id).epoch !== epoch,
    );
    await until(() => store.get(codex.id).connection === "connected");
    let chatgpt = false;
    if (native) {
      const response = await app.inject({
        method: "GET",
        url: `/api/v1/backends/${backend.id}/threads?kind=chatgpt`,
        headers,
      });
      if (response.statusCode !== 200) throw new Error(response.body);
      const row = response.json().data[0];
      if (row) {
        const s = await attach({
          conversationKind: "chatgpt",
          conversationId: row.id,
        });
        chatgpt =
          s.threadId === null &&
          s.nativeConversation?.thread?.kind === "chatgpt";
      }
    }
    console.log(
      JSON.stringify(
        {
          desktopVersion: info.version,
          windowsPackageVersion: info.packageVersion,
          pid: info.pid,
          endpoint: info.endpoint,
          tlsGatewayRoundTrip: true,
          desktopOwnerSnapshot: !!codex.thread,
          codexTurnsRead: codex.thread.turns.length,
          relayReconnectRetainedLocalAttachment: !!ipc.clientId,
          nativeChatgptHistory: chatgpt,
          mutationsSent: 0,
        },
        null,
        2,
      ),
    );
  } finally {
    await bridge?.close();
    ipc.close();
    await app?.close();
    await proxy?.close();
    delete process.env.CODEX_WEB_LIVE_VERIFY_TOKEN;
  }
}
main().catch((e) => {
  console.error(e.message);
  process.exitCode = 1;
});
