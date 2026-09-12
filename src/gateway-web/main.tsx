import React, { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  GatewayClient,
  GatewayRequestError,
  type BackendSummary,
} from "../client/gateway-client";
import "./style.css";

const cached = <T,>(key: string, fallback: T): T => {
  try {
    return JSON.parse(localStorage.getItem(key) ?? "null") ?? fallback;
  } catch {
    return fallback;
  }
};
const save = (key: string, value: unknown) => {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* Cache capacity must not block execution. */
  }
};
const statusLabel = (value: string) =>
  ({
    inProgress: "Running",
    running: "Running",
    awaiting_approval: "Needs your approval",
    received: "Received by server",
    dispatching: "Awaiting runtime",
    accepted: "Accepted by runtime",
    unknown: "Delivery unknown",
    delivery_unknown: "Delivery unknown",
    failed: "Failed",
    creating: "Creating conversation",
    ready: "Ready",
  })[value] ?? value?.replaceAll("_", " ");

function App() {
  const [server, setServer] = useState(
    cached(
      "codex.gateway",
      location.protocol.startsWith("http") ? location.origin : "",
    ),
  );
  const [token, setToken] = useState("");
  const [client, setClient] = useState<GatewayClient | null>(null);
  const [backends, setBackends] = useState<BackendSummary[]>([]);
  const [backendId, setBackendId] = useState("");
  const [sessions, setSessions] = useState<any[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [state, setState] = useState<any>(null);
  const [text, setText] = useState("");
  const [attachments, setAttachments] = useState<any[]>([]);
  const [busy, setBusy] = useState(false);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState("");
  const [menu, setMenu] = useState(false);
  const [panel, setPanel] = useState<
    "files" | "import" | "terminal" | "remote" | null
  >(null);
  const [directory, setDirectory] = useState<any>(null);
  const [threads, setThreads] = useState<any[]>([]);
  const [remote, setRemote] = useState<any>(null);
  const [outbox, setOutbox] = useState<any>(null);
  const lastNotified = useRef<string | null>(null);
  const end = useRef<HTMLDivElement>(null);
  const terminalEl = useRef<HTMLDivElement>(null);
  const backend = backends.find((b) => b.id === backendId);
  const namespace = `codex.gateway:${server}`;
  const handle = async (operation: () => Promise<void>) => {
    setError("");
    try {
      await operation();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };
  const refresh = async (api: GatewayClient) => {
    const [b, s] = await Promise.all([
      api.request<BackendSummary[]>("api/v1/backends"),
      api.request<any[]>("api/v1/sessions"),
    ]);
    setBackends(b);
    setSessions(s);
    save(`${namespace}:sessions`, s);
    save(`${namespace}:backends`, b);
    setBackendId((id) => (b.some((v) => v.id === id) ? id : (b[0]?.id ?? "")));
  };
  const select = (session: any) => {
    setSelected(session.id);
    setBackendId(session.backendId);
    setMenu(false);
    setPanel(null);
    setAttachments([]);
    setState(cached(`${namespace}:snapshot:${session.id}`, null));
    setText(cached(`${namespace}:draft:${session.id}`, ""));
    location.hash = session.id;
    client?.subscribe(session.id, 0);
  };
  const clearOutbox = () => {
    setOutbox(null);
    save(`${namespace}:outbox`, null);
  };
  useEffect(() => {
    if (!client) return;
    let refreshTimer: ReturnType<typeof setTimeout> | null = null;
    const onMessage = (event: Event) => {
      const message = (event as CustomEvent).detail;
      if (message.type === "sync") {
        setState(message);
        const status = message.snapshot?.status;
        if (
          document.hidden &&
          status === "completed" &&
          lastNotified.current !== message.snapshot.id
        ) {
          lastNotified.current = message.snapshot.id;
          if ("Notification" in window && Notification.permission === "granted")
            new Notification(message.snapshot.title || "Codex task completed");
        }
        const serialized = JSON.stringify(message);
        if (serialized.length < 500_000)
          save(`${namespace}:snapshot:${message.snapshot.id}`, message);
      }
      if (message.type === "backends") setBackends(message.backends);
      if (["ready", "sessions.changed"].includes(message.type) && !refreshTimer)
        refreshTimer = setTimeout(() => {
          refreshTimer = null;
          void refresh(client).catch(() => {});
        }, 500);
      if (message.type === "error") setError(message.error);
    };
    const onConnection = (event: Event) =>
      setConnected((event as CustomEvent).detail);
    const onError = (event: Event) => setError((event as CustomEvent).detail);
    client.addEventListener("message", onMessage);
    client.addEventListener("connection", onConnection);
    client.addEventListener("error", onError);
    client.start();
    return () => {
      client.removeEventListener("message", onMessage);
      client.removeEventListener("connection", onConnection);
      client.removeEventListener("error", onError);
      if (refreshTimer) clearTimeout(refreshTimer);
      client.close();
    };
  }, [client]);
  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;
    if (!/^https?:$/.test(location.protocol)) return;
    void navigator.serviceWorker.register("./sw.js").catch(() => {});
  }, []);
  useEffect(() => {
    end.current?.scrollIntoView({ behavior: "smooth" });
  }, [state?.snapshot?.seq]);
  useEffect(() => {
    if (panel !== "terminal" || !client || !terminalEl.current) return;
    let disposed = false;
    let ws: WebSocket | null = null;
    let terminal: any;
    let observer: ResizeObserver | null = null;
    void (async () => {
      const [{ Terminal }, { FitAddon }] = await Promise.all([
        import("@xterm/xterm"),
        import("@xterm/addon-fit"),
        import("@xterm/xterm/css/xterm.css"),
      ]);
      if (disposed) return;
      terminal = new Terminal({
        cursorBlink: true,
        fontSize: 13,
        theme: { background: "#101817" },
      });
      const fit = new FitAddon();
      terminal.loadAddon(fit);
      terminal.open(terminalEl.current!);
      fit.fit();
      ws = client.terminal(backendId, terminal.cols, terminal.rows, selected);
      ws.onmessage = (event) => {
        const m = JSON.parse(event.data);
        terminal.write(m.type === "output" ? m.data : `\r\n${m.error}\r\n`);
      };
      ws.onclose = () =>
        terminal.write("\r\nTerminal detached. Reopen to reconnect.\r\n");
      terminal.onData((data: string) => {
        if (ws?.readyState === WebSocket.OPEN)
          ws.send(JSON.stringify({ type: "input", data }));
      });
      observer = new ResizeObserver(() => {
        fit.fit();
        if (ws?.readyState === WebSocket.OPEN)
          ws.send(
            JSON.stringify({
              type: "resize",
              cols: terminal.cols,
              rows: terminal.rows,
            }),
          );
      });
      observer.observe(terminalEl.current!);
    })().catch((e) => setError(e.message));
    return () => {
      disposed = true;
      observer?.disconnect();
      ws?.close();
      terminal?.dispose();
    };
  }, [panel, client, backendId, selected]);
  const deliver = async (entry: any) => {
    if (!client) return;
    setOutbox(entry);
    save(`${namespace}:outbox`, entry);
    try {
      const command = await client.request(entry.route, entry.body);
      clearOutbox();
      if (entry.create) {
        await refresh(client);
        const s = await client.request(`api/v1/sessions/${command.sessionId}`);
        select(s.snapshot);
        setState(s);
      } else {
        setText("");
        setAttachments([]);
        save(`${namespace}:draft:${command.sessionId}`, "");
        if (command.sessionId !== selected) {
          const s = await client.request(
            `api/v1/sessions/${command.sessionId}`,
          );
          select(s.snapshot);
          setState(s);
        }
      }
    } catch (error) {
      // Preserve network and server failures for safe idempotent retry. A
      // client rejection cannot be repaired by resending the same payload.
      if (error instanceof GatewayRequestError && error.status < 500)
        clearOutbox();
      throw error;
    }
  };
  const create = (threadId?: string, conversationKind = "codex") =>
    handle(async () => {
      setBusy(true);
      try {
        await deliver({
          create: true,
          route: "api/v1/sessions",
          body: {
            clientCommandId: crypto.randomUUID(),
            backendId,
            ...(threadId
              ? conversationKind === "chatgpt"
                ? { conversationKind, conversationId: threadId }
                : { threadId }
              : {}),
          },
        });
      } finally {
        setBusy(false);
      }
    });
  const send = (method = "turn/start") =>
    handle(async () => {
      if (!selected || !client) return;
      const native = state?.snapshot?.conversationKind === "chatgpt";
      if (native) method = "chatgpt/send";
      if (method !== "turn/interrupt" && !text.trim() && !attachments.length)
        throw new Error("Enter a message or attach a file before sending");
      setBusy(true);
      try {
        const active = state?.snapshot.thread?.turns?.find(
          (t: any) => t.status === "inProgress",
        );
        const input = [
          ...(text.trim() ? [{ type: "text", text: text.trim() }] : []),
          ...attachments.map((a) =>
            a.image
              ? { type: "localImage", path: a.path }
              : { type: "text", text: `Attached file on this host: ${a.path}` },
          ),
        ];
        const params = native
          ? { prompt: text.trim() }
          : method === "turn/interrupt"
            ? { turnId: active?.id }
            : {
                input,
                ...(method === "turn/steer"
                  ? { expectedTurnId: active?.id }
                  : {}),
              };
        await deliver({
          route: `api/v1/sessions/${selected}/commands`,
          body: { clientCommandId: crypto.randomUUID(), method, params },
        });
      } finally {
        setBusy(false);
      }
    });
  const login = () =>
    handle(async () => {
      setBusy(true);
      try {
        const api = new GatewayClient(server, token);
        setSessions(cached(`${namespace}:sessions`, []));
        setBackends(cached(`${namespace}:backends`, []));
        await api.login();
        save("codex.gateway", server);
        setClient(api);
        setToken("");
        setOutbox(cached(`${namespace}:outbox`, null));
        await refresh(api);
        const sessionId = location.hash.slice(1);
        if (sessionId) {
          const s = await api.request(
            `api/v1/sessions/${encodeURIComponent(sessionId)}`,
          );
          setSelected(s.snapshot.id);
          setBackendId(s.snapshot.backendId);
          setState(s);
          api.subscribe(s.snapshot.id);
        }
      } finally {
        setBusy(false);
      }
    });
  const showFiles = (path = ".") =>
    handle(async () => {
      if (!client) return;
      setPanel("files");
      setDirectory(
        await client.request(
          `api/v1/backends/${backendId}/files?path=${encodeURIComponent(path)}${selected ? `&sessionId=${encodeURIComponent(selected)}` : ""}`,
        ),
      );
    });
  const showRemote = () =>
    handle(async () => {
      if (!client) return;
      setPanel("remote");
      setRemote(
        await client.request(
          `api/v1/backends/${encodeURIComponent(backendId)}/remote-control`,
        ),
      );
    });
  const remoteAction = (action: string, body: any = {}) =>
    handle(async () => {
      if (!client) return;
      setRemote(
        await client.request(
          `api/v1/backends/${encodeURIComponent(backendId)}/remote-control/${encodeURIComponent(action)}`,
          body,
        ),
      );
    });
  const latest = state?.commands?.[0];
  const activeTurn = state?.snapshot.thread?.turns?.find(
    (t: any) => t.status === "inProgress",
  );
  const current = state?.snapshot?.id === selected ? state.snapshot : null;
  const canAttach =
    current?.conversationKind === "chatgpt"
      ? backend?.capabilities.chatgptAttachments
      : backend?.capabilities.attachments || backend?.capabilities.files;
  const openExisting = () =>
    handle(async () => {
      if (!client) return;
      const codex = await client.request(
        `api/v1/backends/${backendId}/threads`,
      );
      const native = backend?.capabilities.chatgpt
        ? await client.request(
            `api/v1/backends/${backendId}/threads?kind=chatgpt`,
          )
        : { data: [] };
      setThreads([...(codex.data ?? []), ...(native.data ?? [])]);
      setPanel("import");
      setMenu(false);
    });

  if (!client)
    return (
      <main className="login">
        <div className="login-card">
          <div className="brand-mark">⌘</div>
          <p className="eyebrow">CODEX WEB</p>
          <h1>
            Your work continues.
            <br />
            Take the conversation with you.
          </h1>
          <p className="muted">
            Connect to your session server to work across your computers.
          </p>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void login();
            }}
          >
            <label>
              Server URL
              <input
                type="url"
                placeholder="https://codex.example.com"
                value={server}
                onChange={(e) => setServer(e.target.value)}
                required
              />
            </label>
            <label>
              Access token
              <input
                type="password"
                value={token}
                onChange={(e) => setToken(e.target.value)}
                autoComplete="off"
                required
              />
            </label>
            {error && (
              <p className="error" role="alert">
                {error}
              </p>
            )}
            <button className="primary" disabled={busy}>
              {busy ? "Connecting…" : "Connect to server →"}
            </button>
          </form>
          <p className="fine">
            Your computer runs the task. You can close this app and return
            later.
          </p>
        </div>
      </main>
    );

  return (
    <div className="app">
      <aside className={menu ? "sidebar open" : "sidebar"}>
        <div className="brand">
          <span className="brand-mark small">⌘</span> Codex Web{" "}
          <button
            className="mobile-only icon"
            aria-label="Close navigation"
            onClick={() => setMenu(false)}
          >
            ×
          </button>
        </div>
        <label className="eyebrow">
          COMPUTER
          <select
            aria-label="Computer"
            disabled={busy}
            value={backendId}
            onChange={(e) => {
              client.unsubscribe();
              location.hash = "";
              setBackendId(e.target.value);
              setSelected(null);
              setState(null);
              setAttachments([]);
              setPanel(null);
            }}
          >
            {backends.map((b) => (
              <option key={b.id} value={b.id}>
                {b.label}
                {b.connected ? "" : " · Offline"}
              </option>
            ))}
          </select>
        </label>
        <button
          className="new-session"
          onClick={() =>
            void (backend?.transport === "desktop" ? openExisting() : create())
          }
          disabled={!backendId || busy || !!outbox}
        >
          {backend?.transport === "desktop"
            ? "Open Desktop conversation"
            : "+ New conversation"}
        </button>
        <div className="sidebar-tools">
          <button onClick={() => void openExisting()}>Existing threads</button>
          <button
            disabled={!backend?.capabilities.files}
            onClick={() => void showFiles()}
          >
            Files
          </button>
          <button
            disabled={!backend?.capabilities.terminal}
            onClick={() => {
              setPanel("terminal");
              setMenu(false);
            }}
          >
            Terminal
          </button>
          <button
            disabled={!backend?.capabilities.remoteControl}
            onClick={() => void showRemote()}
          >
            Official Remote
          </button>
        </div>
        <p className="eyebrow recent-label">RECENT CONVERSATIONS</p>
        <nav>
          {sessions
            .filter((s) => s.backendId === backendId)
            .map((s) => (
              <button
                className={`session ${s.id === selected ? "selected" : ""}`}
                key={s.id}
                disabled={busy}
                onClick={() => select(s)}
              >
                <span>{s.title}</span>
                <small>{statusLabel(s.status)}</small>
              </button>
            ))}
        </nav>
        <div className="sidebar-footer">
          <span className={`dot ${connected ? "online" : ""}`} />{" "}
          {connected ? "Connected to server" : "Reconnecting…"}
          <button
            onClick={() => {
              client.close();
              setClient(null);
              setConnected(false);
              setState(null);
              setSelected(null);
              setPanel(null);
              for (let i = localStorage.length - 1; i >= 0; i--) {
                const key = localStorage.key(i);
                if (key?.startsWith(namespace)) localStorage.removeItem(key);
              }
            }}
          >
            Sign out
          </button>
        </div>
      </aside>
      {menu && (
        <button
          className="scrim"
          aria-label="Close navigation"
          onClick={() => setMenu(false)}
        />
      )}
      <main className="workspace">
        <header>
          <button
            className="mobile-only icon"
            aria-label="Open navigation"
            onClick={() => setMenu(true)}
          >
            ☰
          </button>
          <div>
            <h2>{current?.title ?? backend?.label ?? "Choose a computer"}</h2>
            <p className="muted host-path">
              {current?.conversationKind === "chatgpt"
                ? "ChatGPT on Desktop"
                : (current?.cwd ?? backend?.cwd)}
            </p>
          </div>
          {backend?.desktop && (
            <small className="muted">Desktop {backend.desktop.version}</small>
          )}
          <span className="status-pill">
            {current
              ? statusLabel(current.status)
              : backend?.connected
                ? "Ready"
                : "Offline"}
          </span>
        </header>
        {error && (
          <div className="notice error" role="alert">
            {error}
            <button aria-label="Dismiss error" onClick={() => setError("")}>
              ×
            </button>
          </div>
        )}
        {!connected && (
          <div className="notice">
            Showing saved state. Tasks already accepted by the computer continue
            while this view reconnects.
          </div>
        )}
        {outbox && (
          <div className="notice warning">
            Submission has not been confirmed by the server.
            <button onClick={() => void handle(() => deliver(outbox))}>
              Retry delivery
            </button>
          </div>
        )}
        {latest &&
          ["received", "dispatching", "unknown", "failed"].includes(
            latest.state,
          ) && (
            <div className="notice warning">
              <strong>{statusLabel(latest.state)}</strong>{" "}
              {latest.error ?? "The server is handling your request."}
              {latest.state === "unknown" && (
                <button
                  onClick={() =>
                    void handle(async () =>
                      setState(
                        await client.request(
                          `api/v1/sessions/${selected}/reconcile`,
                          {},
                        ),
                      ),
                    )
                  }
                >
                  Check runtime history
                </button>
              )}
            </div>
          )}
        {panel ? (
          <section className="panel">
            <div className="panel-heading">
              <h2>
                {panel === "terminal"
                  ? "Terminal"
                  : panel === "files"
                    ? "Workspace files"
                    : panel === "remote"
                      ? "Official Remote"
                      : "Existing threads"}
              </h2>
              <button onClick={() => setPanel(null)}>Close</button>
            </div>
            {panel === "terminal" && (
              <div ref={terminalEl} className="terminal" />
            )}
            {panel === "remote" && (
              <div className="remote-panel">
                <p className="muted">
                  This uses Codex&apos;s official host relay. Pairing is handled
                  by Codex; this gateway does not expose the relay credential.
                </p>
                <pre>{JSON.stringify(remote, null, 2)}</pre>
                <div className="panel-actions">
                  <button onClick={() => void remoteAction("enable", {})}>
                    Enable remote host
                  </button>
                  <button
                    onClick={() => void remoteAction("pairing/start", {})}
                  >
                    Create pairing code
                  </button>
                  <button
                    onClick={() =>
                      void remoteAction("pairing/start", { manualCode: true })
                    }
                  >
                    Create manual code
                  </button>
                  <button onClick={() => void showRemote()}>
                    Refresh status
                  </button>
                </div>
              </div>
            )}
            {panel === "import" &&
              threads.map((t) => (
                <button
                  className="file-row"
                  key={`${t.conversationKind ?? "codex"}:${t.id}`}
                  onClick={() => void create(t.id, t.conversationKind)}
                >
                  {t.conversationKind === "chatgpt" ? "ChatGPT · " : ""}
                  {t.name || t.preview || t.id}
                </button>
              ))}
            {panel === "files" && directory && (
              <>
                <p className="muted">{directory.path}</p>
                {directory.path !== directory.root && (
                  <button
                    onClick={() => void showFiles(directory.path + "/..")}
                  >
                    ↑ Parent folder
                  </button>
                )}
                {directory.entries.map((entry: any) => (
                  <button
                    className="file-row"
                    key={entry.path}
                    onClick={() =>
                      entry.directory
                        ? void showFiles(entry.path)
                        : void handle(async () => {
                            const blob = await client.download(
                              backendId,
                              entry.path,
                              selected,
                            );
                            const url = URL.createObjectURL(blob);
                            const a = document.createElement("a");
                            a.href = url;
                            a.download = entry.name;
                            a.click();
                            setTimeout(() => URL.revokeObjectURL(url), 1000);
                          })
                    }
                  >
                    {entry.directory ? "▸" : "↓"} {entry.name}
                  </button>
                ))}
              </>
            )}
          </section>
        ) : !current ? (
          <section className="empty">
            <div className="brand-mark">⌘</div>
            <h1>A workspace, wherever you are.</h1>
            <p className="muted">
              Start a conversation on {backend?.label ?? "your computer"},<br />
              or open a recent task from the sidebar.
            </p>
            <button
              className="primary"
              disabled={!backendId || busy || !!outbox}
              onClick={() =>
                void (backend?.transport === "desktop"
                  ? openExisting()
                  : create())
              }
            >
              {backend?.transport === "desktop"
                ? "Open Desktop conversation"
                : "New conversation"}
            </button>
          </section>
        ) : (
          <>
            <section className="conversation" aria-label="Conversation">
              {(
                current.nativeConversation?.turns ??
                current.thread?.turns ??
                []
              ).map((turn: any) => (
                <React.Fragment key={turn.id}>
                  {(turn.items ?? []).map((item: any, index: number) => (
                    <Message
                      key={item.id ?? index}
                      item={item}
                      native={current.conversationKind === "chatgpt"}
                    />
                  ))}
                  {turn.error && <p className="error">{turn.error.message}</p>}
                </React.Fragment>
              ))}
              {current.thread?.historyTruncated && (
                <p className="muted">
                  Showing recent Desktop history. Earlier history and full
                  output remain available in Desktop.
                </p>
              )}
              {current.conversationKind === "chatgpt" && (
                <p className="muted">
                  ChatGPT on Desktop · Recent history refreshes automatically.
                  Attachments and Computer Use controls are available in
                  Desktop.
                </p>
              )}
              {!(current.nativeConversation?.turns ?? current.thread?.turns)
                ?.length && (
                <p className="muted start-hint">
                  What would you like to work on?
                </p>
              )}
              {state.approvals?.map((approval: any) => (
                <ApprovalCard
                  key={approval.id}
                  approval={approval}
                  onAnswer={(result) =>
                    void handle(async () => {
                      await client.request(
                        `api/v1/approvals/${approval.id}`,
                        result,
                      );
                    })
                  }
                />
              ))}
              <div ref={end} />
            </section>
            <form
              className="composer"
              onSubmit={(e) => {
                e.preventDefault();
                void send(activeTurn ? "turn/steer" : "turn/start");
              }}
            >
              <textarea
                aria-label="Message"
                placeholder={
                  current.conversationKind === "chatgpt"
                    ? "Send a message to ChatGPT…"
                    : activeTurn
                      ? "Add guidance while your task runs…"
                      : "Send a task to this computer…"
                }
                value={text}
                onChange={(e) => {
                  setText(e.target.value);
                  save(`${namespace}:draft:${selected}`, e.target.value);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                    e.preventDefault();
                    void send(activeTurn ? "turn/steer" : "turn/start");
                  }
                }}
                rows={3}
              />
              <div className="attachments">
                {attachments.map((a) => (
                  <span key={a.path}>
                    {a.name}
                    <button
                      type="button"
                      aria-label={`Remove ${a.name}`}
                      onClick={() =>
                        setAttachments(
                          attachments.filter((v) => v.path !== a.path),
                        )
                      }
                    >
                      ×
                    </button>
                  </span>
                ))}
              </div>
              <div className="composer-actions">
                <label
                  className={`attach ${!canAttach || busy ? "disabled" : ""}`}
                >
                  + Attach
                  <input
                    type="file"
                    multiple
                    accept={
                      backend?.transport === "desktop"
                        ? "image/png,image/jpeg,image/gif,image/webp"
                        : undefined
                    }
                    disabled={!canAttach || busy}
                    onChange={(e) => {
                      const files = Array.from(e.target.files ?? []);
                      e.target.value = "";
                      void handle(async () => {
                        setBusy(true);
                        try {
                          for (const file of files) {
                            if (
                              backend?.transport === "desktop" &&
                              file.size > 5 * 1024 * 1024
                            )
                              throw new Error(
                                "Desktop image upload exceeds 5 MiB",
                              );
                            const result = await client.upload(
                              backendId,
                              file,
                              selected,
                            );
                            setAttachments((a) => [
                              ...a,
                              {
                                ...result,
                                image: file.type.startsWith("image/"),
                              },
                            ]);
                          }
                        } finally {
                          setBusy(false);
                        }
                      });
                    }}
                  />
                </label>
                <span className="fine">
                  {busy
                    ? "Sending to computer…"
                    : "Work stays on your computer"}
                </span>
                {activeTurn && (
                  <button
                    type="button"
                    disabled={busy || !!outbox}
                    onClick={() => void send("turn/interrupt")}
                  >
                    Stop
                  </button>
                )}
                <button
                  className="primary"
                  disabled={
                    busy ||
                    !!outbox ||
                    (current.conversationKind === "chatgpt" &&
                      current.status === "running") ||
                    (!text.trim() && !attachments.length) ||
                    (!current.threadId && !current.conversationId)
                  }
                >
                  {activeTurn ? "Guide task ↑" : "Send ↑"}
                </button>
              </div>
            </form>
          </>
        )}
      </main>
    </div>
  );
}

