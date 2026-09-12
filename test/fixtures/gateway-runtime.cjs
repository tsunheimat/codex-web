const { WebSocketServer } = require("ws");

class MockRuntime {
  constructor() {
    this.threads = new Map();
    this.starts = 0;
    this.responses = [];
    this.dropStartReply = false;
    this.nextThread = 1;
  }
  async listen() {
    this.server = new WebSocketServer({ port: 0, host: "127.0.0.1" });
    await new Promise((resolve) => this.server.once("listening", resolve));
    this.url = `ws://127.0.0.1:${this.server.address().port}`;
    this.server.on("connection", (socket) => {
      let initialized = false;
      socket.on("message", (raw) => {
        const m = JSON.parse(String(raw));
        const reply = (result) =>
          socket.send(JSON.stringify({ id: m.id, result }));
        if (!m.method) {
          this.responses.push(m);
          for (const t of this.threads.values())
            this.notify("serverRequest/resolved", {
              threadId: t.id,
              requestId: m.id,
            });
          return;
        }
        if (m.method === "initialize") {
          reply({ userAgent: "fixture" });
          return;
        }
        if (m.method === "initialized") {
          initialized = true;
          return;
        }
        if (!initialized) {
          socket.send(
            JSON.stringify({
              id: m.id,
              error: { code: -32600, message: "Not initialized" },
            }),
          );
          return;
        }
        if (m.method === "thread/start") {
          const thread = {
            id: `thread-${this.nextThread++}`,
            cwd: m.params.cwd,
            turns: [],
          };
          this.threads.set(thread.id, thread);
          reply({ thread });
          return;
        }
        if (m.method === "thread/list") {
          reply({ data: [...this.threads.values()], nextCursor: null });
          return;
        }
        const thread = this.threads.get(m.params.threadId);
        if (!thread) {
          socket.send(
            JSON.stringify({
              id: m.id,
              error: { code: -32600, message: "Thread not found" },
            }),
          );
          return;
        }
        if (["thread/read", "thread/resume"].includes(m.method)) {
          reply({ thread });
          return;
        }
        if (m.method === "turn/start") {
          this.starts++;
          const turn = {
            id: `turn-${this.starts}`,
            status: "inProgress",
            items: [
              {
                id: `user-${this.starts}`,
                type: "userMessage",
                content: m.params.input,
              },
            ],
          };
          thread.turns.push(turn);
          this.notify("turn/started", { threadId: thread.id, turn });
          if (this.dropStartReply) {
            socket.close();
            return;
          }
          reply({ turn });
          return;
        }
        if (m.method === "turn/interrupt") {
          this.finish(thread.id, "interrupted");
          reply({});
          return;
        }
        if (m.method === "turn/steer") {
          reply({ turnId: thread.turns.at(-1).id });
          return;
        }
        socket.send(
          JSON.stringify({
            id: m.id,
            error: { code: -32601, message: "Unsupported fixture method" },
          }),
        );
      });
    });
    return this;
  }
  notify(method, params) {
    for (const socket of this.server.clients)
      if (socket.readyState === 1)
        socket.send(JSON.stringify({ method, params }));
  }
  finish(threadId, status = "completed") {
    const turn = this.threads.get(threadId).turns.at(-1);
    turn.status = status;
    turn.items.push({
      id: `agent-${turn.id}`,
      type: "agentMessage",
      text: "Finished on the execution host.",
    });
    this.notify("turn/completed", { threadId, turn });
  }
  approval(threadId, requestId = 7) {
    for (const socket of this.server.clients)
      if (socket.readyState === 1)
        socket.send(
          JSON.stringify({
            id: requestId,
            method: "item/commandExecution/requestApproval",
            params: {
              threadId,
              turnId: this.threads.get(threadId).turns.at(-1).id,
              command: "git status",
              availableDecisions: ["accept", "decline", "cancel"],
            },
          }),
        );
  }
  async close() {
    for (const socket of this.server.clients) socket.terminate();
    await new Promise((resolve) => this.server.close(resolve));
  }
}
const waitFor = async (predicate, ms = 3000) => {
  const deadline = Date.now() + ms;
  while (!predicate()) {
    if (Date.now() > deadline)
      throw new Error("Timed out waiting for fixture condition");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};
module.exports = { MockRuntime, waitFor };
