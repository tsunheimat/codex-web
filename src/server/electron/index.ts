import os from "node:os";

const HOME_DIRECTORY = os.homedir();

type StubFunction = (...args: unknown[]) => unknown;
type StubListener = (...args: unknown[]) => void;
type StubMessagePort = {
  close: () => void;
  on: (event: string, listener: StubListener) => unknown;
  postMessage: (message: unknown) => void;
  start: () => void;
};
type StubWebContents = {
  id: number;
  mainFrame: {
    url: string;
  };
  getURL: () => string;
  isDestroyed: () => boolean;
  off: (event: string, listener: StubListener) => unknown;
  on: (event: string, listener: StubListener) => unknown;
  once: (event: string, listener: StubListener) => unknown;
  removeListener: (event: string, listener: StubListener) => unknown;
  send: (channel: string, ...args: unknown[]) => void;
};
type IpcMainEvent = {
  returnValue: unknown;
  processId: number;
  frameId: number;
  sender: StubWebContents;
  senderFrame: {
    url: string;
  };
  ports: StubMessagePort[];
  reply: (channel: string, ...args: unknown[]) => void;
};

type IpcMainBridgeState = {
  broadcastToRenderer?: (message: {
    type: "ipc-main-event";
    channel: string;
    args: unknown[];
  }) => void;
  handleRendererInvoke?: (
    channel: string,
    args: unknown[],
    responseSink?: (channel: string, args: unknown[]) => void,
  ) => Promise<unknown>;
  handleRendererPostMessage?: (
    channel: string,
    message: unknown,
    ports: StubMessagePort[],
    sourceUrl?: string,
  ) => void;
  handleRendererSend?: (
    channel: string,
    args: unknown[],
    sourceUrl?: string,
  ) => void;
  shutdownDesktopApp?: () => Promise<void>;
};

function getIpcMainBridgeState(): IpcMainBridgeState {
  const globals = globalThis as typeof globalThis & {
    __codexElectronIpcBridge?: IpcMainBridgeState;
  };
  if (!globals.__codexElectronIpcBridge) {
    globals.__codexElectronIpcBridge = {};
  }
  return globals.__codexElectronIpcBridge;
}

const MAX_LOGGED_ARGUMENTS = 6;
const MAX_LOGGED_METHOD_LENGTH = 96;
const DEEP_STUB_PROPERTY_LABEL = "<property>";

function summarizeLogArgument(argument: unknown): string {
  if (argument === null) {
    return "null";
  }

  switch (typeof argument) {
    case "string":
      return `string(length=${argument.length})`;
    case "function":
      return "callable";
    case "object":
      return "object";
    case "bigint":
      return "bigint";
    case "boolean":
      return "boolean";
    case "number":
      return "number";
    case "symbol":
      return "symbol";
    case "undefined":
      return "undefined";
  }

  return "unknown";
}

function summarizeLogMethod(method: string): string {
  const singleLineMethod = method.replace(/[\u0000-\u001f\u007f]/g, "?");
  if (singleLineMethod.length <= MAX_LOGGED_METHOD_LENGTH) {
    return singleLineMethod;
  }
  return `${singleLineMethod.slice(0, MAX_LOGGED_METHOD_LENGTH - 3)}...`;
}

function log(method: string, args: readonly unknown[]): void {
  const visibleArguments = args
    .slice(0, MAX_LOGGED_ARGUMENTS)
    .map(summarizeLogArgument);
  const omittedArgumentCount = args.length - visibleArguments.length;
  const omittedSummary =
    omittedArgumentCount > 0 ? ` omitted=${omittedArgumentCount}` : "";
  console.log(
    `[electron-main-stub] ${summarizeLogMethod(method)} argc=${args.length} args=[${visibleArguments.join(", ")}]${omittedSummary}`,
  );
}

function createDeepStub(pathLabel: string): StubFunction {
  const fn: StubFunction = (...args: unknown[]) => {
    log(`${pathLabel}()`, args);
    return undefined;
  };

  return new Proxy(fn, {
    apply(_target, _thisArg, argArray) {
      log(`${pathLabel}()`, argArray);
      return undefined;
    },
    construct(_target, argArray) {
      log(`new ${pathLabel}()`, argArray);
      return {};
    },
    get(_target, prop) {
      if (prop === "then") {
        return undefined;
      }

      if (prop === Symbol.toPrimitive) {
        return () => pathLabel;
      }

      return createDeepStub(`${pathLabel}.${DEEP_STUB_PROPERTY_LABEL}`);
    },
  });
}

