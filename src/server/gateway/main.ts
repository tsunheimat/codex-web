#!/usr/bin/env node
import { readConfig } from "./config";
import { SessionStore } from "./store";
import { SessionService } from "./service";
import { createGateway } from "./http";

async function main(): Promise<void> {
  const filename = process.argv[2] ?? process.env.CODEX_WEB_GATEWAY_CONFIG;
  if (!filename)
    throw new Error(
      "Usage: node src/server/gateway/main.js /absolute/path/gateway.json",
    );
  const config = await readConfig(filename);
  const service = new SessionService(
    new SessionStore(config.statePath),
    config.backends,
  );
  const app = await createGateway(config, service);
  try {
    await app.listen({ host: config.host, port: config.port });
  } catch (error) {
    await app.close();
    throw error;
  }
  service.start();
  console.log(`Codex Web gateway listening on ${config.host}:${config.port}`);
  let closing = false;
  const shutdown = () => {
    if (closing) return;
    closing = true;
    void app.close().then(
      () => {
        process.exitCode = 0;
      },
      () => {
        process.exitCode = 1;
      },
    );
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}
if (require.main === module)
  void main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
