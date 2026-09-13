const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const http = require("node:http");
const { WebSocketServer } = require("ws");
const { AppServerConnection } = require("../src/server/gateway/connection.js");
const { MockRuntime } = require("./fixtures/gateway-runtime.cjs");

test(
  "stdio and SSH stdio initialize once and exchange structured JSON without a terminal",
  {
    skip:
      process.platform === "win32"
        ? "POSIX shell/executable SSH fixture; exercised on Linux"
        : false,
  },
  async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "gateway-wire-"));
    const script = path.join(root, "app-server.cjs");
    fs.writeFileSync(
      script,
      `const r=require('readline').createInterface({input:process.stdin});let ready=false;r.on('line',l=>{const m=JSON.parse(l);if(m.method==='initialized'){ready=true;return;}if(m.id)process.stdout.write(JSON.stringify({id:m.id,result:m.method==='initialize'?{}:{data:[{id:'thread-test',preview:ready?'connected':'not initialized'}]}})+'\\n');});`,
    );
    const ssh = path.join(root, "ssh");
    fs.writeFileSync(
      ssh,
      `#!${process.execPath}\nconst {spawn}=require('child_process');const args=process.argv.slice(2);const child=spawn('/bin/sh',['-c',args.at(-1)],{stdio:'inherit'});child.on('exit',code=>process.exit(code??1));process.on('SIGTERM',()=>child.kill());\n`,
      { mode: 0o700 },
    );
    const before = process.env.PATH;
    process.env.PATH = `${root}:${before}`;
    t.after(() => {
      process.env.PATH = before;
      fs.rmSync(root, { recursive: true, force: true });
    });
    for (const transport of [
      { type: "stdio", command: process.execPath, args: [script] },
      {
        type: "ssh",
        command: process.execPath,
        args: [script],
        ssh: {
          host: "fixture-host",
          knownHostsFile: path.join(root, "known_hosts"),
        },
      },
    ]) {
      const connection = new AppServerConnection(
        { id: "host", cwd: root, label: "Host", transport },
        1000,
      );
      try {
        await Promise.all([connection.connect(), connection.connect()]);
        const result = await connection.request("thread/list", {});
        assert.equal(result.data[0].preview, "connected");
      } finally {
        connection.close();
      }
      await assert.rejects(() => connection.connect(), /shut down/);
    }
  },
);

test(
  "SSH -W carries a WebSocket handshake to an existing runtime",
  {
    skip:
      process.platform === "win32"
        ? "POSIX executable SSH fixture; exercised on Linux"
        : false,
  },
  async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "gateway-tunnel-"));
    const runtime = await new MockRuntime().listen();
    fs.writeFileSync(
      path.join(root, "ssh"),
      `#!${process.execPath}\nconst net=require('net');const a=process.argv.slice(2);const target=a[a.indexOf('-W')+1].split(':');const s=net.connect(Number(target[1]),target[0]);s.on('error',()=>process.exit(1));process.stdin.pipe(s);s.pipe(process.stdout);s.on('close',()=>process.exit(0));\n`,
      { mode: 0o700 },
    );
    const before = process.env.PATH;
    process.env.PATH = `${root}:${before}`;
    const connection = new AppServerConnection(
      {
        id: "host",
        label: "Host",
        cwd: "/remote/project",
        transport: {
          type: "ssh-websocket",
          host: "127.0.0.1",
          port: Number(new URL(runtime.url).port),
          ssh: { host: "fixture", knownHostsFile: "/fixture/known_hosts" },
        },
      },
      1000,
    );
    t.after(async () => {
      connection.close();
      await runtime.close();
      process.env.PATH = before;
      fs.rmSync(root, { recursive: true, force: true });
    });
    const result = await connection.request("thread/start", {
      cwd: "/remote/project",
    });
    assert.equal(result.thread.id, "thread-1");
    connection.close();
    assert.equal(runtime.threads.size, 1);
  },
);

test(
  "Unix socket attachment uses the WebSocket protocol and leaves the external listener alive",
  {
    skip:
      process.platform === "win32"
        ? "Unix socket path transport; Windows named pipes are covered separately"
        : false,
  },
  async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "gateway-unix-"));
    const socketPath = path.join(root, "control.sock");
    const server = http.createServer();
    const wss = new WebSocketServer({ server });
    wss.on("error", () => {}); // The HTTP listener error is handled below.
    wss.on("connection", (socket) =>
      socket.on("message", (raw) => {
        const m = JSON.parse(String(raw));
        if (m.id)
          socket.send(
            JSON.stringify({
              id: m.id,
              result: m.method === "initialize" ? {} : { data: [] },
            }),
          );
      }),
    );
    try {
      await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(socketPath, resolve);
      });
    } catch (error) {
      wss.close();
      fs.rmSync(root, { recursive: true, force: true });
      if (error.code === "EPERM") {
        t.skip("Execution environment does not allow Unix-socket listeners");
        return;
      }
      throw error;
    }
    const connection = new AppServerConnection(
      {
        id: "desktop",
        label: "Desktop",
        cwd: root,
        transport: { type: "unix", socketPath },
      },
      1000,
    );
    t.after(async () => {
      connection.close();
      for (const s of wss.clients) s.terminate();
      wss.close();
      await new Promise((resolve) => server.close(resolve));
      fs.rmSync(root, { recursive: true, force: true });
    });
    assert.deepEqual(await connection.request("thread/list", {}), { data: [] });
    connection.close();
    assert.equal(server.listening, true);
    assert.equal(fs.existsSync(socketPath), true);
  },
);