function withDeepStubFallback<T extends object>(target: T, label: string): T {
  return new Proxy(target, {
    get(currentTarget, prop) {
      if (prop in currentTarget) {
        return currentTarget[prop as keyof T];
      }
      return createDeepStub(`${label}.${DEEP_STUB_PROPERTY_LABEL}`);
    },
  });
}

function createEmitterStub(label: string): {
  addListener: (event: string, listener: StubListener) => unknown;
  emit: (event: string, ...args: unknown[]) => boolean;
  off: (event: string, listener: StubListener) => unknown;
  on: (event: string, listener: StubListener) => unknown;
  once: (event: string, listener: StubListener) => unknown;
  removeListener: (event: string, listener: StubListener) => unknown;
} {
  const listeners = new Map<string, Set<StubListener>>();

  const api = {
    on(event: string, listener: StubListener): unknown {
      log(`${label}.on`, [event, listener]);
      const eventListeners = listeners.get(event) ?? new Set<StubListener>();
      eventListeners.add(listener);
      listeners.set(event, eventListeners);
      return api;
    },
    once(event: string, listener: StubListener): unknown {
      log(`${label}.once`, [event, listener]);
      const wrapped: StubListener = (...args: unknown[]) => {
        api.removeListener(event, wrapped);
        listener(...args);
      };
      return api.on(event, wrapped);
    },
    addListener(event: string, listener: StubListener): unknown {
      log(`${label}.addListener`, [event, listener]);
      return api.on(event, listener);
    },
    removeListener(event: string, listener: StubListener): unknown {
      log(`${label}.removeListener`, [event, listener]);
      listeners.get(event)?.delete(listener);
      return api;
    },
    off(event: string, listener: StubListener): unknown {
      log(`${label}.off`, [event, listener]);
      return api.removeListener(event, listener);
    },
    emit(event: string, ...args: unknown[]): boolean {
      log(`${label}.emit`, [event, ...args]);
      for (const listener of listeners.get(event) ?? []) {
        listener(...args);
      }
      return true;
    },
  };

  return api;
}

function createMessagePortStub(label: string): {
  on: (event: string, listener: StubListener) => unknown;
  postMessage: (...args: unknown[]) => void;
  start: () => void;
} {
  const emitter = createEmitterStub(label);
  return {
    on: emitter.on,
    postMessage(...args: unknown[]): void {
      log(`${label}.postMessage`, args);
    },
    start(): void {
      log(`${label}.start`, []);
    },
  };
}

const rendererUrl = "http://localhost:5175/";
const rendererMainFrame = {
  url: rendererUrl,
};
const rendererWebContentsEmitter = createEmitterStub("ipcMainEvent.sender");
const rendererWebContents: StubWebContents = {
  id: 1001,
  mainFrame: rendererMainFrame,
  getURL: () => rendererMainFrame.url,
  isDestroyed: () => false,
  off: rendererWebContentsEmitter.off,
  on: rendererWebContentsEmitter.on,
  once: rendererWebContentsEmitter.once,
  removeListener: rendererWebContentsEmitter.removeListener,
  send: (channel: string, ...args: unknown[]): void => {
    getIpcMainBridgeState().broadcastToRenderer?.({
      type: "ipc-main-event",
      channel,
      args,
    });
  },
};

function createIpcMainEvent(
  ports: StubMessagePort[] = [],
  responseSink?: (channel: string, args: unknown[]) => void,
): IpcMainEvent {
  const defaultSender =
    (BrowserWindow.fromWebContents(rendererWebContents)
      ?.webContents as unknown as StubWebContents | undefined) ??
    rendererWebContents;
  const sender = responseSink
    ? ({
        ...defaultSender,
        send: (channel: string, ...args: unknown[]): void => {
          responseSink(channel, args);
        },
      } satisfies StubWebContents)
    : defaultSender;
  const event: IpcMainEvent = {
    returnValue: undefined,
    processId: 1,
    frameId: 1,
    sender,
    senderFrame: sender.mainFrame,
    ports,
    reply: (channel: string, ...args: unknown[]): void => {
      if (responseSink) {
        responseSink(channel, args);
        return;
      }
      getIpcMainBridgeState().broadcastToRenderer?.({
        type: "ipc-main-event",
        channel,
        args,
      });
    },
  };

  return event;
}

