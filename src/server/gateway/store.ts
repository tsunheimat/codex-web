import { DatabaseSync } from "node:sqlite";
import { mkdirSync, chmodSync } from "node:fs";
import path from "node:path";

export type Session = {
  id: string;
  backendId: string;
  threadId: string | null;
  cwd: string;
  title: string;
  status: string;
  seq: number;
  updatedAt: number;
  thread: any;
  connection: "connected" | "unavailable";
};
export type Command = {
  id: string;
  sessionId: string;
  method: string;
  fingerprint: string;
  state: "received" | "dispatching" | "accepted" | "failed" | "unknown";
  result?: any;
  error?: string;
};
export type Approval = {
  id: string;
  sessionId: string;
  epoch: string;
  requestId: string | number;
  method: string;
  params: any;
  state: "pending" | "responding" | "answered" | "stale";
};

/** The gateway's index and journal. Codex remains authoritative for history. */
export class SessionStore {
  private readonly db: DatabaseSync;
  constructor(
    filename: string,
    readonly eventLimit = 2048,
  ) {
    if (filename !== ":memory:")
      mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(filename);
    if (filename !== ":memory:") chmodSync(filename, 0o600);
    const version = this.db.prepare("PRAGMA user_version").get()?.user_version;
    if (typeof version === "number" && version > 1) {
      this.db.close();
      throw new Error("Gateway database requires a newer version");
    }
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, backend TEXT NOT NULL, thread TEXT, data TEXT NOT NULL);
      CREATE UNIQUE INDEX IF NOT EXISTS thread_owner ON sessions(backend, thread) WHERE thread IS NOT NULL;
      CREATE TABLE IF NOT EXISTS commands (id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS events (session TEXT NOT NULL, seq INTEGER NOT NULL, data TEXT NOT NULL, PRIMARY KEY(session, seq));
      CREATE TABLE IF NOT EXISTS approvals (id TEXT PRIMARY KEY, session TEXT NOT NULL, data TEXT NOT NULL);
      PRAGMA user_version=1;`);
    // Never replay an operation just because the gateway died before its reply.
    for (const row of this.db.prepare("SELECT data FROM commands").all()) {
      const command: Command = JSON.parse(String(row.data));
      if (command.state === "dispatching" || command.state === "received") {
        command.state = command.state === "dispatching" ? "unknown" : "failed";
        command.error =
          "Gateway restarted before acknowledgement; inspect authoritative history";
        this.putCommand(command);
      }
    }
    for (const session of this.list()) {
      this.save({ ...session, connection: "unavailable" });
      this.staleApprovals(session.id);
    }
  }

  transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  list(): Session[] {
    return this.db
      .prepare("SELECT data FROM sessions")
      .all()
      .map((row) => JSON.parse(String(row.data)))
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }
  get(id: string): Session {
    const row = this.db.prepare("SELECT data FROM sessions WHERE id=?").get(id);
    if (!row)
      throw Object.assign(new Error("Session not found"), { statusCode: 404 });
    return JSON.parse(String(row.data));
  }
  findThread(backend: string, thread: string): Session | undefined {
    if (typeof thread !== "string") return undefined;
    const row = this.db
      .prepare("SELECT data FROM sessions WHERE backend=? AND thread=?")
      .get(backend, thread);
    return row ? JSON.parse(String(row.data)) : undefined;
  }
  save(session: Session): void {
    this.db
      .prepare(
        "INSERT INTO sessions VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET thread=excluded.thread, data=excluded.data",
      )
      .run(
        session.id,
        session.backendId,
        session.threadId,
        JSON.stringify(session),
      );
  }
  event(
    id: string,
    type: string,
    payload: unknown,
    patch: Partial<Session> = {},
  ): Session {
    return this.transaction(() => {
      const current = this.get(id);
      const session = {
        ...current,
        ...patch,
        seq: current.seq + 1,
        updatedAt: Date.now(),
      };
      this.save(session);
      let event = JSON.stringify({
        version: 1,
        sessionId: id,
        seq: session.seq,
        type,
        payload,
      });
      if (Buffer.byteLength(event) > 64 * 1024)
        event = JSON.stringify({
          version: 1,
          sessionId: id,
          seq: session.seq,
          type,
          payload: { snapshotRequired: true },
        });
      this.db
        .prepare("INSERT INTO events VALUES (?, ?, ?)")
        .run(id, session.seq, event);
      this.db
        .prepare("DELETE FROM events WHERE session=? AND seq<=?")
        .run(id, session.seq - this.eventLimit);
      this.db
        .prepare(
          "DELETE FROM events WHERE session=? AND seq IN (SELECT seq FROM (SELECT seq, SUM(length(CAST(data AS BLOB))) OVER (ORDER BY seq DESC) AS bytes FROM events WHERE session=?) WHERE bytes>16777216)",
        )
        .run(id, id);
      return session;
    });
  }
  sync(id: string, afterSeq: number): any {
    // All reads execute synchronously on this owner, so the snapshot and cursor
    // share one boundary and cannot miss an event between HTTP and WS delivery.
    const snapshot = this.get(id);
    const first = this.db
      .prepare("SELECT MIN(seq) AS first FROM events WHERE session=?")
      .get(id)?.first;
    const reset =
      afterSeq > snapshot.seq ||
      (typeof first === "number" && afterSeq < first - 1);
    const events = reset
      ? []
      : this.db
          .prepare(
            "SELECT data FROM events WHERE session=? AND seq>? ORDER BY seq",
          )
          .all(id, afterSeq)
          .map((row) => JSON.parse(String(row.data)));
    return {
      version: 1,
      type: "sync",
      snapshot,
      events,
      reset,
      lastSeq: snapshot.seq,
      approvals: this.approvals(id),
      commands: this.commands(id),
    };
  }
  command(id: string): Command | undefined {
    const row = this.db.prepare("SELECT data FROM commands WHERE id=?").get(id);
    return row ? JSON.parse(String(row.data)) : undefined;
  }
  commands(sessionId: string): Command[] {
    // A JSON index keeps command IDs indefinitely for safe deduplication.
    return this.db
      .prepare(
        "SELECT data FROM commands WHERE json_extract(data, '$.sessionId')=? ORDER BY rowid DESC LIMIT 30",
      )
      .all(sessionId)
      .map((row) => JSON.parse(String(row.data)));
  }
  putCommand(command: Command): void {
    this.db
      .prepare(
        "INSERT INTO commands VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET data=excluded.data",
      )
      .run(command.id, JSON.stringify(command));
  }
  putApproval(approval: Approval): void {
    this.db
      .prepare(
        "INSERT INTO approvals VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET data=excluded.data",
      )
      .run(approval.id, approval.sessionId, JSON.stringify(approval));
  }
  approval(id: string): Approval | undefined {
    const row = this.db
      .prepare("SELECT data FROM approvals WHERE id=?")
      .get(id);
    return row ? JSON.parse(String(row.data)) : undefined;
  }
  approvals(sessionId: string): Approval[] {
    return this.db
      .prepare(
        "SELECT data FROM approvals WHERE session=? AND json_extract(data, '$.state') IN ('pending', 'responding')",
      )
      .all(sessionId)
      .map((row) => JSON.parse(String(row.data)));
  }
  staleApprovals(id: string): void {
    for (const a of this.approvals(id))
      this.putApproval({ ...a, state: "stale" });
  }
  close(): void {
    this.db.close();
  }
}
