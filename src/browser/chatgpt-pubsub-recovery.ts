const CHATGPT_STREAM_TOPIC_PREFIX = "conversation-";
const MAX_TRACKED_FRAME_LENGTH = 1024 * 1024;
const MAX_TRACKED_TOPICS = 128;
const RELAY_UNAVAILABLE_TYPE = "codex-web-relay-unavailable";

type TopicChanges = {
  activatedTopics: string[];
  deactivatedTopics: string[];
};

type RecoverySignal = {
  data: string;
  topicIds: string[];
};

type TrackerState = {
  pendingTopicsByCommandId: ReadonlyMap<number, string>;
  subscribedTopics: ReadonlySet<string>;
};

const EMPTY_CHANGES: TopicChanges = {
  activatedTopics: [],
  deactivatedTopics: [],
};

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function parseFrame(data: unknown): unknown[] | null {
  if (typeof data !== "string" || data.length > MAX_TRACKED_FRAME_LENGTH) {
    return null;
  }
  try {
    const frame: unknown = JSON.parse(data);
    return Array.isArray(frame) ? frame : null;
  } catch {
    return null;
  }
}

function canTrackTopic(
  topicId: string,
  pendingTopicsByCommandId: ReadonlyMap<number, string>,
  subscribedTopics: ReadonlySet<string>,
): boolean {
  if (
    subscribedTopics.has(topicId) ||
    [...pendingTopicsByCommandId.values()].includes(topicId)
  ) {
    return true;
  }
  return (
    new Set([
      ...pendingTopicsByCommandId.values(),
      ...subscribedTopics.values(),
    ]).size < MAX_TRACKED_TOPICS
  );
}

function commandId(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : null;
}

function streamTopicId(value: unknown): string | null {
  return typeof value === "string" &&
    value.startsWith(CHATGPT_STREAM_TOPIC_PREFIX) &&
    value.length <= 512
    ? value
    : null;
}

function sortedUnique(values: Iterable<string>): string[] {
  return [...new Set(values)].sort();
}

export class ChatGptPubsubRecoveryTracker {
  private state: TrackerState = {
    pendingTopicsByCommandId: new Map(),
    subscribedTopics: new Set(),
  };

  observeOutgoing(data: unknown): TopicChanges {
    const frame = parseFrame(data);
    if (frame === null) {
      return EMPTY_CHANGES;
    }

    const pendingTopicsByCommandId = new Map(
      this.state.pendingTopicsByCommandId,
    );
    const subscribedTopics = new Set(this.state.subscribedTopics);
    const activatedTopics: string[] = [];
    const deactivatedTopics: string[] = [];

    for (const entry of frame) {
      if (!isPlainRecord(entry) || !isPlainRecord(entry.command)) {
        continue;
      }
      const topicId = streamTopicId(entry.command.topic_id);
      if (topicId === null) {
        continue;
      }
      if (entry.command.type === "subscribe") {
        const id = commandId(entry.id);
        if (
          id === null ||
          !canTrackTopic(topicId, pendingTopicsByCommandId, subscribedTopics)
        ) {
          continue;
        }
        pendingTopicsByCommandId.set(id, topicId);
        subscribedTopics.delete(topicId);
        activatedTopics.push(topicId);
      } else if (entry.command.type === "unsubscribe") {
        for (const [id, pendingTopicId] of pendingTopicsByCommandId) {
          if (pendingTopicId === topicId) {
            pendingTopicsByCommandId.delete(id);
          }
        }
        subscribedTopics.delete(topicId);
        deactivatedTopics.push(topicId);
      }
    }

    this.state = { pendingTopicsByCommandId, subscribedTopics };
    return {
      activatedTopics: sortedUnique(activatedTopics),
      deactivatedTopics: sortedUnique(deactivatedTopics),
    };
  }

  observeIncoming(data: unknown): TopicChanges & {
    receivedStreamMessage: boolean;
  } {
    const frame = parseFrame(data);
    if (frame === null) {
      return { ...EMPTY_CHANGES, receivedStreamMessage: false };
    }

    const pendingTopicsByCommandId = new Map(
      this.state.pendingTopicsByCommandId,
    );
    const subscribedTopics = new Set(this.state.subscribedTopics);
    const deactivatedTopics: string[] = [];
    let receivedStreamMessage = false;

    const observeStreamMessage = (entry: unknown): void => {
      if (!isPlainRecord(entry)) {
        return;
      }
      const topicId = streamTopicId(entry.topic_id);
      if (
        topicId === null ||
        entry.type !== "message" ||
        !isPlainRecord(entry.payload) ||
        entry.payload.type !== "conversation-turn-stream" ||
        !isPlainRecord(entry.payload.payload)
      ) {
        return;
      }
      receivedStreamMessage = true;
      if (entry.payload.payload.type !== "done") {
        return;
      }
      subscribedTopics.delete(topicId);
      for (const [pendingId, pendingTopicId] of pendingTopicsByCommandId) {
        if (pendingTopicId === topicId) {
          pendingTopicsByCommandId.delete(pendingId);
        }
      }
      deactivatedTopics.push(topicId);
    };

    for (const entry of frame) {
      if (!isPlainRecord(entry)) {
        continue;
      }
      const id = commandId(entry.id);
      const pendingTopicId =
        id === null ? undefined : pendingTopicsByCommandId.get(id);
      if (id !== null && pendingTopicId !== undefined && "reply" in entry) {
        pendingTopicsByCommandId.delete(id);
        const reply = entry.reply;
        if (
          isPlainRecord(reply) &&
          reply.type === "subscribe" &&
          reply.topic_id === pendingTopicId &&
          typeof reply.recovered === "boolean"
        ) {
          subscribedTopics.add(pendingTopicId);
          if (reply.recovered && Array.isArray(reply.catchups)) {
            for (const catchup of reply.catchups) {
              observeStreamMessage(catchup);
            }
          }
        }
        continue;
      }
      observeStreamMessage(entry);
    }

    this.state = { pendingTopicsByCommandId, subscribedTopics };
    return {
      activatedTopics: [],
      deactivatedTopics: sortedUnique(deactivatedTopics),
      receivedStreamMessage,
    };
  }

  takeFailureSignal(): RecoverySignal | null {
    const replies = [...this.state.pendingTopicsByCommandId].map(([id]) => ({
      id,
      reply: { type: RELAY_UNAVAILABLE_TYPE },
    }));
    const messages = [...this.state.subscribedTopics].map((topicId) => ({
      type: "message",
      topic_id: topicId,
      payload: { type: RELAY_UNAVAILABLE_TYPE },
    }));
    if (replies.length === 0 && messages.length === 0) {
      return null;
    }

    const topicIds = sortedUnique([
      ...this.state.pendingTopicsByCommandId.values(),
      ...this.state.subscribedTopics,
    ]);
    this.state = {
      pendingTopicsByCommandId: new Map(),
      subscribedTopics: new Set(),
    };
    return { data: JSON.stringify([...replies, ...messages]), topicIds };
  }
}