function createIpcMainStub(): {
  handle: (
    channel: string,
    handler: (event: unknown, ...args: unknown[]) => unknown,
  ) => void;
  off: (event: string, listener: StubListener) => unknown;
  on: (event: string, listener: StubListener) => unknown;
  removeHandler: (channel: string) => void;
} {
  const emitter = createEmitterStub("ipcMain");
  const handlers = new Map<
    string,
    (event: unknown, ...args: unknown[]) => unknown
  >();
  const bridgeState = getIpcMainBridgeState();

  const pendingPostMessages = new Map<
    string,
    Array<{ message: unknown; ports: StubMessagePort[] }>
  >();
  const registeredPostMessageChannels = new Set<string>();

  bridgeState.handleRendererPostMessage = (
    channel: string,
    message: unknown,
    ports: StubMessagePort[],
  ): void => {
    if (registeredPostMessageChannels.has(channel)) {
      emitter.emit(channel, createIpcMainEvent(ports), message);
      return;
    }
    const pending = pendingPostMessages.get(channel) ?? [];
    pending.push({ message, ports });
    pendingPostMessages.set(channel, pending);
  };

  bridgeState.handleRendererInvoke = async (
    channel: string,
    args: unknown[],
    responseSink?: (channel: string, args: unknown[]) => void,
  ): Promise<unknown> => {
    const handler = handlers.get(channel);
    if (!handler) {
      throw new Error(`[electron-main-stub] No ipcMain.handle for ${channel}`);
    }
    const event = createIpcMainEvent([], responseSink);
    return await Promise.resolve(handler(event, ...args));
  };

  bridgeState.handleRendererSend = (
    channel: string,
    args: unknown[],
    sourceUrl?: string,
  ): void => {
    const event = createIpcMainEvent();
    emitter.emit(channel, event, ...args);
  };

  return {
    on(channel: string, listener: StubListener): unknown {
      const result = emitter.on(channel, listener);
      registeredPostMessageChannels.add(channel);
      const pending = pendingPostMessages.get(channel);
      if (pending) {
        pendingPostMessages.delete(channel);
        for (const { message, ports } of pending) {
          emitter.emit(channel, createIpcMainEvent(ports), message);
        }
      }
      return result;
    },
    off: emitter.off,
    handle(
      channel: string,
      handler: (event: unknown, ...args: unknown[]) => unknown,
    ): void {
      log("ipcMain.handle", [channel, handler]);
      handlers.set(channel, handler);
    },
    removeHandler(channel: string): void {
      log("ipcMain.removeHandler", [channel]);
      handlers.delete(channel);
    },
  };
}

let appReady = false;
let desktopShutdownPromise: Promise<void> | null = null;
const commandLineSwitches = new Map<string, string>();
const commandLineArguments: string[] = [];
const appEmitter = createEmitterStub("app");

function shutdownDesktopApp(): Promise<void> {
  if (desktopShutdownPromise) {
    return desktopShutdownPromise;
  }
  desktopShutdownPromise = (async () => {
    const event = { preventDefault: () => undefined };
    appEmitter.emit("before-quit", event);
    appEmitter.emit("will-quit", event);
    await new Promise<void>((resolve) => setImmediate(resolve));
    appEmitter.emit("quit", event, 0);
  })();
  return desktopShutdownPromise;
}

