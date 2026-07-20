import { randomUUID } from "node:crypto";
import { createWriteStream, lstatSync, realpathSync, statSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pipeline } from "node:stream/promises";

export const WORKSPACE_UPLOAD_LIMITS = {
  fileSize: 25 * 1024 * 1024,
  files: 20,
  fields: 0,
  parts: 20,
} as const;

export type WorkspaceDirectoryEntry = {
  name: string;
  path: string;
  type: "directory" | "file";
};

export type WorkspaceDirectoryEntries = {
  directoryPath: string;
  parentPath: string | null;
  entries: WorkspaceDirectoryEntry[];
};

export type StoredWorkspaceUpload = {
  label: string;
  path: string;
  fsPath: string;
};

export type AllowedWorkspaceFile = {
  path: string;
  downloadName: string;
  source: "upload" | "workspace";
};

export class WorkspacePathError extends Error {
  constructor(
    message: string,
    readonly statusCode: 400 | 403 | 404 | 413 = 400,
  ) {
    super(message);
    this.name = "WorkspacePathError";
  }
}

export function isPathInside(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (relative !== ".." &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative))
  );
}

function fileSystemErrorCode(error: unknown): string | null {
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string"
  ) {
    return error.code;
  }
  return null;
}

/** Resolve and validate the configured authority root before the server starts. */
export function canonicalizeBrowseRoot(configuredRoot: string): string {
  const requestedRoot = configuredRoot.trim();
  if (!requestedRoot) {
    throw new Error("CODEX_WEBUI_BROWSE_ROOT must not be empty");
  }

  const resolvedRoot = path.resolve(requestedRoot);
  let canonicalRoot: string;
  try {
    canonicalRoot = realpathSync(resolvedRoot);
  } catch (error) {
    throw new Error(`CODEX_WEBUI_BROWSE_ROOT does not exist: ${resolvedRoot}`, {
      cause: error,
    });
  }

  let stat;
  try {
    stat = statSync(canonicalRoot);
  } catch (error) {
    throw new Error(
      `CODEX_WEBUI_BROWSE_ROOT cannot be inspected: ${resolvedRoot}`,
      { cause: error },
    );
  }
  if (!stat.isDirectory()) {
    throw new Error(
      `CODEX_WEBUI_BROWSE_ROOT is not a directory: ${resolvedRoot}`,
    );
  }
  return canonicalRoot;
}

function hasTraversalSegment(value: string): boolean {
  return value.split(path.sep).includes("..");
}

function assertNoSymlinkSegments(
  resolvedPath: string,
  canonicalRoot: string,
  label: string,
): void {
  const relative = path.relative(canonicalRoot, resolvedPath);
  if (!isPathInside(resolvedPath, canonicalRoot)) {
    throw new WorkspacePathError(
      `${label} is outside CODEX_WEBUI_BROWSE_ROOT`,
      403,
    );
  }

  let current = canonicalRoot;
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    let stat;
    try {
      stat = lstatSync(current);
    } catch (error) {
      if (fileSystemErrorCode(error) === "ENOENT") {
        throw new WorkspacePathError(`${label} does not exist`, 404);
      }
      throw new WorkspacePathError(`${label} cannot be inspected`, 400);
    }
    if (stat.isSymbolicLink()) {
      throw new WorkspacePathError(`${label} must not contain symlinks`, 403);
    }
  }
}

export function resolveBoundedDirectory(
  input: string,
  canonicalRoot: string,
  label = "Workspace directory",
): string {
  if (input.includes("\0")) {
    throw new WorkspacePathError(`${label} is invalid`);
  }
  if (hasTraversalSegment(input)) {
    throw new WorkspacePathError(`${label} must not contain '..'`, 403);
  }

  const resolvedPath = path.resolve(input);
  if (!isPathInside(resolvedPath, canonicalRoot)) {
    throw new WorkspacePathError(
      `${label} is outside CODEX_WEBUI_BROWSE_ROOT`,
      403,
    );
  }
  assertNoSymlinkSegments(resolvedPath, canonicalRoot, label);

  let canonicalPath: string;
  try {
    canonicalPath = realpathSync(resolvedPath);
  } catch (error) {
    if (fileSystemErrorCode(error) === "ENOENT") {
      throw new WorkspacePathError(`${label} does not exist`, 404);
    }
    throw new WorkspacePathError(`${label} cannot be resolved`);
  }
  if (!isPathInside(canonicalPath, canonicalRoot)) {
    throw new WorkspacePathError(
      `${label} resolves outside CODEX_WEBUI_BROWSE_ROOT`,
      403,
    );
  }
  if (!statSync(canonicalPath).isDirectory()) {
    throw new WorkspacePathError(`${label} is not a directory`);
  }
  return canonicalPath;
}

