import { currentThreadIdFromBrowserPath } from "./routes";

const CHATGPT_PUBSUB_RELAY_PATH = "/__backend/chatgpt-pubsub";
const CHATGPT_PUBSUB_RELAY_PROTOCOL_PREFIX = "codex-web-chatgpt-pubsub.";
const CHATGPT_PUBSUB_MAX_TARGET_LENGTH = 8 * 1024;
const CHATGPT_PUBSUB_RECOVERY_DELAY_MS = 35_000;
const CHATGPT_PUBSUB_RECOVERY_COOLDOWN_MS = 60_000;
const CHATGPT_PUBSUB_RECOVERY_STORAGE_KEY =
  "codex-web:chatgpt-pubsub-recovery-at";
const CHATGPT_PUBSUB_UPSTREAM_HOSTS = new Set([
  "chatgpt.com",
  "ws.chatgpt.com",
  "ws.chatgpt-staging.com",
]);

type ChatGptPubsubRelayConnection = {
  protocol: string;
  url: string;
};

const chatGptPubsubActiveTopics = new Set<string>();
let chatGptPubsubNeedsHydration = false;
let chatGptPubsubRecoveryPath: string | null = null;
let chatGptPubsubRecoveryTimer: number | null = null;
let relayInstalled = false;

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function browserSessionStorage(): Storage | null {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

function createChatGptPubsubRelayConnection(
  rawUrl: string | URL,
): ChatGptPubsubRelayConnection | null {
  let target: URL;
  try {
    target = new URL(rawUrl.toString());
  } catch {
    return null;
  }

  if (
    target.protocol !== "wss:" ||
    target.port !== "" ||
    target.username !== "" ||
    target.password !== "" ||
    target.hash !== "" ||
    !CHATGPT_PUBSUB_UPSTREAM_HOSTS.has(target.hostname) ||
    target.href.length > CHATGPT_PUBSUB_MAX_TARGET_LENGTH
  ) {
    return null;
  }

  let encodedTarget: string;
  try {
    // Keep the signed upstream URL out of the local request target and access
    // logs. The server decodes and validates this subprotocol token again.
    encodedTarget = btoa(target.href)
      .replaceAll("+", "-")
      .replaceAll("/", "_")
      .replace(/=+$/, "");
  } catch {
    return null;
  }

  const relayUrl = new URL(CHATGPT_PUBSUB_RELAY_PATH, window.location.href);
  relayUrl.protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  relayUrl.hash = "";
  relayUrl.search = "";
  return {
    protocol: `${CHATGPT_PUBSUB_RELAY_PROTOCOL_PREFIX}${encodedTarget}`,
    url: relayUrl.href,
  };
}

function cancelChatGptPubsubRecoveryTimer(): void {
  if (chatGptPubsubRecoveryTimer !== null) {
    window.clearTimeout(chatGptPubsubRecoveryTimer);
    chatGptPubsubRecoveryTimer = null;
  }
}

function readChatGptPubsubRecoveryTimestamp(): number | null {
  try {
    const raw = browserSessionStorage()?.getItem(
      CHATGPT_PUBSUB_RECOVERY_STORAGE_KEY,
    );
    if (raw === null || raw === undefined) {
      return null;
    }
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function storeChatGptPubsubRecoveryTimestamp(timestamp: number): void {
  try {
    browserSessionStorage()?.setItem(
      CHATGPT_PUBSUB_RECOVERY_STORAGE_KEY,
      String(timestamp),
    );
  } catch {
    // A blocked Session Storage must not prevent the recovery reload.
  }
}

function runChatGptPubsubHydrationRecovery(): void {
  chatGptPubsubRecoveryTimer = null;
  if (
    !chatGptPubsubNeedsHydration ||
    chatGptPubsubRecoveryPath === null ||
    window.location.pathname !== chatGptPubsubRecoveryPath
  ) {
    chatGptPubsubNeedsHydration = false;
    chatGptPubsubRecoveryPath = null;
    chatGptPubsubActiveTopics.clear();
    return;
  }

  const now = Date.now();
  const previousRecoveryAt = readChatGptPubsubRecoveryTimestamp();
  if (
    previousRecoveryAt !== null &&
    previousRecoveryAt <= now &&
    now - previousRecoveryAt < CHATGPT_PUBSUB_RECOVERY_COOLDOWN_MS
  ) {
    chatGptPubsubRecoveryTimer = window.setTimeout(
      runChatGptPubsubHydrationRecovery,
      CHATGPT_PUBSUB_RECOVERY_COOLDOWN_MS - (now - previousRecoveryAt),
    );
    return;
  }

  storeChatGptPubsubRecoveryTimestamp(now);
  console.warn(
    "[codex-web] ChatGPT pubsub did not recover; reloading the conversation",
  );
  window.location.reload();
}

function scheduleChatGptPubsubHydrationRecovery(): void {
  if (chatGptPubsubRecoveryTimer !== null) {
    return;
  }
  chatGptPubsubRecoveryTimer = window.setTimeout(
    runChatGptPubsubHydrationRecovery,
    CHATGPT_PUBSUB_RECOVERY_DELAY_MS,
  );
}

function markChatGptPubsubTransportFailed(): void {
  if (chatGptPubsubActiveTopics.size === 0) {
    return;
  }

  chatGptPubsubNeedsHydration = true;
  const currentPath = window.location.pathname;
  if (
    chatGptPubsubRecoveryPath === null ||
    (currentThreadIdFromBrowserPath(chatGptPubsubRecoveryPath) === null &&
      currentThreadIdFromBrowserPath(currentPath) !== null)
  ) {
    chatGptPubsubRecoveryPath = currentPath;
  }
  scheduleChatGptPubsubHydrationRecovery();
}

function observeChatGptPubsubCommand(data: unknown): void {
  if (typeof data !== "string") {
    return;
  }

  let commands: unknown;
  try {
    commands = JSON.parse(data);
  } catch {
    return;
  }
  if (!Array.isArray(commands)) {
    return;
  }

  for (const entry of commands) {
    if (!isPlainRecord(entry) || !isPlainRecord(entry.command)) {
      continue;
    }
    const command = entry.command;
    const topicId = command.topic_id;
    if (typeof topicId !== "string" || !topicId.startsWith("conversation-")) {
      continue;
    }
    if (command.type === "subscribe") {
      chatGptPubsubActiveTopics.add(topicId);
    } else if (command.type === "unsubscribe") {
      chatGptPubsubActiveTopics.delete(topicId);
      if (
        chatGptPubsubActiveTopics.size === 0 &&
        !chatGptPubsubNeedsHydration
      ) {
        cancelChatGptPubsubRecoveryTimer();
      }
    }
  }
}

function chatGptPubsubStreamMessages(frame: unknown): unknown[] {
  if (!Array.isArray(frame)) {
    return [];
  }

  const messages: unknown[] = [];
  for (const entry of frame) {
    messages.push(entry);
    if (
      isPlainRecord(entry) &&
      isPlainRecord(entry.reply) &&
      Array.isArray(entry.reply.catchups)
    ) {
      messages.push(...entry.reply.catchups);
    }
  }
  return messages;
}

function observeChatGptPubsubMessage(data: unknown): void {
  if (typeof data !== "string") {
    return;
  }

  let frame: unknown;
  try {
    frame = JSON.parse(data);
  } catch {
    return;
  }

  let receivedStreamMessage = false;
  for (const message of chatGptPubsubStreamMessages(frame)) {
    if (
      !isPlainRecord(message) ||
      typeof message.topic_id !== "string" ||
      !message.topic_id.startsWith("conversation-") ||
      !isPlainRecord(message.payload) ||
      message.payload.type !== "conversation-turn-stream" ||
      !isPlainRecord(message.payload.payload) ||
      typeof message.payload.payload.type !== "string"
    ) {
      continue;
    }

    receivedStreamMessage = true;
    if (message.payload.payload.type === "done") {
      chatGptPubsubActiveTopics.delete(message.topic_id);
    }
  }

  if (receivedStreamMessage) {
    chatGptPubsubNeedsHydration = false;
    chatGptPubsubRecoveryPath = null;
    cancelChatGptPubsubRecoveryTimer();
  }
}

export function installChatGptPubsubRelay(): void {
  if (relayInstalled) {
    return;
  }
  relayInstalled = true;
  const NativeWebSocket = window.WebSocket;

  class CodexWebWebSocket extends NativeWebSocket {
    private readonly relaysChatGptPubsub: boolean;

    constructor(url: string | URL, protocols?: string | string[]) {
      const relay =
        protocols === undefined
          ? createChatGptPubsubRelayConnection(url)
          : null;
      if (relay) {
        super(relay.url, relay.protocol);
      } else if (protocols === undefined) {
        super(url);
      } else {
        super(url, protocols);
      }

      this.relaysChatGptPubsub = relay !== null;
      if (this.relaysChatGptPubsub) {
        this.addEventListener("message", (event) =>
          observeChatGptPubsubMessage(event.data),
        );
        this.addEventListener("close", markChatGptPubsubTransportFailed);
        this.addEventListener("error", markChatGptPubsubTransportFailed);
      }
    }

    override send(
      data: string | ArrayBufferLike | Blob | ArrayBufferView,
    ): void {
      if (this.relaysChatGptPubsub) {
        observeChatGptPubsubCommand(data);
      }
      super.send(data);
    }
  }

  Object.defineProperty(window, "WebSocket", {
    configurable: true,
    value: CodexWebWebSocket,
    writable: true,
  });
}