const appBase = {
  ...appEmitter,
  name: "Codex",
  isPackaged: false,
  getName(): string {
    log("app.getName", []);
    return "Codex";
  },
  getVersion(): string {
    return globalThis.__CODEX_SHIM_VALUES__.version;
  },
  getLocale(): string {
    log("app.getLocale", []);
    return "en-US";
  },
  getSystemLocale(): string {
    log("app.getSystemLocale", []);
    return "en-US";
  },
  getPreferredSystemLanguages(): string[] {
    log("app.getPreferredSystemLanguages", []);
    return ["en-US"];
  },
  getPath(name: string): string {
    log("app.getPath", [name]);
    // The desktop app derives user-facing workspace locations from these two
    // paths ("Start from scratch" projects and projectless thread cwds). They
    // must land inside the pinned browse root or the request-path sanitizer
    // rejects every thread started there.
    if (name === "home") {
      return HOME_DIRECTORY;
    }
    if (name === "documents" || name === "desktop") {
      return globalThis.__CODEX_SHIM_VALUES__?.browseRoot ?? process.cwd();
    }
    return process.cwd();
  },
  getAppMetrics(): unknown[] {
    log("app.getAppMetrics", []);
    return [];
  },
  getAppPath(): string {
    log("app.getAppPath", []);
    return process.cwd();
  },
  async getGPUInfo(infoLevel: string): Promise<{ gpuDevice: unknown[] }> {
    log("app.getGPUInfo", [infoLevel]);
    return { gpuDevice: [] };
  },
  setName(name: string): void {
    log("app.setName", [name]);
  },
  setPath(name: string, value: string): void {
    log("app.setPath", [name, value]);
  },
  setAppUserModelId(value: string): void {
    log("app.setAppUserModelId", [value]);
  },
  requestSingleInstanceLock(): boolean {
    log("app.requestSingleInstanceLock", []);
    return true;
  },
  isReady(): boolean {
    log("app.isReady", []);
    return appReady;
  },
  whenReady(): Promise<void> {
    log("app.whenReady", []);
    appReady = true;
    return Promise.resolve();
  },
  commandLine: {
    appendSwitch(name: string, value?: string): void {
      log("app.commandLine.appendSwitch", [name, value]);
      commandLineSwitches.set(name, value ?? "");
    },
    appendArgument(value: string): void {
      log("app.commandLine.appendArgument", [value]);
      commandLineArguments.push(value);
    },
    getSwitchValue(name: string): string {
      log("app.commandLine.getSwitchValue", [name]);
      return commandLineSwitches.get(name) ?? "";
    },
    hasSwitch(name: string): boolean {
      log("app.commandLine.hasSwitch", [name]);
      return commandLineSwitches.has(name);
    },
    removeSwitch(name: string): void {
      log("app.commandLine.removeSwitch", [name]);
      commandLineSwitches.delete(name);
    },
  },
  on(event: string, listener: (...args: unknown[]) => void): unknown {
    appEmitter.on(event, listener);
    return app;
  },
  once(event: string, listener: (...args: unknown[]) => void): unknown {
    appEmitter.once(event, listener);
    return app;
  },
  addListener(event: string, listener: (...args: unknown[]) => void): unknown {
    appEmitter.addListener(event, listener);
    return app;
  },
  removeListener(
    event: string,
    listener: (...args: unknown[]) => void,
  ): unknown {
    appEmitter.removeListener(event, listener);
    return app;
  },
  off(event: string, listener: (...args: unknown[]) => void): unknown {
    appEmitter.off(event, listener);
    return app;
  },
  emit(event: string, ...args: unknown[]): boolean {
    return appEmitter.emit(event, ...args);
  },
  quit(): void {
    log("app.quit", []);
    void shutdownDesktopApp();
  },
  exit(code?: number): void {
    log("app.exit", [code]);
    void shutdownDesktopApp();
  },
};

const app = withDeepStubFallback(
  appBase as Record<string, unknown>,
  "app",
) as typeof appBase;

getIpcMainBridgeState().shutdownDesktopApp = shutdownDesktopApp;

class BrowserWindow {
  static nextId = 1;
  static allWindows: BrowserWindow[] = [];
  static focusedWindow: BrowserWindow | null = null;
  id: number;
  private destroyed = false;
  private title = "Codex";
  private bounds = { x: 0, y: 0, width: 1280, height: 820 };
  webContents: Record<string, unknown>;
  private readonly emitter: ReturnType<typeof createEmitterStub>;

  constructor(...args: unknown[]) {
    log("new BrowserWindow", args);
    this.id = BrowserWindow.nextId++;
    this.emitter = createEmitterStub(`BrowserWindow#${this.id}`);

    const webContentsEmitter = createEmitterStub(
      `BrowserWindow#${this.id}.webContents`,
    );
    this.webContents = withDeepStubFallback(
      {
        ...webContentsEmitter,
        id: this.id * 1000 + 1,
        mainFrame: {
          url: "",
        },
        getURL: (): string => {
          log(`BrowserWindow#${this.id}.webContents.getURL`, []);
          return String(
            (this.webContents.mainFrame as { url?: string } | undefined)?.url ??
              "",
          );
        },
        isDestroyed: (): boolean => this.destroyed,
        loadURL: async (url: string): Promise<void> => {
          log(`BrowserWindow#${this.id}.webContents.loadURL`, [url]);
          (this.webContents.mainFrame as { url: string }).url = url;
        },
        loadFile: async (...loadFileArgs: unknown[]): Promise<void> => {
          log(`BrowserWindow#${this.id}.webContents.loadFile`, loadFileArgs);
        },
        openDevTools: (...openDevToolsArgs: unknown[]): void => {
          log(
            `BrowserWindow#${this.id}.webContents.openDevTools`,
            openDevToolsArgs,
          );
        },
        send: (...sendArgs: unknown[]): void => {
          log(`BrowserWindow#${this.id}.webContents.send`, sendArgs);
          if (sendArgs.length === 0 || typeof sendArgs[0] !== "string") {
            return;
          }
          const [channel, ...args] = sendArgs as [string, ...unknown[]];
          getIpcMainBridgeState().broadcastToRenderer?.({
            type: "ipc-main-event",
            channel,
            args,
          });
        },
      } as Record<string, unknown>,
      `BrowserWindow#${this.id}.webContents`,
    );

    // Register the proxied instance, not the raw one: windows handed out by
    // getAllWindows()/getFocusedWindow() must keep the deep-stub fallback for
    // methods this stub does not implement.
    const proxied = withDeepStubFallback(this, `BrowserWindow#${this.id}`);
    BrowserWindow.allWindows.push(proxied);
    BrowserWindow.focusedWindow = proxied;
    return proxied;
  }

