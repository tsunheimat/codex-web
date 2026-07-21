const assert = require("node:assert/strict");
const test = require("node:test");
const {
  createAuthoritativeThreadReader,
  inProgressTurnIdsFromThreadReadResponse,
} = require("../src/server/authoritative-thread-reader.js");

function response(requestId, threadId, turns) {
  return {
    type: "mcp-response",
    hostId: "local",
    message: {
      id: requestId,
      result: { thread: { id: threadId, turns } },
    },
  };
}

test("authoritative reader sends exact thread/read includeTurns request", async () => {
  const calls = [];
  const reader = createAuthoritativeThreadReader(
    async (channel, args, responseSink) => {
      calls.push({ channel, args });
      const request = args[0].request;
      responseSink("codex_desktop:message-for-view", [
        response(request.id, request.params.threadId, [
          { id: "terminal", status: "completed" },
          { id: "interrupted", status: "interrupted" },
          { id: "failed", status: "failed" },
          { id: "active", status: "inProgress" },
        ]),
      ]);
    },
    () => "request-id",
  );

  assert.deepEqual([...(await reader("thread-a"))], ["active"]);
  assert.deepEqual(calls, [
    {
      channel: "codex_desktop:message-from-view",
      args: [
        {
          type: "mcp-request",
          hostId: "local",
          request: {
            id: "codex-web-reconcile-request-id",
            method: "thread/read",
            params: { threadId: "thread-a", includeTurns: true },
          },
        },
      ],
    },
  ]);
});

test("thread/read validation rejects partial, mismatched and ambiguous snapshots", () => {
  const id = "request-id";
  const threadId = "thread-a";
  for (const invalid of [
    null,
    {},
    { type: "mcp-response", message: { id, error: { message: "no" } } },
    response("other-request", threadId, []),
    response(id, "other-thread", []),
    response(id, threadId, null),
    response(id, threadId, [{ id: "turn-a", status: "unknown" }]),
    response(id, threadId, [
      { id: "turn-a", status: "completed" },
      { id: "turn-a", status: "inProgress" },
    ]),
    response(id, threadId, [{ id: "turn/invalid", status: "completed" }]),
  ]) {
    assert.equal(
      inProgressTurnIdsFromThreadReadResponse(invalid, id, threadId),
      null,
    );
  }
});
