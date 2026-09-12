// Test-only local TLS reverse proxy. The checked-in key is not a deployment key.
const tls = require("node:tls");
const net = require("node:net");
const fs = require("node:fs");
const path = require("node:path");
async function desktopTlsProxy(port) {
  const ca = fs.readFileSync(path.join(__dirname, "desktop-tls/cert.pem"));
  const connections = new Set();
  const server = tls.createServer(
    {
      cert: ca,
      key: fs.readFileSync(path.join(__dirname, "desktop-tls/key.pem")),
    },
    (socket) => {
      const upstream = net.connect(port, "127.0.0.1", () =>
        socket.pipe(upstream).pipe(socket),
      );
      connections.add(socket);
      connections.add(upstream);
      socket.on("error", () => upstream.destroy());
      upstream.on("error", () => socket.destroy());
      socket.on("close", () => {
        connections.delete(socket);
        upstream.destroy();
      });
      upstream.on("close", () => {
        connections.delete(upstream);
        socket.destroy();
      });
    },
  );
  server.on("tlsClientError", () => {});
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    url: `wss://127.0.0.1:${server.address().port}`,
    ca,
    async close() {
      for (const c of connections) c.destroy();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
module.exports = { desktopTlsProxy };