  static getAllWindows(): BrowserWindow[] {
    log("BrowserWindow.getAllWindows", []);
    return BrowserWindow.allWindows.filter((window) => !window.destroyed);
  }

  static getFocusedWindow(): BrowserWindow | null {
    log("BrowserWindow.getFocusedWindow", []);
    if (BrowserWindow.focusedWindow && !BrowserWindow.focusedWindow.destroyed) {
      return BrowserWindow.focusedWindow;
    }
    return BrowserWindow.getAllWindows()[0] ?? null;
  }

  static fromWebContents(
    webContents: { id?: unknown } | null | undefined,
  ): BrowserWindow | null {
    log("BrowserWindow.fromWebContents", [webContents]);
    if (!webContents) {
      return null;
    }

    return (
      BrowserWindow.getAllWindows().find(
        (window) =>
          window.webContents === webContents ||
          window.webContents.id === webContents.id,
      ) ?? null
    );
  }

  on(event: string, listener: StubListener): unknown {
    return this.emitter.on(event, listener);
  }

  once(event: string, listener: StubListener): unknown {
    return this.emitter.once(event, listener);
  }

  off(event: string, listener: StubListener): unknown {
    return this.emitter.off(event, listener);
  }

  removeListener(event: string, listener: StubListener): unknown {
    return this.emitter.removeListener(event, listener);
  }

  async loadURL(url: string): Promise<void> {
    log(`BrowserWindow#${this.id}.loadURL`, [url]);
    (this.webContents.mainFrame as { url: string }).url = url;
  }

  close(): void {
    log(`BrowserWindow#${this.id}.close`, []);
    this.emitter.emit("close", {
      preventDefault: () => undefined,
    });
    this.destroy();
  }

  destroy(): void {
    log(`BrowserWindow#${this.id}.destroy`, []);
    this.destroyed = true;
    if (BrowserWindow.focusedWindow === this) {
      BrowserWindow.focusedWindow = null;
    }
    this.emitter.emit("closed");
  }

  isDestroyed(): boolean {
    log(`BrowserWindow#${this.id}.isDestroyed`, []);
    return this.destroyed;
  }

  isFocused(): boolean {
    log(`BrowserWindow#${this.id}.isFocused`, []);
    return BrowserWindow.focusedWindow === this && !this.destroyed;
  }

  isVisible(): boolean {
    log(`BrowserWindow#${this.id}.isVisible`, []);
    return !this.destroyed;
  }

  removeMenu(): void {
    log(`BrowserWindow#${this.id}.removeMenu`, []);
  }

  getTitle(): string {
    log(`BrowserWindow#${this.id}.getTitle`, []);
    return this.title;
  }

  setTitle(nextTitle: string): void {
    log(`BrowserWindow#${this.id}.setTitle`, [nextTitle]);
    this.title = nextTitle;
  }

  getBounds(): { height: number; width: number; x: number; y: number } {
    log(`BrowserWindow#${this.id}.getBounds`, []);
    return { ...this.bounds };
  }

  getNormalBounds(): { height: number; width: number; x: number; y: number } {
    log(`BrowserWindow#${this.id}.getNormalBounds`, []);
    return { ...this.bounds };
  }

  setBounds(nextBounds: {
    height?: number;
    width?: number;
    x?: number;
    y?: number;
  }): void {
    log(`BrowserWindow#${this.id}.setBounds`, [nextBounds]);
    this.bounds = {
      x: nextBounds.x ?? this.bounds.x,
      y: nextBounds.y ?? this.bounds.y,
      width: nextBounds.width ?? this.bounds.width,
      height: nextBounds.height ?? this.bounds.height,
    };
  }

