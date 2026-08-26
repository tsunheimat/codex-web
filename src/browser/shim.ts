import { installChatGptPubsubRelay } from "./chatgpt-pubsub-relay";
import {
  currentThreadIdFromBrowserPath,
  mapBrowserPathToInitialRoute,
  mapMemoryPathToBrowserPath,
} from "./routes";
import {
  BACKEND_RESTART_RECOVERY_REASON,
  consumeBackendRestartRecoveryMarker,
  storeBackendRestartRecoveryMarker,
  type RendererRecoveryReason,
} from "../server/restart-recovery-marker";
import {
  downloadWorkspaceFileCopy,
  handleLocalFilePickerMessage,
  isLocalFilePickerMessage,
} from "./files";
import {
  openSelectWorkspaceRootDialog,
  type WorkspaceDirectoryEntries,
} from "./workspace-root-dialog";
import {
  decodeMessagePortData,
  encodeMessagePortData,
} from "../server/message-port-data";

type IpcListener = (event: unknown, ...args: unknown[]) => void;

type RendererToMainMessage =
  | {
      type: "renderer-bridge-ready";
      currentThreadId: string | null;
      recoveryReason: RendererRecoveryReason;
    }
  | {
      type: "ipc-renderer-invoke";
      requestId: string;
      channel: string;
      args: unknown[];
    }
  | {
      type: "ipc-renderer-post-message";
      channel: string;
      message: unknown;
      portIds: string[];
    }
  | {
      type: "message-port-message";
      portId: string;
      data: unknown;
    }
  | {
      type: "message-port-close";
      portId: string;
    }
  | {
      type: "ipc-renderer-send";
      channel: string;
      args: unknown[];
    }
  | {
      type: "workspace-directory-entries-request";
      requestId: string;
      directoryPath: string | null;
      directoriesOnly: boolean;
      scope?: "browse" | "project";
    };

type MainToRendererMessage =
  | {
      type: "ipc-main-event";
      channel: string;
      args: unknown[];
    }
  | {
      type: "ipc-renderer-invoke-result";
      requestId: string;
      ok: true;
      result: unknown;
    }
  | {
      type: "ipc-renderer-invoke-result";
      requestId: string;
      ok: false;
      errorMessage: string;
    }
  | {
      type: "workspace-directory-entries-result";
      requestId: string;
      ok: true;
      result: WorkspaceDirectoryEntries;
    }
  | {
      type: "workspace-directory-entries-result";
      requestId: string;
      ok: false;
      errorMessage: string;
    }
  | {
      type: "message-port-message";
      portId: string;
      data: unknown;
    }
  | {
      type: "message-port-close";
      portId: string;
    };

type BridgeServerFrame =
  | {
      type: "bridge-ready";
      connectionId: string;
      serverEpoch: string;
    }
  | {
      type: "bridge-data";
      id: number;
      ack: number;
      message: MainToRendererMessage;
    }
  | { type: "bridge-ack"; ack: number }
  | { type: "bridge-replay-request"; ack: number }
  | { type: "bridge-keepalive" }
  | { type: "bridge-reset"; reason: string };

type OutgoingBridgeMessage = {
  id: number;
  message: RendererToMainMessage;
  byteLength: number;
};

const BRIDGE_PROTOCOL_VERSION = 2;
const RECONNECT_DELAY_MS = 1_000;
const SOCKET_TIMEOUT_MS = 20_000;
const MAX_UNACKED_BYTES = 64 * 1024 * 1_024;
const MAX_IN_FLIGHT_BYTES = 256 * 1024;

type MemoryNavigationChange = {
  action: "POP" | "PUSH" | "REPLACE";
  delta: number;
  location: {
    hash: string;
    key: string;
    pathname: string;
    search: string;
    state: unknown;
  };
};