function compareWorkspaceDirectoryEntries(
  left: WorkspaceDirectoryEntry,
  right: WorkspaceDirectoryEntry,
): number {
  const typeRank =
    (left.type === "directory" ? 0 : 1) - (right.type === "directory" ? 0 : 1);
  if (typeRank !== 0) {
    return typeRank;
  }
  const hiddenRank =
    Number(left.name.startsWith(".")) - Number(right.name.startsWith("."));
  if (hiddenRank !== 0) {
    return hiddenRank;
  }
  return left.name < right.name ? -1 : left.name > right.name ? 1 : 0;
}

export async function getWorkspaceDirectoryEntries(
  directoryPath: string | null,
  directoriesOnly: boolean,
  canonicalRoot: string,
): Promise<WorkspaceDirectoryEntries> {
  const requestedPath = directoryPath?.trim() || canonicalRoot;
  const resolvedPath = resolveBoundedDirectory(requestedPath, canonicalRoot);
  const entries = (await fs.readdir(resolvedPath, { withFileTypes: true }))
    .flatMap((entry): WorkspaceDirectoryEntry[] => {
      // Symlinks are intentionally not picker entries. Direct requests are
      // rejected by resolveBoundedDirectory as well.
      if (entry.isSymbolicLink()) {
        return [];
      }
      const type = entry.isDirectory() ? "directory" : "file";
      if (directoriesOnly && type !== "directory") {
        return [];
      }
      return [
        {
          name: entry.name,
          path: path.join(resolvedPath, entry.name),
          type,
        },
      ];
    })
    .sort(compareWorkspaceDirectoryEntries);

  const parentCandidate = path.dirname(resolvedPath);
  const parentPath =
    resolvedPath === canonicalRoot ||
    !isPathInside(parentCandidate, canonicalRoot)
      ? null
      : parentCandidate;

  return { directoryPath: resolvedPath, parentPath, entries };
}