  show(): void {
    log(`BrowserWindow#${this.id}.show`, []);
  }

  hide(): void {
    log(`BrowserWindow#${this.id}.hide`, []);
  }

  focus(): void {
    log(`BrowserWindow#${this.id}.focus`, []);
    BrowserWindow.focusedWindow = this;
    this.emitter.emit("focus");
  }
}

class WebContentsView {
  constructor(...args: unknown[]) {
    log("new WebContentsView", args);
  }
}

class Menu {
  static applicationMenu: Menu | null = null;
  items: MenuItem[] = [];

  constructor(items: MenuItem[] = []) {
    this.items = items;
  }

  static buildFromTemplate(template: unknown[]): Menu {
    log("Menu.buildFromTemplate", [template]);
    const items = template.map((entry) => new MenuItem(entry));
    return new Menu(items);
  }

  static setApplicationMenu(menu: Menu | null): void {
    log("Menu.setApplicationMenu", [menu]);
    Menu.applicationMenu = menu;
  }

  static getApplicationMenu(): Menu | null {
    log("Menu.getApplicationMenu", []);
    return Menu.applicationMenu;
  }

  getMenuItemById(id: string): MenuItem | undefined {
    log("Menu.getMenuItemById", [id]);
    const queue = [...this.items];
    while (queue.length > 0) {
      const candidate = queue.shift();
      if (!candidate) {
        continue;
      }
      if (candidate.id === id) {
        return candidate;
      }
      if (candidate.submenu) {
        queue.push(...candidate.submenu.items);
      }
    }
    return undefined;
  }

  append(item: MenuItem): void {
    log("Menu.append", [item]);
    this.items.push(item);
  }

  insert(pos: number, item: MenuItem): void {
    log("Menu.insert", [pos, item]);
    const index = Math.max(0, Math.min(pos, this.items.length));
    this.items.splice(index, 0, item);
  }

  popup(...args: unknown[]): void {
    log("Menu.popup", args);
    // Browser clients cannot present native menus. The desktop app resolves
    // renderer invokes (codex_desktop:show-context-menu) through the popup
    // completion callback, so report "closed without selection" instead of
    // leaving those invokes pending forever.
    const [options] = args as [{ callback?: unknown }?];
    const callback = options?.callback;
    if (typeof callback === "function") {
      setImmediate(() => (callback as () => void)());
    }
  }

  closePopup(...args: unknown[]): void {
    log("Menu.closePopup", args);
  }
}

class MenuItem {
  checked?: boolean;
  click?: (...args: unknown[]) => unknown;
  enabled?: boolean;
  id?: string;
  label?: string;
  role?: string;
  submenu?: Menu;
  type?: string;
  visible?: boolean;

  constructor(...args: unknown[]) {
    log("new MenuItem", args);
    const [options] = args as [Record<string, unknown>?];
    if (!options || typeof options !== "object") {
      return;
    }
    this.checked =
      typeof options.checked === "boolean" ? options.checked : undefined;
    this.click =
      typeof options.click === "function"
        ? (options.click as (...args: unknown[]) => unknown)
        : undefined;
    this.enabled =
      typeof options.enabled === "boolean" ? options.enabled : undefined;
    this.id = typeof options.id === "string" ? options.id : undefined;
    this.label = typeof options.label === "string" ? options.label : undefined;
    this.role = typeof options.role === "string" ? options.role : undefined;
    this.type = typeof options.type === "string" ? options.type : undefined;
    this.visible =
      typeof options.visible === "boolean" ? options.visible : undefined;

    const submenu = options.submenu;
    if (Array.isArray(submenu)) {
      this.submenu = Menu.buildFromTemplate(submenu);
      return;
    }
    if (submenu instanceof Menu) {
      this.submenu = submenu;
    }
  }
}

class Tray {
  constructor(...args: unknown[]) {
    log("new Tray", args);
  }
}

class Notification {
  constructor(...args: unknown[]) {
    log("new Notification", args);
  }

  show(): void {
    log("Notification.show", []);
  }
}

const dialog = {
  async showMessageBox(...args: unknown[]): Promise<{ response: number }> {
    log("dialog.showMessageBox", args);
    return { response: 0 };
  },
};

const crashReporter = {
  start(...args: unknown[]): void {
    log("crashReporter.start", args);
  },
};