type ElectronAppInfo = {
  appBrand: "codex";
  appIconMedium: null;
  appName: string;
  buildFlavor: string;
  buildNumber: null;
  dockIconPreviews: null;
  osName: string;
  systemVersion: null;
  version: string;
};

type ElectronWorkspaceFiles = {
  downloadCopy?: (args: { hostId: string; path: string }) => Promise<void>;
  getDownloadsFolderIcon?: () => Promise<string>;
};

type StatsigGateEvaluation = {
  name: string;
  value: boolean;
  [key: string]: unknown;
};

type ElectronShimState = {
  initialRoute?: string;
  initialSidebarState?: boolean;
  closeSidebar?: () => void;
  services?: {
    appInfo?: {
      get: () => Promise<ElectronAppInfo>;
    };
    workspaceFiles?: ElectronWorkspaceFiles;
    requestUserInputAutoResolution?: {
      recordConversationActivity?: (args: {
        conversationId: string;
        hostId: string;
      }) => void;
      setConversationPresented?: (args: {
        conversationId: string;
        hostId: string;
        presented: boolean;
      }) => void;
      snooze?: (args: {
        conversationId: string;
        hostId: string;
        requestId: string;
      }) => void;
    };
  };
  onMemoryNavigationChanged?: (navigation: MemoryNavigationChange) => void;
  overrideAdapter?: {
    getGateOverride?: (
      evaluation: StatsigGateEvaluation,
      ...args: unknown[]
    ) => StatsigGateEvaluation | null;
  };
};

declare global {
  interface Window {
    __ELECTRON_SHIM__?: ElectronShimState;
  }
}

declare const __CODEX_APP_VERSION__: string;

installChatGptPubsubRelay();

let requestCounter = 0;
let socket: WebSocket | null = null;
let reconnectTimeoutId: number | null = null;
let socketTimeoutId: number | null = null;
let socketReady = false;
let lastIncomingAt = Date.now();
let serverEpoch: string | null = null;
let outgoingMessageId = 0;
let outgoingAckId = 0;
let outgoingSentId = 0;
let outgoingUnackedBytes = 0;
let incomingMessageId = 0;
let outgoingUnacked: OutgoingBridgeMessage[] = [];

