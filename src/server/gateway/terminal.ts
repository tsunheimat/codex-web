import { createHash } from "node:crypto";
import { type WebSocket } from "ws";
import { shellQuote, sshArguments, type Backend } from "./config";

type Terminal = { pty: any; viewers: Set<WebSocket>; tail: string };
export class TerminalService {
  private terminals = new Map<string, Terminal>();
  constructor(
    private readonly spawnPty: (
      command: string,
      args: string[],
      options: any,
    ) => any = (command, args, options) =>
      require("node-pty").spawn(command, args, options),
  ) {}
  attach(backend: Backend, socket: WebSocket, cols = 80, rows = 24): void {
    const t = backend.transport;
    if (t.type !== "stdio" && t.type !== "ssh")
      throw new Error("This connection has no terminal channel");
    const dimensions = this.dimensions(cols, rows);
    const terminalKey = `${backend.id}:${backend.cwd}`;
    let terminal = this.terminals.get(terminalKey);
    if (!terminal) {
      if (this.terminals.size >= 8)
        throw new Error("Terminal capacity exceeded");
      const name = `codex-web-${createHash("sha256")
        .update(backend.id + backend.cwd)
        .digest("hex")
        .slice(0, 16)}`;
      const tmux = ["new-session", "-A", "-s", name, "-c", backend.cwd];
      const command = t.type === "ssh" ? "ssh" : "tmux";
      const args =
        t.type === "ssh"
          ? [
              ...sshArguments(t.ssh),
              "-tt",
              t.ssh.host,
              ["tmux", ...tmux].map(shellQuote).join(" "),
            ]
          : tmux;
      const pty = this.spawnPty(command, args, {
        name: "xterm-256color",
        ...dimensions,
        ...(t.type === "stdio" ? { cwd: backend.cwd } : {}),
        env: process.env,
      });
      terminal = { pty, viewers: new Set(), tail: "" };
      this.terminals.set(terminalKey, terminal);
      const owned = terminal;
      pty.onData((data: string) => {
        owned.tail = (owned.tail + data).slice(-256 * 1024);
        for (const viewer of owned.viewers) {
          if (viewer.bufferedAmount > 512 * 1024)
            viewer.close(1013, "Terminal viewer is too slow; reconnect");
          else if (viewer.readyState === 1)
            viewer.send(JSON.stringify({ type: "output", data }));
        }
      });
      pty.onExit(() => {
        this.terminals.delete(terminalKey);
        for (const viewer of owned.viewers)
          viewer.close(1000, "Terminal detached");
      });
    }
    const current = terminal;
    current.viewers.add(socket);
    socket.send(JSON.stringify({ type: "output", data: current.tail }));
    socket.on("close", () => current.viewers.delete(socket));
    socket.on("message", (raw) => {
      try {
        const message = JSON.parse(String(raw));
        if (
          message.type === "input" &&
          typeof message.data === "string" &&
          message.data.length <= 64 * 1024
        )
          current.pty.write(message.data);
        else if (message.type === "resize") {
          const size = this.dimensions(message.cols, message.rows);
          current.pty.resize(size.cols, size.rows);
        } else socket.close(1008, "Invalid terminal message");
      } catch {
        socket.close(1008, "Invalid terminal message");
      }
    });
  }
  private dimensions(
    cols: number,
    rows: number,
  ): { cols: number; rows: number } {
    if (
      !Number.isInteger(cols) ||
      !Number.isInteger(rows) ||
      cols < 2 ||
      cols > 500 ||
      rows < 2 ||
      rows > 300
    )
      throw new Error("Invalid terminal dimensions");
    return { cols, rows };
  }
  close(): void {
    for (const terminal of this.terminals.values()) {
      for (const s of terminal.viewers) s.close();
      terminal.pty.kill();
    }
    this.terminals.clear();
  }
}
