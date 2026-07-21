import fastifyMultipart from "@fastify/multipart";
import type { FastifyInstance, FastifyReply } from "fastify";
import type { Readable } from "node:stream";
import {
  attachmentContentDisposition,
  contentTypeForWorkspaceFile,
  WORKSPACE_UPLOAD_LIMITS,
  WorkspaceFileAuthority,
  WorkspacePathError,
} from "./workspace-files";

function workspaceErrorReply(error: unknown, reply: FastifyReply) {
  if (error instanceof WorkspacePathError) {
    return reply.code(error.statusCode).send({ error: error.message });
  }
  throw error;
}

export function workspacePathFromAtFsUrl(rawUrl: string): string {
  const rawPath = rawUrl.split("?", 1)[0] ?? "";
  if (!rawPath.startsWith("/@fs/")) {
    throw new WorkspacePathError("Invalid workspace file URL");
  }
  try {
    return decodeURIComponent(rawPath.slice("/@fs".length));
  } catch (error) {
    throw new WorkspacePathError("Invalid workspace file URL encoding", 400);
  }
}

export async function registerWorkspaceFileRoutes(
  app: FastifyInstance,
  authority: WorkspaceFileAuthority,
  options: { cleanupOnClose?: boolean } = {},
): Promise<void> {
  if (options.cleanupOnClose !== false) {
    app.addHook("onClose", async () => {
      await authority.cleanup();
    });
  }
  await app.register(fastifyMultipart, {
    limits: WORKSPACE_UPLOAD_LIMITS,
  });

  app.post("/__backend/upload", async (request, reply) => {
    if (!request.isMultipart()) {
      return reply.code(400).send({ error: "expected multipart upload body" });
    }

    const storedFiles: Awaited<
      ReturnType<WorkspaceFileAuthority["storeUpload"]>
    >[] = [];
    let responseFinished = false;
    const rollbackOnAbortedResponse = (): void => {
      if (responseFinished || reply.raw.writableFinished) {
        return;
      }
      void Promise.allSettled(
        storedFiles.map((file) => authority.discardUpload(file.path)),
      );
    };
    reply.raw.once("close", rollbackOnAbortedResponse);
    reply.raw.once("finish", () => {
      responseFinished = true;
      reply.raw.off("close", rollbackOnAbortedResponse);
    });
    try {
      for await (const part of request.parts()) {
        if (part.type !== "file" || part.fieldname !== "files") {
          throw new WorkspacePathError(
            "multipart body may contain only 'files' file parts",
          );
        }
        const stored = await authority.storeUpload(part.file, part.filename);
        if (part.file.truncated) {
          await authority.discardUpload(stored.path);
          throw new WorkspacePathError("uploaded file exceeds size limit", 413);
        }
        storedFiles.push(stored);
      }
    } catch (error) {
      await Promise.all(
        storedFiles.map((file) => authority.discardUpload(file.path)),
      );
      return workspaceErrorReply(error, reply);
    }

    if (storedFiles.length === 0) {
      return reply
        .code(400)
        .send({ error: "multipart body contained no files" });
    }
    return reply.send({ files: storedFiles });
  });

  app.get("/__backend/download", async (request, reply) => {
    const query = request.query as { path?: unknown };
    if (typeof query.path !== "string") {
      return reply.code(400).send({ error: "download path is required" });
    }
    let openedStream: Readable | null = null;
    try {
      const file = await authority.openAllowedFile(query.path);
      openedStream = file.stream;
      return reply
        .header(
          "content-disposition",
          attachmentContentDisposition(file.downloadName),
        )
        .header("x-content-type-options", "nosniff")
        .type("application/octet-stream")
        .send(file.stream);
    } catch (error) {
      openedStream?.destroy();
      return workspaceErrorReply(error, reply);
    }
  });

  app.get("/@fs/*", async (request, reply) => {
    let openedStream: Readable | null = null;
    try {
      const requestedPath = workspacePathFromAtFsUrl(request.raw.url ?? "");
      const file = await authority.openAllowedFile(requestedPath);
      openedStream = file.stream;
      const contentType = contentTypeForWorkspaceFile(file.downloadName);
      reply
        .header("content-security-policy", "sandbox; default-src 'none'")
        .header("x-content-type-options", "nosniff")
        .type(contentType);
      if (contentType === "application/octet-stream") {
        reply.header(
          "content-disposition",
          attachmentContentDisposition(file.downloadName),
        );
      }
      return reply.send(file.stream);
    } catch {
      openedStream?.destroy();
      // Static file authority is intentionally fail-closed without revealing
      // which host paths exist outside the configured roots.
      return reply.code(404).send({ error: "Not Found" });
    }
  });
}
