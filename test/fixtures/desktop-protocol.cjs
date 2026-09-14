// A deterministic stand-in for the installed Desktop's codex-ipc follower bus.
// It speaks the real four-byte-length JSON framing and the versioned methods
// the bridge uses, over a Unix socket (or a Windows named pipe).
const assert = require("node:assert/strict");
const net = require("node:net");
const { FrameReader, encodeFrame } = require("../../scripts/desktop/ipc.cjs");

const versions = {
  "thread-stream-state-changed": 11,
  "thread-stream-following-changed": 1,
  "thread-stream-following-status-requested": 1,
  "thread-owner-discovery": 1,
  "thread-follower-start-turn": 2,
  "thread-follower-load-complete-history": 1,
  "thread-follower-steer-turn": 1,
  "thread-follower-interrupt-turn": 4,
  "thread-follower-command-approval-decision": 1,
  "thread-follower-file-approval-decision": 1,
  "thread-follower-submit-user-input": 1,
};

function seededHistory({ imagePath } = {}) {
  const entitiesByKey = {
    "turn:seed-turn": {
      turnId: "seed-turn",
      status: "completed",
      params: {
        input: [
          { type: "text", text: "Hello from Desktop" },
          ...(imagePath ? [{ type: "localImage", path: imagePath }] : []),
        ],
      },
      items: [
        {
          id: "seed-user",
          type: "userMessage",
          content: [
            { type: "text", text: "Hello from Desktop", text_elements: [] },
            ...(imagePath ? [{ type: "localImage", path: imagePath }] : []),
          ],
        },
        {
          id: "seed-command",
          type: "commandExecution",
          command: "dir C:\\project",
          cwd: "C:\\project",
          status: "completed",
          aggregatedOutput: "README.md\n",
          exitCode: 0,
        },
        {
          id: "seed-agent",
          type: "agentMessage",
          text: "Hi! This is the Desktop reply.",
          phase: "final_answer",
        },
      ],
    },
  };
  return {
    kind: "canonical",
    history: {
      isComplete: true,
      entitiesByKey,
      islands: [{ entries: [{ value: "turn:seed-turn" }] }],
    },
  };
}

