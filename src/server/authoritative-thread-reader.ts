import { randomUUID } from "node:crypto";
import { isValidRendererThreadId } from "./renderer-recovery";

const APP_SERVER_VIEW_CHANNEL = "codex_desktop:message-from-view";
const APP_SERVER_RESPONSE_CHANNEL = "codex_desktop:message-for-view";
const TURN_STATUSES = new Set([
  "completed",
  "interrupted",
  "failed",
  "inProgress",
]);

type DesktopResponseSink = (channel: string, args: unknown[]) => void;

export type DesktopInvoke = (
  channel: string,
  args: unknown[],
  responseSink?: DesktopResponseSink,
) => Promise<unknown>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function inProgressTurnIdsFromThreadReadResponse(
  response: unknown,
  requestId: string,
  threadId: string,
): Set<string> | null {
  if (!isRecord(response) || response.type !== "mcp-response") {
    return null;
  }
  const message = response.message;
  if (!isRecord(message) || message.id !== requestId || "error" in message) {
    return null;
  }
  const result = message.result;
  if (!isRecord(result) || !isRecord(result.thread)) {
    return null;
  }
  const thread = result.thread;
  if (thread.id !== threadId || !Array.isArray(thread.turns)) {
    return null;
  }

  const seenTurnIds = new Set<string>();
  const inProgressTurnIds = new Set<string>();
  for (const value of thread.turns) {
    if (
      !isRecord(value) ||
      !isValidRendererThreadId(value.id) ||
      typeof value.status !== "string" ||
      !TURN_STATUSES.has(value.status) ||
      seenTurnIds.has(value.id)
    ) {
      return null;
    }
    seenTurnIds.add(value.id);
    if (value.status === "inProgress") {
      inProgressTurnIds.add(value.id);
    }
  }
  return inProgressTurnIds;
}

export function createAuthoritativeThreadReader(
  invokeDesktop: DesktopInvoke,
  createRequestId: () => string = randomUUID,
): (threadId: string) => Promise<ReadonlySet<string>> {
  return async (threadId) => {
    if (!isValidRendererThreadId(threadId)) {
      throw new Error("invalid authoritative thread/read thread id");
    }

    const requestId = `codex-web-reconcile-${createRequestId()}`;
    return await new Promise<ReadonlySet<string>>((resolve, reject) => {
      let settled = false;
      const settle = (operation: () => void): void => {
        if (settled) {
          return;
        }
        settled = true;
        operation();
      };

      const responseSink: DesktopResponseSink = (channel, args) => {
        if (channel !== APP_SERVER_RESPONSE_CHANNEL) {
          return;
        }
        const response = args[0];
        if (
          !isRecord(response) ||
          response.type !== "mcp-response" ||
          !isRecord(response.message) ||
          response.message.id !== requestId
        ) {
          return;
        }
        const inProgressTurnIds = inProgressTurnIdsFromThreadReadResponse(
          response,
          requestId,
          threadId,
        );
        if (inProgressTurnIds === null) {
          settle(() =>
            reject(new Error("invalid authoritative thread/read response")),
          );
          return;
        }
        settle(() => resolve(inProgressTurnIds));
      };

      Promise.resolve(
        invokeDesktop(
          APP_SERVER_VIEW_CHANNEL,
          [
            {
              type: "mcp-request",
              hostId: "local",
              request: {
                id: requestId,
                method: "thread/read",
                params: { threadId, includeTurns: true },
              },
            },
          ],
          responseSink,
        ),
      ).catch((error) => settle(() => reject(error)));
    });
  };
}
