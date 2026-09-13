// Loaded only by the reviewed, version-pinned patch inside the existing renderer.
// All native function references are supplied by the lexical dispatch hook.
export async function dispatchNativeRenderer(request, native) {
  if (!request || typeof request !== "object")
    throw new Error("Invalid native renderer request");
  if (request.op === "binding/read")
    return {
      bindingId: "codex-web-native/26.908.40834/v1",
      photoSubmission: ["target", "upload", "prepare", "submit"].every(
        (k) => typeof native[k] === "function",
      ),
    };
  const target = await native.target(request.conversationId);
  if (!target || target.conversation_id !== request.conversationId)
    throw Object.assign(new Error("Native ChatGPT target changed"), {
      deliveryUnknown: false,
    });
  if (request.op === "photo/upload") {
    const bytes = Uint8Array.from(atob(request.data), (c) => c.charCodeAt(0));
    const file = new File([bytes], request.name, { type: request.mimeType });
    const bitmap = await (native.decodeImage ?? createImageBitmap)(file);
    const width = bitmap.width,
      height = bitmap.height;
    bitmap.close();
    if (!width || !height || width * height > 32000000)
      throw Object.assign(new Error("Native photo exceeds 32 megapixels"), {
        deliveryUnknown: false,
      });
    const processed = await native.upload(file);
    // uploadChatGptConversationFile returns the processed file/library identity.
    // Jqr additionally needs dimensions to construct image_asset_pointer parts.
    const attachment = {
      id: processed.id,
      libraryFileId: processed.libraryFileId,
      name: processed.name,
      mimeType: processed.mimeType,
      size: processed.size,
      width,
      height,
    };
    return {
      conversationId: target.conversation_id,
      stageId: request.stageId,
      attachment,
    };
  }
  if (request.op === "message/prepare") {
    const bundle = native.prepare({
      prompt: request.prompt,
      attachments: request.attachments,
    });
    const references = (bundle.message.content.parts ?? []).filter(
      (part) => part?.content_type === "image_asset_pointer",
    );
    if (
      references.length !== request.attachments.length ||
      request.attachments.some(
        (a) =>
          !references.some(
            (r) =>
              r.asset_pointer ===
                `${a.id.startsWith("file_") ? "sediment" : "file-service"}://${a.id}` &&
              r.width === a.width &&
              r.height === a.height,
          ),
      )
    )
      throw new Error(
        "Native message builder did not retain the image references",
      );
    return {
      conversationId: target.conversation_id,
      parentMessageId: target.current_node,
      bundle,
      references,
    };
  }
  if (request.op === "message/submit") {
    if (target.current_node !== request.prepared.parentMessageId)
      throw Object.assign(
        new Error(
          "Native conversation advanced after message preparation; reconcile before sending",
        ),
        { deliveryUnknown: false },
      );
    return native.submit(request);
  }
  if (request.op === "message/find") {
    const found = Object.values(target.mapping ?? {}).find(
      (node) => node.message?.id === request.messageId,
    )?.message;
    const parts = found?.content?.parts ?? [];
    return {
      found:
        !!found &&
        request.attachmentIds.every((id) =>
          parts.some((p) => p?.asset_pointer?.endsWith("://" + id)),
        ),
    };
  }
  throw new Error("Native renderer operation is not exposed");
}