function createBridgeConnectionId(): string {
  const bytes = new Uint8Array(16);
  if (globalThis.crypto?.getRandomValues) {
    globalThis.crypto.getRandomValues(bytes);
    return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(
      "",
    );
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

// Do not use crypto.randomUUID(): browsers expose it only in secure contexts,
// while codex-web intentionally supports direct HTTP on trusted local networks.
const connectionId = createBridgeConnectionId();
const pendingInvokes = new Map<
  string,
  {
    reject: (reason?: unknown) => void;
    resolve: (value: unknown) => void;
  }
>();
const pendingDirectoryEntries = new Map<
  string,
  {
    reject: (reason?: unknown) => void;
    resolve: (value: WorkspaceDirectoryEntries) => void;
  }
>();
const rendererListeners = new Map<string, Set<IpcListener>>();
const reportedRendererListenerErrors = new Set<string>();
let rendererBridgeReadySent = false;
const messagePorts = new Map<string, MessagePort>();

function unimplemented(method: string): never {
  debugger;
  throw new Error(`[electron-stub] ${method} is not implemented`);
}

export function emitRendererEvent(channel: string, args: unknown[]): void {
  const listeners = rendererListeners.get(channel);
  if (!listeners || listeners.size === 0) {
    return;
  }
  const event = { sender: null };
  for (const listener of listeners) {
    try {
      listener(event, ...args);
    } catch (error) {
      // One bad official-renderer listener must not prevent the reliable
      // transport from ACKing the message and replaying it forever.
      if (!reportedRendererListenerErrors.has(channel)) {
        reportedRendererListenerErrors.add(channel);
        console.error(
          `[electron-stub] IPC listener failed for ${channel}`,
          error,
        );
      }
    }
  }
}

let lastBrowserWindowFocusState: boolean | null = null;

function getBrowserWindowFocusState(): boolean {
  return document.visibilityState === "visible" && document.hasFocus();
}

function installBrowserWindowFocusListeners(): void {
  const handleFocusChange = () => {
    const isFocused = getBrowserWindowFocusState();
    if (isFocused === lastBrowserWindowFocusState) {
      return;
    }

    lastBrowserWindowFocusState = isFocused;
    emitRendererEvent("codex_desktop:message-for-view", [
      {
        type: "electron-window-focus-changed",
        isFocused,
      },
    ]);
  };

  window.addEventListener("focus", handleFocusChange);
  window.addEventListener("blur", handleFocusChange);
  document.addEventListener("visibilitychange", handleFocusChange);
}

installBrowserWindowFocusListeners();

function handleIncomingMessage(message: MainToRendererMessage): void {
  if (message.type === "ipc-main-event") {
    emitRendererEvent(message.channel, message.args);
    return;
  }

  if (message.type === "ipc-renderer-invoke-result") {
    const pending = pendingInvokes.get(message.requestId);
    if (!pending) {
      return;
    }
    pendingInvokes.delete(message.requestId);
    if (message.ok) {
      pending.resolve(message.result);
      return;
    }
    pending.reject(new Error(message.errorMessage));
    return;
  }

  if (message.type === "message-port-message") {
    messagePorts
      .get(message.portId)
      ?.postMessage(decodeMessagePortData(message.data));
    return;
  }

  if (message.type === "message-port-close") {
    const port = messagePorts.get(message.portId);
    messagePorts.delete(message.portId);
    port?.close();
    return;
  }

  if (message.type === "workspace-directory-entries-result") {
    const pending = pendingDirectoryEntries.get(message.requestId);
    if (!pending) {
      return;
    }
    pendingDirectoryEntries.delete(message.requestId);
    if (message.ok) {
      pending.resolve(message.result);
      return;
    }
    pending.reject(new Error(message.errorMessage));
  }
}

function scheduleReconnect(): void {
  if (reconnectTimeoutId !== null) {
    return;
  }
  reconnectTimeoutId = window.setTimeout(() => {
    reconnectTimeoutId = null;
    ensureSocket();
  }, RECONNECT_DELAY_MS);
}

function ensureSocket(): void {
  if (
    socket &&
    (socket.readyState === WebSocket.OPEN ||
      socket.readyState === WebSocket.CONNECTING)
  ) {
    return;
  }

  const nextSocket = new WebSocket(
    `${window.location.protocol === "https:" ? "wss:" : "ws:"}//${window.location.host}/__backend/ipc`,
  );
  socket = nextSocket;
  socketReady = false;
  nextSocket.addEventListener("open", () => {
    if (socket !== nextSocket) {
      return;
    }
    lastIncomingAt = Date.now();
    sendRaw({
      type: "bridge-hello",
      protocolVersion: BRIDGE_PROTOCOL_VERSION,
      connectionId,
      serverEpoch,
    });
    startSocketTimeout(nextSocket);
  });
  nextSocket.addEventListener("message", (event) => {
    if (socket !== nextSocket) {
      return;
    }
    lastIncomingAt = Date.now();
    try {
      const frame = JSON.parse(String(event.data)) as BridgeServerFrame;
      if (!frame || typeof frame !== "object" || !("type" in frame)) {
        resetBridge("invalid reliable bridge frame");
        return;
      }
      handleBridgeFrame(frame);
    } catch (error) {
      console.error(
        "[electron-stub] failed to parse IPC bridge message",
        error,
      );
    }
  });
  nextSocket.addEventListener("close", () => {
    if (socket !== nextSocket) {
      return;
    }
    stopSocketTimeout();
    socket = null;
    socketReady = false;
    for (const port of messagePorts.values()) {
      port.close();
    }
    messagePorts.clear();
    scheduleReconnect();
  });
  nextSocket.addEventListener("error", () => {
    if (socket === nextSocket) {
      nextSocket.close();
    }
  });
}

function enqueueMessage(message: RendererToMainMessage): void {
  const byteLength = new TextEncoder().encode(JSON.stringify(message)).length;
  const outgoing = {
    id: ++outgoingMessageId,
    message,
    byteLength,
  };
  outgoingUnacked.push(outgoing);
  outgoingUnackedBytes += byteLength;
  if (outgoingUnackedBytes > MAX_UNACKED_BYTES) {
    resetBridge("reliable bridge buffer exceeded");
    return;
  }
  ensureSocket();
  pumpOutgoing();
}

function handleBridgeFrame(frame: BridgeServerFrame): void {
  if (frame.type === "bridge-ready") {
    if (frame.connectionId !== connectionId) {
      resetBridge("reliable bridge connection mismatch");
      return;
    }
    if (serverEpoch !== null && serverEpoch !== frame.serverEpoch) {
      resetBridge("backend restarted");
      return;
    }
    serverEpoch = frame.serverEpoch;
    socketReady = true;
    sendAck();
    outgoingSentId = outgoingAckId;
    pumpOutgoing();
    return;
  }
  if (frame.type === "bridge-reset") {
    resetBridge(frame.reason);
    return;
  }
  if (frame.type === "bridge-data") {
    if (acceptAck(frame.ack)) {
      acceptMessage(frame);
    }
    return;
  }
  if (frame.type === "bridge-ack") {
    acceptAck(frame.ack);
    return;
  }
  if (frame.type === "bridge-replay-request") {
    if (acceptAck(frame.ack, false)) {
      outgoingSentId = frame.ack;
      pumpOutgoing();
    }
    return;
  }
  if (frame.type === "bridge-keepalive") {
    sendRaw({ type: "bridge-keepalive" });
    return;
  }
  resetBridge("unsupported reliable bridge frame");
}

function acceptMessage(
  frame: Extract<BridgeServerFrame, { type: "bridge-data" }>,
): void {
  if (!Number.isSafeInteger(frame.id) || frame.id <= 0) {
    resetBridge("invalid reliable bridge message id");
    return;
  }
  if (frame.id === incomingMessageId + 1) {
    incomingMessageId = frame.id;
    handleIncomingMessage(frame.message);
    sendAck();
    return;
  }
  if (frame.id <= incomingMessageId) {
    sendAck();
    return;
  }
  sendRaw({ type: "bridge-replay-request", ack: incomingMessageId });
}

function acceptAck(ack: number, pump = true): boolean {
  if (!Number.isSafeInteger(ack) || ack < 0 || ack > outgoingSentId) {
    resetBridge("invalid reliable bridge acknowledgement");
    return false;
  }
  if (ack <= outgoingAckId) {
    return true;
  }
  outgoingAckId = ack;
  const acknowledged = outgoingUnacked.filter((message) => message.id <= ack);
  outgoingUnackedBytes -= acknowledged.reduce(
    (total, message) => total + message.byteLength,
    0,
  );
  outgoingUnacked = outgoingUnacked.filter((message) => message.id > ack);
  if (pump) {
    pumpOutgoing();
  }
  return true;
}

function pumpOutgoing(): void {
  if (!socketReady) {
    return;
  }
  let inFlightBytes = outgoingUnacked
    .filter((message) => message.id <= outgoingSentId)
    .reduce((total, message) => total + message.byteLength, 0);
  for (const message of outgoingUnacked) {
    if (message.id <= outgoingSentId) {
      continue;
    }
    if (
      inFlightBytes > 0 &&
      inFlightBytes + message.byteLength > MAX_IN_FLIGHT_BYTES
    ) {
      break;
    }
    sendRaw({
      type: "bridge-data",
      id: message.id,
      ack: incomingMessageId,
      message: message.message,
    });
    outgoingSentId = message.id;
    inFlightBytes += message.byteLength;
  }
}

function sendAck(): void {
  if (socketReady) {
    sendRaw({ type: "bridge-ack", ack: incomingMessageId });
  }
}

function sendRaw(frame: object): void {
  if (!socket || socket.readyState !== WebSocket.OPEN) {
    return;
  }
  try {
    socket.send(JSON.stringify(frame));
  } catch {
    socket.close();
  }
}

function startSocketTimeout(currentSocket: WebSocket): void {
  stopSocketTimeout();
  socketTimeoutId = window.setInterval(() => {
    if (
      socket === currentSocket &&
      Date.now() - lastIncomingAt > SOCKET_TIMEOUT_MS
    ) {
      currentSocket.close();
    }
  }, 5_000);
}

function stopSocketTimeout(): void {
  if (socketTimeoutId !== null) {
    window.clearInterval(socketTimeoutId);
    socketTimeoutId = null;
  }
}

function resetBridge(reason: string): void {
  console.error(`[electron-stub] reliable IPC bridge reset: ${reason}`);
  stopSocketTimeout();
  socket?.close();
  if (reason === "backend restarted") {
    storeBackendRestartRecoveryMarker(browserSessionStorage());
  }
  window.location.reload();
}

function browserSessionStorage(): Storage | null {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

function nextRequestId(): string {
  requestCounter += 1;
  return `ipc_bridge_${requestCounter}`;
}

function invokeMain(channel: string, args: unknown[]): Promise<unknown> {
  const requestId = nextRequestId();
  return new Promise((resolve, reject) => {
    pendingInvokes.set(requestId, { resolve, reject });
    enqueueMessage({
      type: "ipc-renderer-invoke",
      requestId,
      channel,
      args,
    });
  });
}

function addIpcListener(channel: string, listener: IpcListener): void {
  const listeners = rendererListeners.get(channel) ?? new Set<IpcListener>();
  listeners.add(listener);
  rendererListeners.set(channel, listeners);
  if (
    channel === "codex_desktop:message-for-view" &&
    !rendererBridgeReadySent
  ) {
    rendererBridgeReadySent = true;
    enqueueMessage({
      type: "renderer-bridge-ready",
      currentThreadId: currentThreadIdFromBrowserPath(window.location.pathname),
      recoveryReason: consumeBackendRestartRecoveryMarker(
        browserSessionStorage(),
      ),
    });
  }
}

function shouldCloseSidebarForMemoryPath(path: string): boolean {
  return (
    path === "/" ||
    path.startsWith("/local/") ||
    path === "/skills" ||
    path === "/automations"
  );
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

type WebNotificationPayload = {
  body?: string;
  id?: string;
  kind: string;
  title: string;
};

async function showWebNotification(
  notification: WebNotificationPayload,
): Promise<void> {
  if (typeof Notification === "undefined") {
    console.warn("[codex-web] Web Notifications API unavailable");
    return;
  }

  try {
    const permission = Notification.permission;
    if (permission !== "granted") {
      console.warn("[codex-web] notification permission", permission);
      return;
    }

    const webNotification = new Notification(notification.title, {
      body: notification.body,
      tag: notification.id,
    });
    webNotification.onclick = () => {
      window.focus();
      webNotification.close();
    };
    console.log("[codex-web] notification shown", notification);
  } catch (error) {
    console.error("[codex-web] failed to show notification", error);
  }
}

function handleNotificationShowMessage(value: unknown): void {
  if (typeof value !== "string") {
    return;
  }

  try {
    const message = JSON.parse(value) as unknown;
    if (
      !Array.isArray(message) ||
      message[0] !== "push" ||
      !Array.isArray(message[1])
    ) {
      return;
    }

    const pipeline = message[1];
    const method = pipeline[2];
    const args = pipeline[3];
    const notification = Array.isArray(args) ? args[0] : null;
    if (
      pipeline[0] === "pipeline" &&
      Array.isArray(method) &&
      method[0] === "show" &&
      isRecord(notification) &&
      typeof notification.kind === "string" &&
      typeof notification.title === "string" &&
      (notification.body === undefined ||
        typeof notification.body === "string") &&
      (notification.id === undefined || typeof notification.id === "string")
    ) {
      void showWebNotification({
        body: notification.body,
        id: notification.id,
        kind: notification.kind,
        title: notification.title,
      });
    }
  } catch {
    // Ignore non-JSON MessagePort traffic.
  }
}

function isUnhandledAddWorkspaceRootOptionMessage(value: unknown): value is {
  root?: unknown;
  type: "electron-add-new-workspace-root-option";
} {
  return (
    isRecord(value) &&
    value.type === "electron-add-new-workspace-root-option" &&
    typeof value.root !== "string"
  );
}

function isOpenInBrowserMessage(value: unknown): value is {
  type: "open-in-browser";
  url: string;
} {
  return (
    isRecord(value) &&
    value.type === "open-in-browser" &&
    typeof value.url === "string"
  );
}

function isElectronWindowFocusRequestMessage(value: unknown): value is {
  type: "electron-window-focus-request";
} {
  return isRecord(value) && value.type === "electron-window-focus-request";
}

function requestWorkspaceDirectoryEntries(
  directoryPath: string | null,
  scope: "browse" | "project" = "browse",
): Promise<WorkspaceDirectoryEntries> {
  const requestId = nextRequestId();
  return new Promise((resolve, reject) => {
    pendingDirectoryEntries.set(requestId, { resolve, reject });
    enqueueMessage({
      type: "workspace-directory-entries-request",
      requestId,
      directoryPath,
      directoriesOnly: true,
      scope,
    });
  });
}

const themeMediaQuery = matchMedia("(prefers-color-scheme: dark)");
themeMediaQuery.addEventListener("change", (event) => {
  emitRendererEvent("codex_desktop:system-theme-variant-updated", [
    event.matches ? "dark" : "light",
  ]);
});
const mobileMediaQuery = matchMedia("(max-width: 768px)");
const initialSidebarState = !mobileMediaQuery.matches;
const electronShim = (window.__ELECTRON_SHIM__ ??= {});
const buildFlavor: "prod" | "dev" | "agent" | string = "prod";

Object.assign(globalThis, {
  process: {
    arch: "arm64",
    platform: "darwin",
    versions: {
      electron: "41.2.0",
    },
  },
});

// Unified ChatGPT+Codex sidebar master gate. When it is on and the user has
// fewer than two saved projects, a one-time initialization effect permanently
// locks the sidebar to the ungrouped "In one list" mode instead of the
// project-grouped default.
const FLAT_SIDEBAR_LOCK_GATES = new Set([
  "12346831",
  // Quick-chat rollout pair: their conjunction enables the same lock effect
  // through a second path, plus unified-sidebar surfaces we do not support.
  "3476143199",
  "824038554",
]);

electronShim.overrideAdapter = {
  getGateOverride(evaluation) {
    if (evaluation.name === "2911712394") {
      return {
        ...evaluation,
        value: true,
      };
    }

    if (evaluation.name === "1042620455") {
      // Remote control (Slingshot).
      return {
        ...evaluation,
        value: true,
      };
    }

    if (FLAT_SIDEBAR_LOCK_GATES.has(evaluation.name)) {
      // Pin the sidebar to the project-grouped baseline the browser wrapper
      // is tested against, regardless of remote flag state.
      return {
        ...evaluation,
        value: false,
      };
    }

    return null;
  },
};

electronShim.services = {
  ...electronShim.services,
  appInfo: {
    get: async () => ({
      appBrand: "codex",
      appIconMedium: null,
      appName: "Codex",
      buildFlavor,
      buildNumber: null,
      dockIconPreviews: null,
      osName: "macOS",
      systemVersion: null,
      version: __CODEX_APP_VERSION__,
    }),
  },
  workspaceFiles: {
    ...electronShim.services?.workspaceFiles,
    downloadCopy: downloadWorkspaceFileCopy,
  },
  requestUserInputAutoResolution: {
    ...electronShim.services?.requestUserInputAutoResolution,
    recordConversationActivity: () => undefined,
    setConversationPresented: () => undefined,
    snooze: () => undefined,
  },
};

const initialRoute = mapBrowserPathToInitialRoute(
  window.location.pathname,
  window.location.search,
);
electronShim.initialRoute = initialRoute.memoryPath;

if (initialRoute.browserPath) {
  window.history.pushState(undefined, "", initialRoute.browserPath);
}

electronShim.initialSidebarState = initialSidebarState;
electronShim.onMemoryNavigationChanged = (navigation) => {
  const path = navigation.location.pathname;
  if (
    navigation.action !== "POP" &&
    mobileMediaQuery.matches &&
    shouldCloseSidebarForMemoryPath(path)
  ) {
    electronShim.closeSidebar?.();
  }

  const browserPath = mapMemoryPathToBrowserPath(
    path,
    navigation.location.search,
  );
  if (browserPath == null) {
    return;
  }

  if (browserPath.titleChange) {
    document.title = browserPath.titleChange;
  }

  // REPLACE navigations (settings index redirects, dialog-closing search
  // updates) must not grow the browser history: mirroring them as pushState
  // would let browser Back land on states the memory router erased.
  if (
    navigation.action === "REPLACE" ||
    window.location.pathname + window.location.search === browserPath.path
  ) {
    window.history.replaceState(undefined, "", browserPath.path);
    return;
  }

  window.history.pushState(undefined, "", browserPath.path);
};

export const ipcRenderer = {
  invoke(channel: string, ...args: unknown[]): Promise<unknown> {
    if (channel === "codex_desktop:message-from-view" && args.length === 1) {
      if (isElectronWindowFocusRequestMessage(args[0])) {
        const isFocused = getBrowserWindowFocusState();
        lastBrowserWindowFocusState = isFocused;
        emitRendererEvent("codex_desktop:message-for-view", [
          {
            type: "electron-window-focus-changed",
            isFocused,
          },
        ]);
        return Promise.resolve(undefined);
      }

      if (isOpenInBrowserMessage(args[0])) {
        window.open(args[0].url, "_blank", "noopener,noreferrer");
      }

      if (isLocalFilePickerMessage(args[0])) {
        return handleLocalFilePickerMessage(args[0]);
      }

      if (isUnhandledAddWorkspaceRootOptionMessage(args[0])) {
        return openSelectWorkspaceRootDialog({
          listDirectory: (directoryPath) =>
            requestWorkspaceDirectoryEntries(directoryPath, "project"),
        }).then((root) => {
          if (!root) {
            return undefined;
          }

          return invokeMain(channel, [{ ...args[0], root }]);
        });
      }
    }

    return invokeMain(channel, args);
  },
  on(channel: string, listener: IpcListener): unknown {
    addIpcListener(channel, listener);
    return this;
  },
  once(channel: string, listener: IpcListener): unknown {
    const wrapped: IpcListener = (event, ...args) => {
      this.removeListener(channel, wrapped);
      listener(event, ...args);
    };
    addIpcListener(channel, wrapped);
    return this;
  },
  addListener(channel: string, listener: IpcListener): unknown {
    addIpcListener(channel, listener);
    return this;
  },
  removeListener(channel: string, listener: IpcListener): unknown {
    rendererListeners.get(channel)?.delete(listener);
    return this;
  },
  off(channel: string, listener: IpcListener): unknown {
    return this.removeListener(channel, listener);
  },
  send(channel: string, ...args: unknown[]): void {
    enqueueMessage({
      type: "ipc-renderer-send",
      channel,
      args,
    });
  },
  postMessage(
    channel: string,
    message: unknown,
    transfer?: Transferable[],
  ): void {
    if (transfer && transfer.length > 0) {
      const portIds = transfer.map((transferable) => {
        if (!(transferable instanceof MessagePort)) {
          throw new TypeError(
            "Only MessagePort transfers are supported by the browser IPC bridge.",
          );
        }

        const portId = `message_port_${nextRequestId()}`;
        messagePorts.set(portId, transferable);
        transferable.addEventListener("message", (event) => {
          if (channel === "codex_desktop:connect-app-host") {
            handleNotificationShowMessage(event.data);
          }
          enqueueMessage({
            type: "message-port-message",
            portId,
            data: encodeMessagePortData(event.data),
          });
        });
        transferable.addEventListener("messageerror", () => {
          messagePorts.delete(portId);
          enqueueMessage({ type: "message-port-close", portId });
        });
        transferable.start();
        return portId;
      });

      enqueueMessage({
        type: "ipc-renderer-post-message",
        channel,
        message,
        portIds,
      });
      return;
    }

    enqueueMessage({
      type: "ipc-renderer-send",
      channel,
      args: [message],
    });
  },
  sendSync(channel: string, ..._args: unknown[]): unknown {
    if (channel === "codex_desktop:get-sentry-init-options") {
      return {
        codexAppSessionId: "42626fde-7064-471f-b44d-b1a7ad849c7f",
        buildFlavor,
        buildNumber: null,
        appVersion: __CODEX_APP_VERSION__,
        enabled: false,
      };
    }

    if (channel === "codex_desktop:get-build-flavor") {
      return buildFlavor;
    }

    if (channel === "codex_desktop:get-uses-owl-app-shell") {
      return false;
    }

    if (channel === "codex_desktop:get-shared-object-snapshot") {
      return {
        host_config: { id: "local", display_name: "Local", kind: "local" },
        remote_ssh_connections: [],
        remote_wsl_connections: [],
        // The renderer treats a missing connections array (unlike an empty
        // one) as "remote connections still loading" and never settles.
        remote_control_connections: [],
        remote_control_connections_state: {
          available: false,
          accessRequired: false,
          authRequired: false,
          clientAuthorized: false,
        },
        local_remote_control_client_id: null,
        pending_worktrees: [],
      };
    }

    if (channel === "codex_desktop:get-initial-sidebar-bootstrap") {
      return null;
    }

    if (channel === "codex_desktop:get-system-theme-variant") {
      return themeMediaQuery.matches ? "dark" : "light";
    }

    if (channel === "codex_desktop:start-file-drag") {
      return false;
    }

    return unimplemented("ipcRenderer.sendSync");
  },
};

ensureSocket();
window.addEventListener("pagehide", () => {
  if (socketReady) {
    sendRaw({ type: "bridge-disconnect" });
  }
});

// The bundled renderer prefers native menus and native file drags whenever
// the bridge advertises them, and falls back to its own complete DOM
// implementations (context-menu popovers, browser upload flows) when the
// methods are absent. Native menus and path-based drags cannot work from a
// browser page, so hide those capabilities instead of exposing hanging or
// throwing stubs.
const BROWSER_UNSUPPORTED_BRIDGE_METHODS = ["showContextMenu", "startFileDrag"];

export const contextBridge = {
  exposeInMainWorld(_key: string, _api: unknown): void {
    if (_key === "electronBridge" && isRecord(_api)) {
      const api = { ..._api };
      for (const method of BROWSER_UNSUPPORTED_BRIDGE_METHODS) {
        delete api[method];
      }
      Reflect.set(window, _key, api);
      return;
    }
    Reflect.set(window, _key, _api);
  },
};

export const webUtils = {
  getPathForFile(_file: File): string | null {
    // No browser page can resolve a local filesystem path for a File. The
    // renderer treats null as "no native path" and uses its upload flows.
    return null;
  },
};
