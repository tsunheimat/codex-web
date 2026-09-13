const fs = require("node:fs/promises");
const { createHash } = require("node:crypto");
const { EventEmitter } = require("node:events");
const { validId } = require("./session.cjs");
const { DesktopError } = require("./ipc.cjs");
const MIME = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
};
class NativeIntegration extends EventEmitter {
  constructor({ client, session, journal }) {
    super();
    this.client = client;
    this.session = session;
    this.journal = journal;
    this.captures = new Map();
    journal.db.exec(
      "CREATE TABLE IF NOT EXISTS native_uploads(id TEXT PRIMARY KEY,data TEXT NOT NULL); CREATE TABLE IF NOT EXISTS native_owners(id TEXT PRIMARY KEY,data TEXT NOT NULL); CREATE TABLE IF NOT EXISTS native_capture_status(id TEXT PRIMARY KEY,data TEXT NOT NULL)",
    );
    client.on("native/capture/status", (status) => {
      if (this.closed || typeof status.requestId !== "string") return;
      journal.db
        .prepare(
          "INSERT INTO native_capture_status VALUES(?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data",
        )
        .run(status.requestId, JSON.stringify(status));
      this.emit("captureStatus", status);
    });
    for (const row of journal.db
      .prepare("SELECT data FROM native_owners")
      .all()) {
      const state = JSON.parse(row.data);
      client.subscriptions.set(state.ownerId, state);
    }
    client.on("status", (available) => {
      if (this.closed) return;
      this.emit("capabilities");
      if (available) this.recovering = this.recover().catch(() => {});
      else
        for (const state of this.states())
          client.emit("native/cu/state", {
            ...state,
            status: "observer-disconnected",
            approvals: [],
          });
    });
    client.on("native/cu/state", (state) => {
      if (this.closed || !state?.ownerId || !state?.turnId) return;
      journal.db
        .prepare(
          "INSERT INTO native_owners VALUES(?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data",
        )
        .run(state.ownerId, JSON.stringify(state));
      if (
        [
          "completed",
          "stopped",
          "owner-lost",
          "owner-disconnected",
          "observer-disconnected",
          "replaced",
        ].includes(state.status)
      )
        this.captures.delete(state.ownerId);
      this.emit("state", state);
    });
    client.on("native/cu/capture", (frame) => {
      if (this.closed) return;
      const state = this.states().find(
        (s) =>
          s.ownerId === frame.ownerId &&
          s.turnId === frame.turnId &&
          s.status === "active",
      );
      if (
        !state ||
        typeof frame.dataUrl !== "string" ||
        frame.dataUrl.length > 1024 * 1024 ||
        !/^data:image\/(jpeg|png|webp);base64,/.test(frame.dataUrl)
      )
        return;
      this.captures.set(frame.ownerId, frame);
      this.emit("capture", frame);
    });
  }
  capabilities() {
    return {
      chatgptAttachments:
        this.client.verified &&
        this.client.capabilities.chatgptAttachments === true,
      computerUse:
        this.client.verified && this.client.capabilities.computerUse === true,
    };
  }
  require(capability) {
    if (!this.capabilities()[capability])
      throw new DesktopError(
        "NATIVE_DISABLED",
        "This native integration is disabled until the reviewed Desktop adapter is approved, installed, and connected",
      );
  }
  uploads(conversationId) {
    return this.journal.db
      .prepare("SELECT data FROM native_uploads")
      .all()
      .map((r) => JSON.parse(r.data))
      .filter((r) => r.conversationId === conversationId);
  }
  publicUploads(conversationId) {
    return this.uploads(conversationId).map(({ path, digest, ...r }) => r);
  }
  saveUpload(row) {
    this.journal.db
      .prepare(
        "INSERT INTO native_uploads VALUES(?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data",
      )
      .run(row.uploadId, JSON.stringify(row));
    this.emit("uploads", {
      conversationId: row.conversationId,
      uploads: this.publicUploads(row.conversationId),
    });
    return row;
  }
  states() {
    return this.journal.db
      .prepare("SELECT data FROM native_owners")
      .all()
      .map((r) => JSON.parse(r.data));
  }
  captureStatuses() {
    return this.journal.db
      .prepare("SELECT data FROM native_capture_status")
      .all()
      .map((r) => JSON.parse(r.data));
  }
  async upload(p, commandId) {
    this.require("chatgptAttachments");
    validId(p.conversationId);
    validId(p.uploadId);
    validId(commandId);
    if (commandId !== p.uploadId)
      throw new DesktopError(
        "NATIVE_ID",
        "Native upload needs a stable matching upload command ID",
      );
    const digest = createHash("sha256")
      .update(JSON.stringify([p.conversationId, p.name, p.data]))
      .digest("hex");
    let row = this.uploads(p.conversationId).find(
      (r) => r.uploadId === p.uploadId,
    );
    if (row && row.digest !== digest)
      throw new DesktopError(
        "NATIVE_ID",
        "Upload ID was used for different photo data",
      );
    if (row?.state === "ready")
      return this.publicUploads(p.conversationId).find(
        (r) => r.uploadId === p.uploadId,
      );
    if (!row) {
      const staged = await this.session.upload({ name: p.name, data: p.data });
      const mimeType = MIME[p.name.split(".").at(-1).toLowerCase()];
      row = this.saveUpload({
        uploadId: p.uploadId,
        commandId,
        conversationId: p.conversationId,
        path: staged.path,
        name: staged.name,
        mimeType,
        digest,
        state: "staged",
      });
    }
    this.saveUpload({ ...row, state: "uploading" });
    try {
      const data = (await fs.readFile(row.path)).toString("base64");
      const result = await this.client.request("native/photo/upload", {
        commandId,
        conversationId: p.conversationId,
        stageId: p.uploadId,
        name: row.name,
        mimeType: row.mimeType,
        data,
      });
      return this.uploadReady(row, result);
    } catch (error) {
      this.saveUpload({
        ...row,
        state: error.deliveryUnknown ? "unknown" : "failed",
        error: error.message,
      });
      throw error;
    }
  }
  uploadReady(row, result) {
    if (
      result?.conversationId !== row.conversationId ||
      result.stageId !== row.uploadId ||
      typeof result.attachment?.id !== "string"
    )
      throw new DesktopError(
        "NATIVE_ID",
        "Native upload result identity mismatch",
        true,
      );
    this.saveUpload({
      ...row,
      state: "ready",
      error: undefined,
      nativeAttachmentId: result.attachment.id,
      attachment: result.attachment,
    });
    return this.publicUploads(row.conversationId).find(
      (r) => r.uploadId === row.uploadId,
    );
  }
  async send(p, commandId) {
    this.require("chatgptAttachments");
    validId(commandId);
    const rows = this.uploads(p.conversationId);
    for (const id of p.attachmentIds) {
      const row = rows.find(
        (r) => r.nativeAttachmentId === id && r.state === "ready",
      );
      if (!row)
        throw new DesktopError(
          "NATIVE_ID",
          "Native attachment is not ready for this conversation",
        );
      this.saveUpload({ ...row, usedByCommandId: commandId });
    }
    const result = await this.client.request("native/message/send", {
      commandId,
      conversationId: p.conversationId,
      prompt: p.prompt,
      attachmentIds: p.attachmentIds,
    });
    return result;
  }
  async attach(p) {
    this.require("computerUse");
    const state = await this.client.request("native/cu/attach", {
      conversationId: p.conversationId,
      conversationKind: p.conversationKind,
    });
    this.client.emit("native/cu/state", state);
    return state;
  }
  async control(action, p, commandId) {
    this.require("computerUse");
    const state = this.states().find(
      (s) => s.ownerId === p.ownerId && s.turnId === p.turnId,
    );
    if (!state)
      throw new DesktopError(
        "NATIVE_OWNER",
        "Attach to the existing Computer Use owner first",
      );
    return this.client.request("native/cu/" + action, { ...p, commandId });
  }
  async operation(commandId) {
    const result = await this.client.request("native/operation/read", {
      commandId: validId(commandId),
    });
    if (this.closed) return result;
    if (result.state === "complete") {
      const upload = this.journal.db
        .prepare("SELECT data FROM native_uploads WHERE id=?")
        .get(commandId);
      const recovered = upload
        ? this.uploadReady(JSON.parse(upload.data), result.result)
        : result.result;
      this.journal.db
        .prepare("UPDATE commands SET reply=? WHERE id=?")
        .run(JSON.stringify({ result: recovered }), commandId);
      return { ...result, result: recovered };
    }
    return result;
  }
  async recover() {
    if (this.closed) return;
    for (const row of this.journal.db
      .prepare(
        "SELECT id FROM commands WHERE json_extract(reply,'$.error.deliveryUnknown')=1",
      )
      .all())
      await this.operation(row.id).catch(() => {});
    for (const row of this.journal.db
      .prepare("SELECT data FROM native_uploads")
      .all()) {
      const upload = JSON.parse(row.data);
      if (["staged", "uploading", "unknown"].includes(upload.state))
        await this.operation(upload.commandId).catch(() => {});
    }
  }
  replay() {
    for (const state of this.states())
      this.emit(
        "state",
        this.client.verified
          ? state
          : { ...state, status: "observer-disconnected", approvals: [] },
      );
    for (const frame of this.captures.values())
      if (this.client.verified) this.emit("capture", frame);
    for (const id of new Set(
      this.journal.db
        .prepare("SELECT data FROM native_uploads")
        .all()
        .map((r) => JSON.parse(r.data).conversationId),
    ))
      this.emit("uploads", {
        conversationId: id,
        uploads: this.publicUploads(id),
      });
  }
  async close() {
    this.closed = true;
    this.client.close();
    await this.recovering;
  }
}
module.exports = { NativeIntegration };
