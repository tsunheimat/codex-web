import path from "node:path";

const SUPPORTED_METHODS = new Set(["thread/start", "thread/resume"]);
const ABSOLUTE_PATH_ARRAY_KEYS = new Set([
  "runtimeWorkspaceRoots",
  "writableRoots",
]);

export type SanitizedPathChange = {
  key: string;
  before: string;
  after: string | null;
};

export function expandTildePath(value: string, homeDir: string): string {
  if (value === "~") {
    return homeDir;
  }
  if (value.startsWith("~/")) {
    return path.join(homeDir, value.slice(2));
  }
  return value;
}

function sanitizeNode(
  node: unknown,
  homeDir: string,
  changes: SanitizedPathChange[],
): void {
  if (Array.isArray(node)) {
    for (const item of node) {
      sanitizeNode(item, homeDir, changes);
    }
    return;
  }
  if (node === null || typeof node !== "object") {
    return;
  }

  const record = node as Record<string, unknown>;
  for (const [key, value] of Object.entries(record)) {
    if (ABSOLUTE_PATH_ARRAY_KEYS.has(key) && Array.isArray(value)) {
      const sanitized: unknown[] = [];
      for (const entry of value) {
        if (typeof entry !== "string") {
          sanitized.push(entry);
          continue;
        }
        const expanded = expandTildePath(entry, homeDir);
        if (!path.isAbsolute(expanded)) {
          changes.push({ key, before: entry, after: null });
          continue;
        }
        if (expanded !== entry) {
          changes.push({ key, before: entry, after: expanded });
        }
        sanitized.push(expanded);
      }

      // A bad runtime override should become no override, not an explicit
      // empty override. writableRoots is a struct field and remains present.
      if (
        key === "runtimeWorkspaceRoots" &&
        sanitized.length === 0 &&
        value.length > 0
      ) {
        delete record[key];
        changes.push({
          key,
          before: "(all entries dropped)",
          after: "(override removed)",
        });
      } else {
        record[key] = sanitized;
      }
      continue;
    }

    if (key === "cwd" && typeof value === "string") {
      const expanded = expandTildePath(value, homeDir);
      if (expanded !== value) {
        changes.push({ key, before: value, after: expanded });
        record[key] = expanded;
      }
      // Other relative cwd values are deliberately preserved so app-server
      // remains the validation authority instead of the bridge guessing.
      continue;
    }

    sanitizeNode(value, homeDir, changes);
  }
}

type McpRequestEnvelope = {
  type?: unknown;
  request?: {
    method?: unknown;
    params?: unknown;
  };
};

/** Normalize only AbsolutePathBuf-shaped fields in thread start/resume. */
export function sanitizeMcpRequestPaths(
  argument: unknown,
  homeDir: string,
): { method: string; changes: SanitizedPathChange[] } | null {
  if (typeof argument !== "object" || argument === null) {
    return null;
  }
  const envelope = argument as McpRequestEnvelope;
  const request = envelope.request;
  if (
    typeof envelope.type !== "string" ||
    typeof request !== "object" ||
    request === null ||
    typeof request.method !== "string" ||
    !SUPPORTED_METHODS.has(request.method) ||
    typeof request.params !== "object" ||
    request.params === null
  ) {
    return null;
  }

  const changes: SanitizedPathChange[] = [];
  sanitizeNode(request.params, homeDir, changes);
  return changes.length > 0 ? { method: request.method, changes } : null;
}
