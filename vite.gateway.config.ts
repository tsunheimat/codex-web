import { defineConfig } from "vite";
import path from "node:path";

export default defineConfig({
  root: path.resolve(__dirname, "src/gateway-web"),
  base: "./",
  build: {
    outDir: path.resolve(__dirname, "scratch/gateway-web"),
    emptyOutDir: true,
  },
  server: {
    host: "127.0.0.1",
    port: 4174,
    proxy: { "/api": { target: "http://127.0.0.1:8215", ws: true } },
  },
});
