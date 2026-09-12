const assert = require("node:assert/strict");
const test = require("node:test");
const { EventEmitter } = require("node:events");
const { TerminalService } = require("../src/server/gateway/terminal.js");

class Viewer extends EventEmitter {
  constructor() {
    super();
    this.readyState = 1;
    this.bufferedAmount = 0;
    this.frames = [];
  }
  send(frame) {
    this.frames.push(JSON.parse(frame));
  }
  close(code) {
    this.code = code;
    this.readyState = 3;
    this.emit("close");
  }
}
test("terminal viewers detach independently, replay bounded output, and resize the same PTY", () => {
  const calls = [];
  const input = [];
  let onData;
  let killed = 0;
  const pty = {
    onData: (cb) => {
      onData = cb;
    },
    onExit() {},
    write: (v) => input.push(v),
    resize: (cols, rows) => input.push({ cols, rows }),
    kill: () => killed++,
  };
  const terminals = new TerminalService((...args) => {
    calls.push(args);
    return pty;
  });
  const backend = {
    id: "ssh",
    label: "SSH",
    cwd: "/srv/project with spaces",
    transport: {
      type: "ssh",
      ssh: { host: "dev", knownHostsFile: "/keys/known_hosts" },
    },
  };
  const first = new Viewer();
  terminals.attach(backend, first);
  onData("first output\r\n");
  first.close(1000);
  onData("x".repeat(270 * 1024));
  assert.equal(killed, 0);
  const second = new Viewer();
  terminals.attach(backend, second);
  assert.equal(calls.length, 1);
  assert.equal(second.frames[0].data.length, 256 * 1024);
  assert.equal(calls[0][0], "ssh");
  assert.ok(calls[0][1].includes("-tt"));
  assert.match(calls[0][1].at(-1), /'tmux' 'new-session' '-A'/);
  assert.match(calls[0][1].at(-1), /'\/srv\/project with spaces'/);
  second.emit("message", JSON.stringify({ type: "input", data: "\u0003" }));
  second.emit(
    "message",
    JSON.stringify({ type: "resize", cols: 120, rows: 35 }),
  );
  assert.deepEqual(input, ["\u0003", { cols: 120, rows: 35 }]);
  second.bufferedAmount = 600 * 1024;
  onData("slow viewer");
  assert.equal(second.code, 1013);
  terminals.close();
  assert.equal(killed, 1);
});