const net = {
  async fetch(input: string | URL, init?: RequestInit): Promise<Response> {
    // log("net.fetch", [input, init]);
    if (typeof globalThis.fetch === "function") {
      return globalThis.fetch(input as URL | RequestInfo, init);
    }
    return new Response("", { status: 204 });
  },
  request(...args: unknown[]): {
    getHeader: (name: string) => string | undefined;
    once: (event: string, listener: StubListener) => unknown;
    setHeader: (name: string, value: string) => void;
  } {
    // log("net.request", args);
    const headers = new Map<string, string>();
    const request = {
      setHeader(name: string, value: string): void {
        // log("net.request.setHeader", [name, value]);
        headers.set(name.toLowerCase(), value);
      },
      getHeader(name: string): string | undefined {
        // log("net.request.getHeader", [name]);
        return headers.get(name.toLowerCase());
      },
      once(event: string, listener: StubListener): unknown {
        // log("net.request.once", [event, listener]);
        return request;
      },
    };
    return request;
  },
};

const autoUpdater = createEmitterStub("autoUpdater");
const ipcMain = createIpcMainStub();
const nativeTheme = {
  ...createEmitterStub("nativeTheme"),
  shouldUseDarkColors: false,
  shouldUseHighContrastColors: false,
  shouldUseInvertedColorScheme: false,
  themeSource: "system",
};
const nativeImage = {
  createEmpty(): { isEmpty: () => boolean } {
    log("nativeImage.createEmpty", []);
    return {
      isEmpty: () => true,
    };
  },
  createFromPath(imagePath: string): { isEmpty: () => boolean } {
    log("nativeImage.createFromPath", [imagePath]);
    return {
      isEmpty: () => !imagePath,
    };
  },
};
const powerMonitor = createEmitterStub("powerMonitor");
const screen = {
  ...createEmitterStub("screen"),
  getAllDisplays(): Array<{
    id: number;
    scaleFactor: number;
    size: { height: number; width: number };
    workArea: { height: number; width: number; x: number; y: number };
    workAreaSize: { height: number; width: number };
    bounds: { height: number; width: number; x: number; y: number };
  }> {
    log("screen.getAllDisplays", []);
    return [this.getPrimaryDisplay()];
  },
  getDisplayMatching(): {
    id: number;
    scaleFactor: number;
    size: { height: number; width: number };
    workArea: { height: number; width: number; x: number; y: number };
    workAreaSize: { height: number; width: number };
    bounds: { height: number; width: number; x: number; y: number };
  } {
    log("screen.getDisplayMatching", []);
    return this.getPrimaryDisplay();
  },
  getPrimaryDisplay(): {
    id: number;
    scaleFactor: number;
    size: { height: number; width: number };
    workArea: { height: number; width: number; x: number; y: number };
    workAreaSize: { height: number; width: number };
    bounds: { height: number; width: number; x: number; y: number };
  } {
    log("screen.getPrimaryDisplay", []);
    return {
      id: 1,
      scaleFactor: 2,
      size: { width: 1440, height: 900 },
      workArea: { x: 0, y: 0, width: 1440, height: 900 },
      workAreaSize: { width: 1440, height: 900 },
      bounds: { x: 0, y: 0, width: 1440, height: 900 },
    };
  },
};
const protocol = {
  registerSchemesAsPrivileged(...args: unknown[]): void {
    log("protocol.registerSchemesAsPrivileged", args);
  },
  handle(...args: unknown[]): void {
    log("protocol.handle", args);
  },
  registerStringProtocol(...args: unknown[]): void {
    log("protocol.registerStringProtocol", args);
  },
};
function createSessionStub(label: string): {
  cookies: {
    get: (...args: unknown[]) => Promise<unknown[]>;
    off: (event: string, listener: StubListener) => unknown;
    on: (event: string, listener: StubListener) => unknown;
    once: (event: string, listener: StubListener) => unknown;
    remove: (...args: unknown[]) => Promise<void>;
    removeListener: (event: string, listener: StubListener) => unknown;
    set: (...args: unknown[]) => Promise<void>;
  };
  getUserAgent: () => string;
  loadExtension: (extensionPath: string) => Promise<{
    id: string;
    name: string;
    path: string;
    version: string;
  }>;
  off: (event: string, listener: StubListener) => unknown;
  on: (event: string, listener: StubListener) => unknown;
  once: (event: string, listener: StubListener) => unknown;
  protocol: typeof protocol;
  removeListener: (event: string, listener: StubListener) => unknown;
  setPermissionCheckHandler: (...args: unknown[]) => void;
  setPermissionRequestHandler: (...args: unknown[]) => void;
  webRequest: {
    onBeforeRequest: (...args: unknown[]) => void;
    onBeforeSendHeaders: (...args: unknown[]) => void;
  };
} {
  const emitter = createEmitterStub(label);
  const cookiesEmitter = createEmitterStub(`${label}.cookies`);
  return {
    cookies: {
      async get(...args: unknown[]): Promise<unknown[]> {
        log(`${label}.cookies.get`, args);
        return [];
      },
      off: cookiesEmitter.off,
      on: cookiesEmitter.on,
      once: cookiesEmitter.once,
      async remove(...args: unknown[]): Promise<void> {
        log(`${label}.cookies.remove`, args);
      },
      removeListener: cookiesEmitter.removeListener,
      async set(...args: unknown[]): Promise<void> {
        log(`${label}.cookies.set`, args);
      },
    },
    async loadExtension(extensionPath: string): Promise<{
      id: string;
      name: string;
      path: string;
      version: string;
    }> {
      log(`${label}.loadExtension`, [extensionPath]);
      return {
        id: "stub-extension",
        name: "Stub Extension",
        path: extensionPath,
        version: "0.0.0",
      };
    },
    getUserAgent(): string {
      log(`${label}.getUserAgent`, []);
      return "Mozilla/5.0 AppleWebKit/537.36 Chrome/120 Safari/537.36";
    },
    off: emitter.off,
    on: emitter.on,
    once: emitter.once,
    protocol,
    removeListener: emitter.removeListener,
    setPermissionCheckHandler(...args: unknown[]): void {
      log(`${label}.setPermissionCheckHandler`, args);
    },
    setPermissionRequestHandler(...args: unknown[]): void {
      log(`${label}.setPermissionRequestHandler`, args);
    },
    webRequest: {
      onBeforeRequest(...args: unknown[]): void {
        log(`${label}.webRequest.onBeforeRequest`, args);
      },
      onBeforeSendHeaders(...args: unknown[]): void {
        log(`${label}.webRequest.onBeforeSendHeaders`, args);
      },
    },
  };
}
const partitionSessions = new Map<
  string,
  ReturnType<typeof createSessionStub>