function Message({ item, native = false }: { item: any; native?: boolean }) {
  if (item.type === "userMessage")
    return (
      <article className="message user">
        <p className="message-role">YOU</p>
        <div>
          {(item.content ?? []).map((c: any, i: number) => (
            <p key={i}>
              {c.text ??
                (c.type?.toLowerCase().includes("image")
                  ? "Image attachment"
                  : "Attachment")}
            </p>
          ))}
        </div>
      </article>
    );
  if (item.type === "agentMessage")
    return (
      <article className="message assistant">
        <p className="message-role">{native ? "CHATGPT" : "CODEX"}</p>
        <div className="message-text">{item.text}</div>
      </article>
    );
  return (
    <details className="tool">
      <summary>
        {item.type === "commandExecution"
          ? `$ ${item.command ?? "Command"}`
          : item.type}{" "}
        <span>{item.status}</span>
      </summary>
      <pre>{item.aggregatedOutput ?? JSON.stringify(item, null, 2)}</pre>
    </details>
  );
}
function ApprovalCard({
  approval,
  onAnswer,
}: {
  approval: any;
  onAnswer: (result: any) => void;
}) {
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const questions = approval.params.questions ?? [];
  return (
    <article className="approval">
      <p className="eyebrow">YOUR INPUT IS NEEDED</p>
      <h3>{approval.params.reason ?? "Review this request"}</h3>
      {approval.params.command && <pre>{approval.params.command}</pre>}
      {approval.params.cwd && <p className="muted">{approval.params.cwd}</p>}
      {approval.params.networkApprovalContext && (
        <pre>
          {JSON.stringify(approval.params.networkApprovalContext, null, 2)}
        </pre>
      )}
      {approval.method === "item/tool/requestUserInput" ? (
        <>
          {questions.map((q: any) => (
            <label key={q.id}>
              {q.question}
              {q.options?.length ? (
                <select
                  value={answers[q.id] ?? ""}
                  onChange={(e) =>
                    setAnswers({ ...answers, [q.id]: e.target.value })
                  }
                >
                  <option value="">Choose…</option>
                  {q.options.map((o: any) => (
                    <option key={o.label} value={o.label}>
                      {o.label} — {o.description}
                    </option>
                  ))}
                </select>
              ) : (
                <input
                  value={answers[q.id] ?? ""}
                  onChange={(e) =>
                    setAnswers({ ...answers, [q.id]: e.target.value })
                  }
                />
              )}
            </label>
          ))}
          <button
            disabled={
              approval.state !== "pending" ||
              questions.some((q: any) => !answers[q.id])
            }
            onClick={() =>
              onAnswer({
                answers: Object.fromEntries(
                  questions.map((q: any) => [
                    q.id,
                    { answers: [answers[q.id]] },
                  ]),
                ),
              })
            }
          >
            Send answer
          </button>
        </>
      ) : (
        <div className="approval-actions">
          {["decline", "accept", "cancel"]
            .filter(
              (d) =>
                !approval.params.availableDecisions ||
                approval.params.availableDecisions.includes(d),
            )
            .map((d) => (
              <button
                key={d}
                className={d === "accept" ? "primary" : ""}
                disabled={approval.state !== "pending"}
                onClick={() => onAnswer({ decision: d })}
              >
                {d === "accept"
                  ? "Allow once"
                  : d === "decline"
                    ? "Decline"
                    : "Cancel task"}
              </button>
            ))}
        </div>
      )}
      {approval.state === "responding" && (
        <p className="muted">Waiting for runtime confirmation…</p>
      )}
    </article>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
