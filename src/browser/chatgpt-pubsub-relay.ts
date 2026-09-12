import { ChatGptPubsubRecoveryTracker } from "./chatgpt-pubsub-recovery";
import { currentConversationIdFromBrowserPath } from "./routes";

import { backendWebSocketUrl } from "./server-config";
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

  const relayUrl = backendWebSocketUrl(CHATGPT_PUBSUB_RELAY_PATH);
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

function clearChatGptPubsubHydrationRecovery(): void {
  chatGptPubsubNeedsHydration = false;
  chatGptPubsubRecoveryPath = null;
  cancelChatGptPubsubRecoveryTimer();
}

function applyChatGptPubsubTopicChanges(changes: {
  activatedTopics: readonly string[];
  deactivatedTopics: readonly string[];
}): void {
  for (const topicId of changes.activatedTopics) {
    chatGptPubsubActiveTopics.add(topicId);
  }
  for (const topicId of changes.deactivatedTopics) {
    chatGptPubsubActiveTopics.delete(topicId);
  }
  if (chatGptPubsubActiveTopics.size === 0 && !chatGptPubsubNeedsHydration) {
    cancelChatGptPubsubRecoveryTimer();
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
    (currentConversationIdFromBrowserPath(chatGptPubsubRecoveryPath) === null &&
      currentConversationIdFromBrowserPath(currentPath) !== null)
  ) {
    chatGptPubsubRecoveryPath = currentPath;
  }
  scheduleChatGptPubsubHydrationRecovery();
}

export function installChatGptPubsubRelay(): void {
  if (relayInstalled) {
    return;
  }
  relayInstalled = true;
  const NativeWebSocket = window.WebSocket;

  class CodexWebWebSocket extends NativeWebSocket {
    private readonly relaysChatGptPubsub: boolean;
    private readonly recoveryTracker = new ChatGptPubsubRecoveryTracker();

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
        this.addEventListener("message", (event) => {
          const changes = this.recoveryTracker.observeIncoming(event.data);
          applyChatGptPubsubTopicChanges(changes);
          if (changes.receivedStreamMessage) {
            clearChatGptPubsubHydrationRecovery();
          }
        });
        this.addEventListener("close", () => {
          const failure = this.recoveryTracker.takeFailureSignal();
          if (failure === null) {
            markChatGptPubsubTransportFailed();
            return;
          }

          applyChatGptPubsubTopicChanges({
            activatedTopics: [],
            deactivatedTopics: failure.topicIds,
          });
          if (chatGptPubsubActiveTopics.size === 0) {
            clearChatGptPubsubHydrationRecovery();
          }

          // This listener is installed by the constructor before ChatGPT adds
          // its own close listener. Delivering an invalid pubsub frame here
          // activates ChatGPT's built-in authoritative REST polling instead of
          // leaving a turn indefinitely suspended behind a dead relay.
          this.dispatchEvent(
            new MessageEvent("message", { data: failure.data }),
          );
        });
        this.addEventListener("error", markChatGptPubsubTransportFailed);
      }
    }

    override send(
      data: string | ArrayBufferLike | Blob | ArrayBufferView,
    ): void {
      super.send(data);
      if (this.relaysChatGptPubsub) {
        applyChatGptPubsubTopicChanges(
          this.recoveryTracker.observeOutgoing(data),
        );
      }
    }
  }

  Object.defineProperty(window, "WebSocket", {
    configurable: true,
    value: CodexWebWebSocket,
    writable: true,
  });
}