>();
const session = {
  defaultSession: createSessionStub("session.defaultSession"),
  fromPartition(partition: string): ReturnType<typeof createSessionStub> {
    log("session.fromPartition", [partition]);
    let partitionSession = partitionSessions.get(partition);
    if (!partitionSession) {
      partitionSession = createSessionStub("session.partition");
      partitionSessions.set(partition, partitionSession);
    }
    return partitionSession;
  },
};
const utilityProcess = {
  fork: undefined,
};
const webContents = {
  fromId(id: number): Record<string, unknown> | undefined {
    log("webContents.fromId", [id]);
    return BrowserWindow.getAllWindows().find(
      (window) => window.webContents.id === id,
    )?.webContents;
  },
  getAllWebContents(): Record<string, unknown>[] {
    log("webContents.getAllWebContents", []);
    return BrowserWindow.getAllWindows().map((window) => window.webContents);
  },
  getFocusedWebContents(): Record<string, unknown> | null {
    log("webContents.getFocusedWebContents", []);
    return BrowserWindow.getFocusedWindow()?.webContents ?? null;
  },
};
class MessageChannelMain {
  port1 = createMessagePortStub("MessageChannelMain.port1");
  port2 = createMessagePortStub("MessageChannelMain.port2");
}

const electronModule = withDeepStubFallback(
  {
    app,
    BrowserWindow,
    ipcMain,
    autoUpdater,
    crashReporter,
    MessageChannelMain,
    Menu,
    MenuItem,
    net,
    nativeImage,
    nativeTheme,
    Notification,
    powerMonitor,
    protocol,
    screen,
    session,
    Tray,
    utilityProcess,
    WebContentsView,
    webContents,
    dialog,
  } as Record<string, unknown>,
  "electron",
);

export {
  app,
  autoUpdater,
  BrowserWindow,
  ipcMain,
  Menu,
  MenuItem,
  MessageChannelMain,
  net,
  nativeImage,
  nativeTheme,
  Notification,
  powerMonitor,
  protocol,
  screen,
  session,
  Tray,
  utilityProcess,
  WebContentsView,
  webContents,
  crashReporter,
  dialog,
};
export default electronModule;
