import os from "node:os";
import {
  MCP_REQUEST_CHANNEL,
  MCP_RESPONSE_CHANNEL,
  sanitizeRendererInvokeMcpRequestPaths,
  type SanitizedPathChange,
} from "./mcp-request-path-sanitizer";
import { WorkspacePathError } from "./workspace-files";

export type RendererInvokeMessage = {
  type: "ipc-renderer-invoke";
  requestId: string;
  channel: string;
  args: unknown[];
  sourceUrl: string;
};

type RendererInvokeHandler = (
  channel: string,
  args: unknown[],
) => Promise<unknown>;

function logSanitizedPathChange(
  method: string,
  change: SanitizedPathChange,
): void {
  console.log(
    `[mcp-request-sanitizer] ${method} ${change.key}: ${JSON.stringify(change.before)} -> ${change.after === null ? "dropped" : JSON.stringify(change.after)}`,
  );
}

export async function invokeRendererRequest(
  message: RendererInvokeMessage,
  browseRoot: string,
  handler: RendererInvokeHandler,
  homeDir = os.homedir(),
): Promise<unknown> {
  const result = sanitizeRendererInvokeMcpRequestPaths(
    message,
    homeDir,
    browseRoot,
  );
  if (result) {
    for (const change of result.changes) {
      logSanitizedPathChange(result.method, change);
    }
  }
  return await handler(message.channel, message.args);
}

export function rendererInvokeErrorMessage(error: unknown): string {
  if (error instanceof WorkspacePathError) {
    return error.message;
  }
  if (error instanceof Error) {
    return error.stack ?? error.message;
  }
  return String(error);
}

export type SyntheticMcpErrorEvent = {
  type: "ipc-main-event";
  channel: typeof MCP_RESPONSE_CHANNEL;
  args: unknown[];
};

/**
 * The renderer sends app-server requests fire-and-forget: a rejected invoke
 * only produces a console warning while the request promise keeps waiting for
 * a message-for-view response until its 30s timeout. Convert a workspace-path
 * rejection of an mcp-request into that response so the UI fails immediately
 * with the real error instead of spinning.
 */
export function syntheticMcpErrorEventForRejectedInvoke(
  message: RendererInvokeMessage,
  error: unknown,
): SyntheticMcpErrorEvent | null {
  if (!(error instanceof WorkspacePathError)) {
    return null;
  }
  if (message.channel !== MCP_REQUEST_CHANNEL || message.args.length !== 1) {
    return null;
  }
  const envelope = message.args[0];
  if (typeof envelope !== "object" || envelope === null) {
    return null;
  }
  const { type, hostId, request } = envelope as {
    type?: unknown;
    hostId?: unknown;
    request?: unknown;
  };
  if (type !== "mcp-request" || typeof request !== "object" || request === null) {
    return null;
  }
  const id = (request as { id?: unknown }).id;
  if (typeof id !== "string" && typeof id !== "number") {
    return null;
  }
  return {
    type: "ipc-main-event",
    channel: MCP_RESPONSE_CHANNEL,
    args: [
      {
        type: "mcp-response",
        hostId: typeof hostId === "string" ? hostId : "local",
        message: {
          id,
          error: { code: -32602, message: error.message },
        },
      },
    ],
  };
}
