const { EventEmitter } = require("node:events");
const { randomUUID } = require("node:crypto");
const { NativeReceipts } = require("./receipts.cjs");
const {
  BINDING_ID,
  CAPTURE_LIMIT,
  checkedId,
  nativeError,
} = require("./contract.cjs");

/** Runs inside the existing Desktop main process. Never opens a helper connection. */
class NativeHost extends EventEmitter {
  constructor({
    renderer,
    receipts,
    normalizeImage = (url) => url,
    closeActiveTurn,
    hasActiveTurn,
  }) {
    super();
    this.renderer = renderer;
    this.receipts = receipts ?? new NativeReceipts();
    this.normalizeImage = normalizeImage;
    this.closeActiveTurn = closeActiveTurn;
    this.hasActiveTurn = hasActiveTurn;
    this.owners = new Map();
    this.sockets = new WeakMap();
    this.senders = new WeakMap();
    this.captureStatuses = new Map();
    this.sequence = 0;
    this.ready = false;
    this.instanceId = randomUUID();
  }
  async verify() {
    const reply = await this.renderer({ op: "binding/read" });
    this.ready =
      reply?.bindingId === BINDING_ID && reply.photoSubmission === true;
    return this.ready;
  }
  capabilities() {
    return {
      bindingId: BINDING_ID,
      instanceId: this.instanceId,
      chatgptAttachments: this.ready,
      computerUse:
        this.ready &&
        typeof this.closeActiveTurn === "function" &&
        typeof this.hasActiveTurn === "function",
    };
  }
  attachment(id, conversationId) {
    for (const row of this.receipts.records.values())
      if (
        row.method === "native/photo/upload" &&
        row.state === "complete" &&
        row.conversationId === conversationId &&
        row.result.attachment.id === id
      )
        return row.result.attachment;
    throw nativeError(
      "Attachment is not a completed native upload for this conversation",
      false,
    );
  }
  async dispatch(method, params) {
    if (!this.ready && !(await this.verify()))
      throw nativeError("Approved native renderer binding is not ready", false);
    if (method === "native/operation/read")
      return this.operation(checkedId(params.commandId));
    if (method === "native/cu/attach") {
      checkedId(params.conversationId);
      const owners = [...this.owners.values()].filter(
        (o) =>
          o.conversationId === params.conversationId &&
          o.conversationKind === params.conversationKind &&
          this.active(o),
      );
      if (owners.length !== 1)
        throw nativeError(
          "No unique existing Computer Use owner matches this conversation and active turn",
          false,
        );
      return this.snapshot(owners[0]);
    }
    if (method === "native/cu/sync") {
      const owner = this.owners.get(params.ownerId);
      if (!owner || owner.turnId !== params.turnId)
        throw nativeError("Computer Use owner no longer exists", false);
      return this.snapshot(owner);
    }
    if (
      ![
        "native/photo/upload",
        "native/message/send",
        "native/cu/answer",
        "native/cu/stop",
      ].includes(method)
    )
      throw nativeError("Native operation is not exposed", false);
    return this.receipts.run(method, params, async (checkpoint) => {
      if (method === "native/photo/upload") {
        checkedId(params.conversationId);
        checkedId(params.stageId);
        if (
          typeof params.data !== "string" ||
          params.data.length > 6990510 ||
          !["image/png", "image/jpeg", "image/webp", "image/gif"].includes(
            params.mimeType,
          )
        )
          throw nativeError("Invalid staged native photo", false);
        const result = await this.renderer({
          op: "photo/upload",
          conversationId: params.conversationId,
          stageId: params.stageId,
          name: params.name,
          mimeType: params.mimeType,
          data: params.data,
        });
        if (
          result?.conversationId !== params.conversationId ||
          typeof result.attachment?.id !== "string" ||
          !result.attachment.width ||
          !result.attachment.height
        )
          throw nativeError(
            "Native upload handler returned no processed image identity",
            true,
          );
        return result;
      }
      if (method === "native/message/send") {
        checkedId(params.conversationId);
        if (
          typeof params.prompt !== "string" ||
          params.prompt.length > 200000 ||
          !Array.isArray(params.attachmentIds) ||
          params.attachmentIds.length > 16 ||
          new Set(params.attachmentIds).size !== params.attachmentIds.length ||
          (!params.prompt.trim() && !params.attachmentIds.length)
        )
          throw nativeError("Invalid native message", false);
        const attachments = params.attachmentIds.map((id) =>
          this.attachment(id, params.conversationId),
        );
        const prepared = await this.renderer({
          op: "message/prepare",
          conversationId: params.conversationId,
          prompt: params.prompt,
          attachments,
        });
        if (
          !prepared?.bundle?.message?.id ||
          prepared.conversationId !== params.conversationId
        )
          throw nativeError(
            "Native message preparation returned no message identity",
            true,
          );
        const messageId = prepared.bundle.message.id;
        checkpoint({
          prepared,
          messageId,
          attachmentIds: params.attachmentIds,
        });
        // The prepared message (including native image_asset_pointer parts) is
        // passed intact to Rqr through userCompletionMessages.
        await this.renderer({
          op: "message/submit",
          conversationId: params.conversationId,
          prompt: params.prompt,
          attachments,
          prepared,
        });
        return {
          conversationId: params.conversationId,
          messageId,
          attachmentIds: params.attachmentIds,
          attachmentReferences: prepared.references,
          submitted: true,
        };
      }
      const owner = this.owner(params);
      if (method === "native/cu/answer") {
        const request = owner.approvals.get(params.approvalId);
        if (
          !request?.isPending() ||
          !["accept", "decline", "cancel"].includes(params.result?.action) ||
          Object.keys(params.result).length !== 1
        )
          throw nativeError(
            "Computer Use approval is stale or the decision is invalid",
            false,
          );
        // This invokes the original ore.handleApprovalResponse for the original
        // request ID. The existing Desktop/helper sender remains connected.
        const response = {
          id: request.id,
          jsonrpc: "2.0",
          result: { action: params.result.action },
        };
        this.observeApprovalResponse(response);
        owner.respond(response);
        this.reconcileApprovals(owner);
        return {
          ownerId: owner.id,
          approvalId: request.id,
          resolved: !request.isPending(),
        };
      }
      const stopped = await this.closeActiveTurn({
        sessionId: owner.metadata.session_id,
        turnId: owner.metadata.turn_id,
      });
      if (!stopped)
        throw nativeError("The Computer Use owner turn has changed", false);
      this.end(owner, "stopped");
      return { ownerId: owner.id, turnId: owner.turnId, stopped: true };
    });
  }
  async operation(id) {
    let row = this.receipts.get(id);
    if (!row) return { state: "absent", commandId: id };
    if (
      row.state === "unknown" &&
      row.method === "native/message/send" &&
      row.messageId
    ) {
      const observed = await this.renderer({
        op: "message/find",
        conversationId: row.conversationId,
        messageId: row.messageId,
        attachmentIds: row.attachmentIds,
      });
      if (observed?.found)
        row = this.receipts.put({
          ...row,
          state: "complete",
          result: {
            conversationId: row.conversationId,
            messageId: row.messageId,
            attachmentIds: row.attachmentIds,
            submitted: true,
            reconciled: true,
          },
        });
    }
    return {
      commandId: id,
      state: row.state,
      result: row.result,
      error: row.error,
      messageId: row.messageId,
    };
  }
  observeOwner(socket, metadata, respond, method) {
    if (!metadata?.session_id || !metadata.turn_id) return null;
    const conversationId =
      metadata.thread_id ?? metadata.threadId ?? metadata.session_id;
    const kind = metadata.thread_source === "chatgpt" ? "chatgpt" : "codex";
    let owner = this.sockets.get(socket);
    if (
      owner &&
      (owner.turnId !== metadata.turn_id ||
        owner.conversationId !== conversationId)
    )
      this.end(owner, "replaced");
    if (!owner || owner.ended) {
      owner = {
        id: randomUUID(),
        conversationId,
        conversationKind: kind,
        turnId: metadata.turn_id,
        metadata: structuredClone(metadata),
        socket,
        respond,
        approvals: new Map(),
        resolvedApprovals: new Map(),
        status: "active",
        presentations: {},
        revision: 0,
      };
      this.owners.set(owner.id, owner);
      this.sockets.set(socket, owner);
      socket.once?.("close", () => this.end(owner, "owner-disconnected"));
    }
    owner.metadata = structuredClone(metadata);
    owner.respond = respond;
    if (method === "end_turn") this.end(owner, "completed");
    else this.changed(owner);
    return owner;
  }
  elicit(approvalBridge, sender, socket, metadata, params) {
    const owner = this.observeOwner(socket, metadata, (message) =>
      approvalBridge.handleApprovalResponse(message),
    );
    const wrapped = (message) => sender(message);
    this.senders.set(wrapped, owner);
    return approvalBridge
      .requestApprovalForSender(wrapped, params)
      .finally(() => {
        if (owner) this.reconcileApprovals(owner);
      });
  }
  observeApproval(sender, message, isPending) {
    const owner = this.senders.get(sender);
    if (!owner || owner.ended) return;
    owner.approvals.set(message.id, {
      id: message.id,
      params: structuredClone(message.params),
      codexTurnMetadata: structuredClone(owner.metadata),
      isPending,
    });
    this.changed(owner);
  }
  reconcileApprovals(owner) {
    for (const [id, request] of owner.approvals)
      if (!request.isPending()) owner.approvals.delete(id);
    this.changed(owner);
  }
  observeApprovalResponse(message) {
    for (const owner of this.owners.values()) {
      const request = owner.approvals.get(message.id);
      if (!request?.isPending()) continue;
      owner.resolvedApprovals.set(message.id, {
        approvalId: message.id,
        result: message.result,
        error: message.error,
      });
      queueMicrotask(() => this.reconcileApprovals(owner));
    }
  }
  active(owner) {
    return (
      !owner.ended &&
      !owner.socket.destroyed &&
      this.hasActiveTurn?.({
        sessionId: owner.metadata.session_id,
        turnId: owner.turnId,
      }) === true
    );
  }
  owner(params) {
    const owner = this.owners.get(params.ownerId);
    if (!owner || owner.turnId !== params.turnId || !this.active(owner))
      throw nativeError(
        "Computer Use owner or active turn changed; attach again",
        false,
      );
    return owner;
  }
  snapshot(owner) {
    return {
      ownerId: owner.id,
      conversationId: owner.conversationId,
      conversationKind: owner.conversationKind,
      turnId: owner.turnId,
      codexTurnMetadata: structuredClone(owner.metadata),
      status: owner.ended
        ? owner.status
        : this.active(owner)
          ? owner.status
          : "unavailable",
      revision: owner.revision,
      presentations: owner.presentations,
      resolvedApprovals: [...owner.resolvedApprovals.values()],
      approvals: [...owner.approvals.values()]
        .filter((r) => r.isPending())
        .map((r) => ({
          approvalId: r.id,
          params: r.params,
          codexTurnMetadata: r.codexTurnMetadata,
        })),
    };
  }
  changed(owner) {
    owner.revision = ++this.sequence;
    this.emit("state", this.snapshot(owner));
  }
  end(owner, reason) {
    if (owner.ended) return;
    owner.ended = true;
    owner.status = reason;
    owner.approvals.clear();
    delete owner.capture;
    this.changed(owner);
  }
  observeResult(socket, metadata, method, result) {
    const owner = this.sockets.get(socket);
    if (!owner || owner.turnId !== metadata?.turn_id || !this.active(owner))
      return;
    if (method === "get_window_state")
      for (const shot of result?.screenshots ?? [])
        this.capture(owner, shot.url, {
          screenshotId: shot.id,
          width: shot.width,
          height: shot.height,
        });
  }
  capture(owner, url, metadata) {
    if (
      typeof url !== "string" ||
      !/^data:image\/(png|jpeg|webp);base64,/.test(url)
    )
      return;
    const normalized = this.normalizeImage(url);
    if (
      typeof normalized !== "string" ||
      Buffer.byteLength(normalized) > CAPTURE_LIMIT
    )
      return;
    owner.capture = {
      ownerId: owner.id,
      turnId: owner.turnId,
      conversationId: owner.conversationId,
      conversationKind: owner.conversationKind,
      sequence: ++this.sequence,
      ...metadata,
      dataUrl: normalized,
    };
    // A single replaceable frame per owner; approval and lifecycle state use a
    // separate reliable snapshot channel and are never displaced by images.
    this.emit("capture", owner.capture);
  }
  observePresentation(origin, message) {
    if (
      ![
        "computer-use-capture-updated",
        "remote-hosted-pip-task-state-changed",
        "remote-hosted-pip-content-layout-state-changed",
        "remote-hosted-pip-browser-frame-state-changed",
      ].includes(message?.type)
    )
      return;
    const id =
      message.threadId ??
      message.threadID ??
      message.state?.threadID ??
      message.state?.activeThreadID;
    // Composer capture updates often have no turn identity. Preserve the actual
    // request identity as Desktop status, never as a guessed owner screenshot.
    if (message.type === "computer-use-capture-updated") {
      const status = {
        requestId: String(message.requestId).slice(0, 128),
        scope: id ? "conversation" : "desktop",
        conversationId: id,
        originId: origin?.id,
        status: String(message.update?.type ?? "updated").slice(0, 64),
        failureReason:
          typeof message.update?.failureReason === "string"
            ? message.update.failureReason.slice(0, 500)
            : undefined,
        sequence: ++this.sequence,
      };
      this.captureStatuses.set(status.requestId, status);
      this.emit("captureStatus", status);
    }
    if (!id) return;
    for (const owner of this.owners.values())
      if (owner.conversationId === id && this.active(owner)) {
        owner.presentations[message.type] = {
          requestId: message.requestId,
          state: message.state,
          update: message.update,
        };
        this.changed(owner);
      }
  }
}
module.exports = { NativeHost };
