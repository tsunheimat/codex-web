const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const ts = require("typescript");

function loadRecoveryTracker() {
  const filename = path.join(
    __dirname,
    "..",
    "src",
    "browser",
    "chatgpt-pubsub-recovery.ts",
  );
  const source = fs.readFileSync(filename, "utf8");
  const compiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
    fileName: filename,
  }).outputText;
  const module = { exports: {} };
  new Function("exports", "module", "require", compiled)(
    module.exports,
    module,
    require,
  );
  return module.exports;
}

test("pending stream subscriptions become an immediate recoverable failure", () => {
  const { ChatGptPubsubRecoveryTracker } = loadRecoveryTracker();
  const tracker = new ChatGptPubsubRecoveryTracker();

  assert.deepEqual(
    tracker.observeOutgoing(
      JSON.stringify([
        {
          id: 7,
          command: {
            type: "subscribe",
            topic_id: "conversation-turn-topic",
          },
        },
      ]),
    ),
    {
      activatedTopics: ["conversation-turn-topic"],
      deactivatedTopics: [],
    },
  );

  const failure = tracker.takeFailureSignal();
  assert.deepEqual(failure.topicIds, ["conversation-turn-topic"]);
  assert.deepEqual(JSON.parse(failure.data), [
    { id: 7, reply: { type: "codex-web-relay-unavailable" } },
  ]);
  assert.equal(tracker.takeFailureSignal(), null);
});

test("an interrupted subscribed stream emits a recoverable topic message", () => {
  const { ChatGptPubsubRecoveryTracker } = loadRecoveryTracker();
  const tracker = new ChatGptPubsubRecoveryTracker();
  tracker.observeOutgoing(
    JSON.stringify([
      {
        id: 9,
        command: { type: "subscribe", topic_id: "conversation-turn-topic" },
      },
    ]),
  );
  tracker.observeIncoming(
    JSON.stringify([
      {
        id: 9,
        reply: {
          type: "subscribe",
          topic_id: "conversation-turn-topic",
          recovered: true,
        },
      },
    ]),
  );

  const failure = tracker.takeFailureSignal();
  assert.deepEqual(failure.topicIds, ["conversation-turn-topic"]);
  assert.deepEqual(JSON.parse(failure.data), [
    {
      type: "message",
      topic_id: "conversation-turn-topic",
      payload: { type: "codex-web-relay-unavailable" },
    },
  ]);
});

test("completed and unsubscribed streams do not trigger recovery", () => {
  const { ChatGptPubsubRecoveryTracker } = loadRecoveryTracker();

  for (const terminalAction of ["done", "unsubscribe"]) {
    const tracker = new ChatGptPubsubRecoveryTracker();
    tracker.observeOutgoing(
      JSON.stringify([
        {
          id: 11,
          command: { type: "subscribe", topic_id: "conversation-turn-topic" },
        },
      ]),
    );
    if (terminalAction === "done") {
      tracker.observeIncoming(
        JSON.stringify([
          {
            type: "message",
            topic_id: "conversation-turn-topic",
            payload: {
              type: "conversation-turn-stream",
              payload: { type: "done" },
            },
          },
        ]),
      );
    } else {
      tracker.observeOutgoing(
        JSON.stringify([
          {
            id: 12,
            command: {
              type: "unsubscribe",
              topic_id: "conversation-turn-topic",
            },
          },
        ]),
      );
    }
    assert.equal(tracker.takeFailureSignal(), null, terminalAction);
  }
});

test("subscription replies follow ChatGPT's recovered catch-up contract", () => {
  const { ChatGptPubsubRecoveryTracker } = loadRecoveryTracker();

  const malformedReplyTracker = new ChatGptPubsubRecoveryTracker();
  malformedReplyTracker.observeOutgoing(
    JSON.stringify([
      {
        id: 13,
        command: { type: "subscribe", topic_id: "conversation-turn-topic" },
      },
    ]),
  );
  malformedReplyTracker.observeIncoming(
    JSON.stringify([
      {
        id: 13,
        reply: { type: "subscribe", topic_id: "conversation-turn-topic" },
      },
    ]),
  );
  assert.equal(malformedReplyTracker.takeFailureSignal(), null);

  const catchupTracker = new ChatGptPubsubRecoveryTracker();
  catchupTracker.observeOutgoing(
    JSON.stringify([
      {
        id: 14,
        command: { type: "subscribe", topic_id: "conversation-turn-topic" },
      },
    ]),
  );
  const changes = catchupTracker.observeIncoming(
    JSON.stringify([
      {
        id: 14,
        reply: {
          type: "subscribe",
          topic_id: "conversation-turn-topic",
          recovered: true,
          catchups: [
            {
              type: "message",
              topic_id: "conversation-turn-topic",
              payload: {
                type: "conversation-turn-stream",
                payload: { type: "done" },
              },
            },
          ],
        },
      },
    ]),
  );
  assert.equal(changes.receivedStreamMessage, true);
  assert.deepEqual(changes.deactivatedTopics, ["conversation-turn-topic"]);
  assert.equal(catchupTracker.takeFailureSignal(), null);
});

test("background and malformed commands cannot create recovery signals", () => {
  const { ChatGptPubsubRecoveryTracker } = loadRecoveryTracker();
  const tracker = new ChatGptPubsubRecoveryTracker();

  for (const data of [
    "not-json",
    JSON.stringify({ command: { type: "subscribe" } }),
    JSON.stringify([
      { id: 1, command: { type: "subscribe", topic_id: "conversations" } },
      {
        id: "not-a-number",
        command: {
          type: "subscribe",
          topic_id: "conversation-turn-topic",
        },
      },
    ]),
  ]) {
    assert.deepEqual(tracker.observeOutgoing(data), {
      activatedTopics: [],
      deactivatedTopics: [],
    });
  }
  assert.equal(tracker.takeFailureSignal(), null);
});

test("tracker bounds parsed frames and retained stream topics", () => {
  const { ChatGptPubsubRecoveryTracker } = loadRecoveryTracker();
  const oversizedFrameTracker = new ChatGptPubsubRecoveryTracker();
  const validCommand = JSON.stringify([
    {
      id: 1,
      command: { type: "subscribe", topic_id: "conversation-valid" },
    },
  ]);
  assert.deepEqual(
    oversizedFrameTracker.observeOutgoing(
      `${validCommand}${" ".repeat(1024 * 1024)}`,
    ),
    { activatedTopics: [], deactivatedTopics: [] },
  );
  assert.equal(oversizedFrameTracker.takeFailureSignal(), null);

  const retainedTopicTracker = new ChatGptPubsubRecoveryTracker();
  const changes = retainedTopicTracker.observeOutgoing(
    JSON.stringify(
      Array.from({ length: 140 }, (_, index) => ({
        id: index,
        command: {
          type: "subscribe",
          topic_id: `conversation-topic-${index}`,
        },
      })),
    ),
  );
  assert.equal(changes.activatedTopics.length, 128);
  const failure = retainedTopicTracker.takeFailureSignal();
  assert.equal(failure.topicIds.length, 128);
  assert.equal(failure.topicIds.includes("conversation-topic-127"), true);
  assert.equal(failure.topicIds.includes("conversation-topic-128"), false);
});
