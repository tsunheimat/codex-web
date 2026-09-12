import type { CapacitorConfig } from "@capacitor/cli";

const config: CapacitorConfig = {
  appId: "com.tsunheimat.codexweb",
  appName: "Codex Web",
  webDir: "scratch/gateway-web",
  // Bundle trusted assets. Never load a remote page into a privileged bridge.
  server: { androidScheme: "https" },
};
export default config;
