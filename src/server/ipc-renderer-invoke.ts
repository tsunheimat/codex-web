import os from "node:os";
import {
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