export function safeDownloadName(
  value: string | null | undefined,
  fallback = "download",
): string {
  const lastSegment = (value ?? "").split(/[\\/]/).at(-1) ?? "";
  const sanitized = lastSegment
    .replace(/[\u0000-\u001f\u007f"]/g, "_")
    .trim()
    .slice(0, 180);
  if (!sanitized || sanitized === "." || sanitized === "..") {
    return fallback;
  }
  return sanitized;
}

export function attachmentContentDisposition(filename: string): string {
  const safeName = safeDownloadName(filename);
  const asciiName = safeName
    .replace(/[^\x20-\x7e]/g, "_")
    .replace(/[\\"]/g, "_");
  const encodedName = encodeURIComponent(safeName).replace(
    /['()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `attachment; filename="${asciiName}"; filename*=UTF-8''${encodedName}`;
}

export function contentTypeForWorkspaceFile(filename: string): string {
  const extension = path.extname(filename).toLowerCase();
  return (
    {
      ".css": "text/css; charset=utf-8",
      ".gif": "image/gif",
      ".htm": "text/html; charset=utf-8",
      ".html": "text/html; charset=utf-8",
      ".jpeg": "image/jpeg",
      ".jpg": "image/jpeg",
      ".js": "text/javascript; charset=utf-8",
      ".json": "application/json; charset=utf-8",
      ".md": "text/markdown; charset=utf-8",
      ".pdf": "application/pdf",
      ".png": "image/png",
      ".svg": "image/svg+xml",
      ".txt": "text/plain; charset=utf-8",
      ".webp": "image/webp",
    }[extension] ?? "application/octet-stream"
  );
}

export class WorkspaceFileAuthority {
  readonly browseRoot: string;
  readonly runtimeRoot: string;
  readonly uploadRoot: string;
  private readonly uploadedNames = new Map<string, string>();
  private cleanedUp = false;

  private constructor(
    browseRoot: string,
    runtimeRoot: string,
    uploadRoot: string,
  ) {
    this.browseRoot = browseRoot;
    this.runtimeRoot = runtimeRoot;
    this.uploadRoot = uploadRoot;
  }

  static async create(
    configuredRoot: string,
    temporaryParent = os.tmpdir(),
  ): Promise<WorkspaceFileAuthority> {
    const browseRoot = canonicalizeBrowseRoot(configuredRoot);
    const runtimeRoot = await fs.mkdtemp(
      path.join(temporaryParent, "codex-web-runtime-"),
    );
    const uploadRoot = path.join(runtimeRoot, "uploads");
    await fs.mkdir(uploadRoot, { mode: 0o700 });
    return new WorkspaceFileAuthority(
      browseRoot,
      realpathSync(runtimeRoot),
      realpathSync(uploadRoot),
    );
  }

  async storeUpload(
    source: NodeJS.ReadableStream,
    originalName: string | null | undefined,
  ): Promise<StoredWorkspaceUpload> {
    if (this.cleanedUp) {
      throw new Error("Workspace upload runtime has been cleaned up");
    }
    const label = safeDownloadName(originalName, "upload");
    const uploadedPath = path.join(this.uploadRoot, randomUUID());
    try {
      await pipeline(
        source,
        createWriteStream(uploadedPath, { flags: "wx", mode: 0o600 }),
      );
      const canonicalPath = realpathSync(uploadedPath);
      this.uploadedNames.set(canonicalPath, label);
      return { label, path: canonicalPath, fsPath: canonicalPath };
    } catch (error) {
      await fs.rm(uploadedPath, { force: true });
      throw error;
    }
  }

  async discardUpload(uploadedPath: string): Promise<void> {
    let canonicalPath = uploadedPath;
    try {
      canonicalPath = realpathSync(uploadedPath);
    } catch {
      // The file may already have been removed after a failed multipart body.
    }
    if (!isPathInside(path.resolve(canonicalPath), this.uploadRoot)) {
      throw new WorkspacePathError(
        "Upload cleanup path is outside upload root",
      );
    }
    this.uploadedNames.delete(canonicalPath);
    await fs.rm(uploadedPath, { force: true });
  }

  resolveAllowedFile(input: string): AllowedWorkspaceFile {
    if (!input || input.includes("\0") || !path.isAbsolute(input)) {
      throw new WorkspacePathError("File path must be absolute");
    }
    if (hasTraversalSegment(input)) {
      throw new WorkspacePathError("File path must not contain '..'", 403);
    }

    const resolvedPath = path.resolve(input);
    const isWorkspacePath = isPathInside(resolvedPath, this.browseRoot);
    const isUploadPath = isPathInside(resolvedPath, this.uploadRoot);
    if (!isWorkspacePath && !isUploadPath) {
      throw new WorkspacePathError(
        "File path is outside the allowed workspace and upload roots",
        403,
      );
    }

    const authorityRoot = isUploadPath ? this.uploadRoot : this.browseRoot;
    assertNoSymlinkSegments(resolvedPath, authorityRoot, "File path");

    let canonicalPath: string;
    try {
      canonicalPath = realpathSync(resolvedPath);
    } catch (error) {
      if (fileSystemErrorCode(error) === "ENOENT") {
        throw new WorkspacePathError("File does not exist", 404);
      }
      throw new WorkspacePathError("File cannot be resolved");
    }
    if (!isPathInside(canonicalPath, authorityRoot)) {
      throw new WorkspacePathError(
        "File resolves outside its allowed root",
        403,
      );
    }
    if (isUploadPath && !this.uploadedNames.has(canonicalPath)) {
      throw new WorkspacePathError("Upload file is not registered", 403);
    }
    if (!statSync(canonicalPath).isFile()) {
      throw new WorkspacePathError("File path is not a regular file");
    }

    return {
      path: canonicalPath,
      downloadName: isUploadPath
        ? this.uploadedNames.get(canonicalPath)!
        : safeDownloadName(canonicalPath),
      source: isUploadPath ? "upload" : "workspace",
    };
  }

  async cleanup(): Promise<void> {
    if (this.cleanedUp) {
      return;
    }
    this.cleanedUp = true;
    this.uploadedNames.clear();
    await fs.rm(this.runtimeRoot, { recursive: true, force: true });
  }
}