class InstalledProtocolFixture {
  constructor(
    endpoint,
    { seedHistory = false, imagePath, autoReply = false, threadId = "owned-thread" } = {},
  ) {
    this.endpoint = endpoint;
    this.threadId = threadId;
    this.calls = [];
    this.clients = new Set();
    this.revision = 1;
    this.starts = 0;
    this.steers = 0;
    this.interrupts = 0;
    this.autoReply = autoReply;
    this.replyDelayMs = 250;
    this.timers = new Set();
    this.state = {
      id: threadId,
      title: "Desktop conversation",
      cwd: "C:\\project",
      requests: [],
      turns: [],
      turnHistory: seedHistory
        ? seededHistory({ imagePath })
        : {
            kind: "canonical",
            history: {
              isComplete: true,
              entitiesByKey: {},
              islands: [{ entries: [] }],
            },
          },
    };
    this.server = net.createServer((socket) => {
      this.clients.add(socket);
      socket.on("close", () => this.clients.delete(socket));
      socket.on("error", () => {});
      const reader = new FrameReader((message) =>
        this.receive(socket, message),
      );
      socket.on("data", (c) => reader.push(c));
    });
  }
  async listen() {
    await new Promise((r) => this.server.listen(this.endpoint, r));
    return this;
  }
  send(socket, message) {
    if (!socket.destroyed) socket.write(encodeFrame(message));
  }
  snapshot(socket) {
    this.send(socket, {
      type: "broadcast",
      sourceClientId: "desktop-owner",
      method: "thread-stream-state-changed",
      version: 11,
      params: {
        hostId: "local",
        conversationId: this.threadId,
        change: {
          type: "snapshot",
          revision: this.revision,
          conversationState: this.state,
        },
      },
    });
  }
  publish() {
    this.revision++;
    for (const c of this.clients) this.snapshot(c);
  }
  activeTurn() {
    const history = this.state.turnHistory.history;
    for (const entry of history.islands[0].entries) {
      const turn = history.entitiesByKey[entry.value];
      if (turn?.status === "inProgress") return turn;
    }
    return null;
  }
  addTurn(turnId, input) {
    const history = this.state.turnHistory.history;
    const turn = {
      turnId,
      status: "inProgress",
      params: { input },
      items: [
        {
          id: `user-${turnId}`,
          type: "userMessage",
          content: input.map((part) =>
            part.type === "text"
              ? { type: "text", text: part.text, text_elements: [] }
              : part,
          ),
        },
      ],
    };
    history.entitiesByKey[`tail:0:local:${turnId}`] = turn;
    history.islands[0].entries.push({ value: `tail:0:local:${turnId}` });
    return turn;
  }
  scheduleReply(turn, text) {
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      const item = { id: `agent-${turn.turnId}`, type: "agentMessage", text: "" };
      turn.items.push(item);
      const half = Math.ceil(text.length / 2);
      item.text = text.slice(0, half);
      this.publish();
      const stream = setTimeout(() => {
        this.timers.delete(stream);
        item.text = text;
        this.publish();
        const finish = setTimeout(() => {
          this.timers.delete(finish);
          item.phase = "final_answer";
          turn.status = "completed";
          this.publish();
        }, this.replyDelayMs);
        this.timers.add(finish);
      }, this.replyDelayMs);
      this.timers.add(stream);
    }, this.replyDelayMs);
    this.timers.add(timer);
  }
  /** Publish a pending command approval like the owner would. */
  requestApproval(request) {
    this.state.requests.push(request);
    this.publish();
  }
  receive(socket, m) {
    this.calls.push(m);
    if (
      m.type === "broadcast" &&
      m.method === "thread-stream-following-changed"
    ) {
      this.snapshot(socket);
      return;
    }
    if (m.type !== "request") return;
    assert.equal(m.version, versions[m.method] ?? 0);
    const reply = (result) =>
      this.send(socket, {
        type: "response",
        requestId: m.requestId,
        method: m.method,
        resultType: "success",
        handledByClientId: "desktop-owner",
        result,
      });
    switch (m.method) {
      case "initialize":
        assert.equal(m.sourceClientId, "initializing-client");
        reply({ clientId: "bridge-client" });
        break;
      case "thread-owner-discovery":
        assert.equal(m.params.hostId, "local");
        if (m.params.conversationId === this.threadId)
          reply({ supportsUntrustedAppInput: true });
        else
          this.send(socket, {
            type: "response",
            requestId: m.requestId,
            resultType: "error",
            error: "no-client-found",
          });
        break;
      case "thread-follower-load-complete-history":
        this.snapshot(socket);
        reply({ revision: this.revision });
        break;
      case "thread-follower-start-turn": {
        assert.equal(m.targetClientId, "desktop-owner");
        assert.equal(m.params.turnStart.request.threadId, this.threadId);
        this.starts++;
        const turnId = this.starts === 1 ? "desktop-turn" : `desktop-turn-${this.starts}`;
        const turn = this.autoReply
          ? this.addTurn(turnId, m.params.turnStart.request.input)
          : (() => {
              const t = {
                turnId: "desktop-turn",
                status: "inProgress",
                params: { input: m.params.turnStart.request.input },
                items: [],
              };
              this.state.turnHistory.history.entitiesByKey[
                "tail:0:local:desktop-turn"
              ] = t;
              this.state.turnHistory.history.islands[0].entries = [
                { value: "tail:0:local:desktop-turn" },
              ];
              return t;
            })();
        this.publish();
        const result = {
          result: { turn: { id: turn.turnId, status: "inProgress", items: [] } },
        };
        if (this.holdStart) this.releaseStart = () => reply(result);
        else reply(result);
        if (this.autoReply) {
          const prompt = m.params.turnStart.request.input.find(
            (i) => i.type === "text",
          )?.text;
          this.scheduleReply(turn, `Desktop echo: ${prompt ?? ""}`);
        }
        break;
      }
      case "thread-follower-steer-turn": {
        this.steers++;
        const turn = this.activeTurn();
        if (turn)
          turn.items.push({
            id: `steer-${this.steers}`,
            type: "userMessage",
            content: m.params.input,
          });
        this.publish();
        reply({ ok: true });
        break;
      }
      case "thread-follower-interrupt-turn": {
        this.interrupts++;
        const turn = this.activeTurn();
        if (turn) turn.status = "interrupted";
        this.publish();
        reply({ ok: true });
        break;
      }
      case "thread-follower-command-approval-decision":
        assert.equal(m.params.requestId, 42);
        this.state.requests[0].completed = true;
        this.decision = m.params.decision;
        this.publish();
        reply({ ok: true });
        break;
      default:
        throw new Error("Unexpected IPC method " + m.method);
    }
  }
  async close() {
    for (const timer of this.timers) clearTimeout(timer);
    for (const c of this.clients) c.destroy();
    await new Promise((r) => this.server.close(r));
  }
}

module.exports = { InstalledProtocolFixture, versions, seededHistory };
