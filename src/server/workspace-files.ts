import {
  constants,
  lstatSync,
  realpathSync,
  statSync,
  type BigIntStats,
  type Dirent,
} from "node:fs";
import fs, { type FileHandle } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { type Readable } from "node:stream";
import { finished } from "node:stream/promises";

export const WORKSPACE_UPLOAD_LIMITS = {
  fileSize: 25 * 1024 * 1024,
  files: 20,
  fields: 0,
  parts: 20,
} as const;

export const DEFAULT_UPLOAD_QUOTA_BYTES = 512 * 1024 * 1024;

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

export type OpenedAllowedWorkspaceFile = {
  path: string;
  downloadName: string;
  source: "upload" | "workspace";
  stream: Readable;
};

export type UploadAccounting = {
  quotaBytes: number;
  retainedBytes: number;
  inFlightBytes: number;
  totalBytes: number;
  peakBytes: number;
};

type UploadRecord = {
  label: string;
  storageName: string;
  device: bigint;
  inode: bigint;
  bytes: number;
};

type ActiveUpload = {
  source: NodeJS.ReadableStream;
  storageName: string;
  handle: FileHandle | null;
  reservedBytes: number;
  opened: Promise<void>;
  markOpened: () => void;
};

type ClassifiedPath = {
  requestedPath: string;
  relativePath: string;
  root: "browse" | "upload";
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

export function parseAllowAnyProject(rawValue: string | undefined): boolean {
  if (rawValue === undefined || rawValue === "false") {
    return false;
  }
  if (rawValue === "true") {
    return true;
  }
  throw new Error("CODEX_WEBUI_ALLOW_ANY_PROJECT must be true or false");
}

export function resolveConfiguredBrowseRoot(
  configuredRoot: string | undefined,
  homeDirectory: string,
  allowAnyProject: boolean,
): string {
  if (allowAnyProject) {
    return path.parse(path.resolve(homeDirectory)).root;
  }
  return configuredRoot?.trim() || homeDirectory;
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

export function parseUploadQuotaBytes(rawValue: string | undefined): number {
  if (rawValue === undefined) {
    return DEFAULT_UPLOAD_QUOTA_BYTES;
  }
  if (!/^\d+$/.test(rawValue)) {
    throw new Error(
      "CODEX_WEBUI_UPLOAD_QUOTA_BYTES must be a positive decimal safe integer",
    );
  }
  const parsed = Number(rawValue);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(
      "CODEX_WEBUI_UPLOAD_QUOTA_BYTES must be a positive decimal safe integer",
    );
  }
  return parsed;
}

function hasTraversalSegment(value: string): boolean {
  return value.split(path.sep).includes("..");
}

// This pathname-returning helper remains only for app-server cwd and root
// sanitization. The separate Codex process consumes those strings later, so
// descriptor continuity cannot cross that IPC boundary.
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
  let current = canonicalRoot;
  for (const segment of path
    .relative(canonicalRoot, resolvedPath)
    .split(path.sep)
    .filter(Boolean)) {
    current = path.join(current, segment);
    let stat;
    try {
      stat = lstatSync(current);
    } catch (error) {
      if (fileSystemErrorCode(error) === "ENOENT") {
        throw new WorkspacePathError(`${label} does not exist`, 404);
      }
      throw new WorkspacePathError(`${label} cannot be inspected`);
    }
    if (stat.isSymbolicLink()) {
      throw new WorkspacePathError(`${label} must not contain symlinks`, 403);
    }
  }
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
      ".gif": "image/gif",
      ".jpeg": "image/jpeg",
      ".jpg": "image/jpeg",
      ".png": "image/png",
      ".webp": "image/webp",
    }[extension] ?? "application/octet-stream"
  );
}

function descriptorPath(handle: FileHandle, relativePath?: string): string {
  const root = path.join("/proc/self/fd", String(handle.fd));
  return relativePath ? path.join(root, relativePath) : root;
}

async function workspaceOpenError(
  error: unknown,
  label: string,
  targetPath?: string,
): Promise<WorkspacePathError> {
  const code = fileSystemErrorCode(error);
  if (code === "ENOENT") {
    return new WorkspacePathError(`${label} does not exist`, 404);
  }
  if (targetPath) {
    try {
      await fs.readlink(targetPath);
      return new WorkspacePathError(
        `${label} resolves outside its pinned authority root`,
        403,
      );
    } catch {
      // Fall through to the generic error handling below.
    }
  }
  if (code === "ENOTDIR" || code === "ELOOP") {
    return new WorkspacePathError(`${label} does not exist`, 404);
  }
  if (code === "EACCES" || code === "EPERM") {
    return new WorkspacePathError(`${label} is not authorized`, 403);
  }
  return new WorkspacePathError(`${label} cannot be opened`);
}

type OpenedWorkspacePath = {
  handle: FileHandle;
  ownsHandle: boolean;
  stat: BigIntStats;
};

const PINNED_ROOT_OPEN_FLAGS =
  constants.O_RDONLY |
  constants.O_DIRECTORY |
  constants.O_NONBLOCK |
  constants.O_NOFOLLOW;

async function captureDirectoryIdentity(
  directoryPath: string,
  changedMessage: string,
): Promise<BigIntStats> {
  const stat = await fs.stat(directoryPath, { bigint: true });
  if (!stat.isDirectory()) {
    throw new Error(changedMessage);
  }
  return stat;
}

function validatePinnedDirectoryIdentity(
  openedStat: BigIntStats,
  expectedStat: BigIntStats,
  changedMessage: string,
): void {
  if (
    !openedStat.isDirectory() ||
    openedStat.dev !== expectedStat.dev ||
    openedStat.ino !== expectedStat.ino
  ) {
    throw new Error(changedMessage);
  }
}

async function openWorkspacePathWithinRoot(
  rootHandle: FileHandle,
  relativePath: string,
  label: string,
  targetType: "directory" | "file",
): Promise<OpenedWorkspacePath> {
  const segments = relativePath.split(path.sep).filter(Boolean);
  if (segments.length === 0) {
    const stat = await rootHandle.stat({ bigint: true });
    if (targetType === "directory" && !stat.isDirectory()) {
      throw new WorkspacePathError(`${label} is not a directory`);
    }
    if (targetType === "file" && !stat.isFile()) {
      throw new WorkspacePathError(`${label} is not a regular file`);
    }
    return { handle: rootHandle, ownsHandle: false, stat };
  }

  const openedHandles: FileHandle[] = [];
  try {
    let currentHandle = rootHandle;
    for (let index = 0; index < segments.length; index++) {
      const segment = segments[index]!;
      const isFinal = index === segments.length - 1;
      const flags =
        constants.O_RDONLY |
        constants.O_NONBLOCK |
        constants.O_NOFOLLOW |
        (!isFinal || targetType === "directory" ? constants.O_DIRECTORY : 0);
      let nextHandle: FileHandle;
      try {
        nextHandle = await fs.open(
          descriptorPath(currentHandle, segment),
          flags,
        );
      } catch (error) {
        throw await workspaceOpenError(
          error,
          label,
          descriptorPath(currentHandle, segment),
        );
      }
      openedHandles.push(nextHandle);
      currentHandle = nextHandle;
    }

    const openedStat = await currentHandle.stat({ bigint: true });
    if (targetType === "directory") {
      if (!openedStat.isDirectory()) {
        throw new WorkspacePathError(`${label} is not a directory`);
      }
    } else if (!openedStat.isFile()) {
      throw new WorkspacePathError(`${label} is not a regular file`);
    }

    await Promise.allSettled(
      openedHandles.slice(0, -1).map((handle) => closeHandle(handle)),
    );
    return {
      handle: openedHandles.at(-1)!,
      ownsHandle: true,
      stat: openedStat,
    };
  } catch (error) {
    await Promise.allSettled(
      openedHandles.map((handle) => closeHandle(handle)),
    );
    throw error;
  }
}

function unsafeUploadDiscardError(): WorkspacePathError {
  return new WorkspacePathError(
    "Registered upload cannot be safely discarded",
    403,
  );
}

async function closeHandle(handle: FileHandle | null): Promise<void> {
  if (handle) {
    await handle.close();
  }
}

export class WorkspaceFileAuthority {
  readonly browseRoot: string;
  readonly runtimeRoot: string;
  readonly uploadRoot: string;
  readonly uploadQuotaBytes: number;

  private readonly browseRootHandle: FileHandle;
  private readonly uploadRootHandle: FileHandle;
  private readonly uploadedFiles = new Map<string, UploadRecord>();
  private readonly activeUploadDiscards = new Map<string, Promise<void>>();
  private readonly activeAuthorityOperations = new Set<Promise<void>>();
  private readonly activeReadStreams = new Set<Readable>();
  private readonly activeUploads = new Set<ActiveUpload>();
  private retainedBytes = 0;
  private inFlightBytes = 0;
  private peakBytes = 0;
  private cleanedUp = false;
  private cleanupPromise: Promise<void> | null = null;

  private constructor(
    browseRoot: string,
    runtimeRoot: string,
    uploadRoot: string,
    uploadQuotaBytes: number,
    browseRootHandle: FileHandle,
    uploadRootHandle: FileHandle,
  ) {
    this.browseRoot = browseRoot;
    this.runtimeRoot = runtimeRoot;
    this.uploadRoot = uploadRoot;
    this.uploadQuotaBytes = uploadQuotaBytes;
    this.browseRootHandle = browseRootHandle;
    this.uploadRootHandle = uploadRootHandle;
  }

  static async create(
    configuredRoot: string,
    temporaryParent = os.tmpdir(),
    uploadQuotaBytes = DEFAULT_UPLOAD_QUOTA_BYTES,
  ): Promise<WorkspaceFileAuthority> {
    if (!Number.isSafeInteger(uploadQuotaBytes) || uploadQuotaBytes <= 0) {
      throw new Error("Upload quota must be a positive safe integer");
    }
    const browseRoot = canonicalizeBrowseRoot(configuredRoot);
    let browseRootHandle: FileHandle | null = null;
    let uploadRootHandle: FileHandle | null = null;
    let runtimeRoot: string | null = null;
    try {
      const browseRootChangedMessage =
        "CODEX_WEBUI_BROWSE_ROOT changed while its authority was pinned";
      const expectedBrowseRootStat = await captureDirectoryIdentity(
        browseRoot,
        browseRootChangedMessage,
      );
      browseRootHandle = await fs.open(browseRoot, PINNED_ROOT_OPEN_FLAGS);
      const browseStat = await browseRootHandle.stat({ bigint: true });
      validatePinnedDirectoryIdentity(
        browseStat,
        expectedBrowseRootStat,
        browseRootChangedMessage,
      );

      runtimeRoot = await fs.mkdtemp(
        path.join(temporaryParent, "codex-web-runtime-"),
      );
      const uploadRoot = path.join(runtimeRoot, "uploads");
      await fs.mkdir(uploadRoot, { mode: 0o700 });
      const uploadRootChangedMessage =
        "Workspace upload root changed while it was pinned";
      const expectedUploadRootStat = await captureDirectoryIdentity(
        uploadRoot,
        uploadRootChangedMessage,
      );
      uploadRootHandle = await fs.open(uploadRoot, PINNED_ROOT_OPEN_FLAGS);
      const uploadStat = await uploadRootHandle.stat({ bigint: true });
      validatePinnedDirectoryIdentity(
        uploadStat,
        expectedUploadRootStat,
        uploadRootChangedMessage,
      );

      return new WorkspaceFileAuthority(
        browseRoot,
        runtimeRoot,
        uploadRoot,
        uploadQuotaBytes,
        browseRootHandle,
        uploadRootHandle,
      );
    } catch (error) {
      await Promise.allSettled([
        closeHandle(uploadRootHandle),
        closeHandle(browseRootHandle),
      ]);
      if (runtimeRoot) {
        await fs.rm(runtimeRoot, { recursive: true, force: true });
      }
      throw error;
    }
  }

  getUploadAccounting(): UploadAccounting {
    return {
      quotaBytes: this.uploadQuotaBytes,
      retainedBytes: this.retainedBytes,
      inFlightBytes: this.inFlightBytes,
      totalBytes: this.retainedBytes + this.inFlightBytes,
      peakBytes: this.peakBytes,
    };
  }

  getActiveDescriptorState(): {
    rootDescriptors: number;
    readDescriptors: number;
    uploadOperations: number;
  } {
    return {
      rootDescriptors: this.cleanedUp ? 0 : 2,
      readDescriptors: this.activeReadStreams.size,
      uploadOperations: this.activeUploads.size,
    };
  }

  private assertActive(): void {
    if (this.cleanedUp) {
      throw new Error("Workspace file authority has been cleaned up");
    }
  }

  private beginAuthorityOperation(): () => void {
    this.assertActive();
    let finishOperation!: () => void;
    const completion = new Promise<void>((resolve) => {
      finishOperation = resolve;
    });
    this.activeAuthorityOperations.add(completion);
    return () => {
      this.activeAuthorityOperations.delete(completion);
      finishOperation();
    };
  }

  private classifyPath(input: string, allowUpload: boolean): ClassifiedPath {
    if (!input || input.includes("\0") || !path.isAbsolute(input)) {
      throw new WorkspacePathError("File path must be absolute");
    }
    if (hasTraversalSegment(input)) {
      throw new WorkspacePathError("File path must not contain '..'", 403);
    }

    const requestedPath = path.resolve(input);
    if (allowUpload && isPathInside(requestedPath, this.uploadRoot)) {
      return {
        requestedPath,
        relativePath: path.relative(this.uploadRoot, requestedPath),
        root: "upload",
      };
    }
    if (isPathInside(requestedPath, this.browseRoot)) {
      return {
        requestedPath,
        relativePath: path.relative(this.browseRoot, requestedPath),
        root: "browse",
      };
    }
    throw new WorkspacePathError(
      allowUpload
        ? "File path is outside the allowed workspace and upload roots"
        : "Workspace directory is outside CODEX_WEBUI_BROWSE_ROOT",
      403,
    );
  }

  async getWorkspaceDirectoryEntries(
    directoryPath: string | null,
    directoriesOnly: boolean,
  ): Promise<WorkspaceDirectoryEntries> {
    this.assertActive();
    const requested = directoryPath?.trim() || this.browseRoot;
    const classified = this.classifyPath(requested, false);
    const finishOperation = this.beginAuthorityOperation();
    let opened: OpenedWorkspacePath | null = null;
    try {
      opened = await openWorkspacePathWithinRoot(
        this.browseRootHandle,
        classified.relativePath,
        "Workspace directory",
        "directory",
      );
      this.assertActive();

      // Readdir is rooted at the already-open descriptor. The caller pathname
      // is never reopened, so replacing it cannot change the consumed inode.
      const directoryEntries = await fs.readdir(descriptorPath(opened.handle), {
        withFileTypes: true,
      });
      const entries = directoryEntries
        .flatMap((entry: Dirent): WorkspaceDirectoryEntry[] => {
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
              path: path.join(classified.requestedPath, entry.name),
              type,
            },
          ];
        })
        .sort(compareWorkspaceDirectoryEntries);

      const parentCandidate = path.dirname(classified.requestedPath);
      const parentPath =
        classified.requestedPath === this.browseRoot ||
        !isPathInside(parentCandidate, this.browseRoot)
          ? null
          : parentCandidate;
      return {
        directoryPath: classified.requestedPath,
        parentPath,
        entries,
      };
    } finally {
      try {
        if (opened?.ownsHandle) {
          await closeHandle(opened.handle);
        }
      } finally {
        finishOperation();
      }
    }
  }

  private reserveUploadBytes(bytes: number): void {
    this.assertActive();
    const nextTotal = this.retainedBytes + this.inFlightBytes + bytes;
    if (nextTotal > this.uploadQuotaBytes) {
      throw new WorkspacePathError("upload storage quota exceeded", 413);
    }
    this.inFlightBytes += bytes;
    this.peakBytes = Math.max(this.peakBytes, nextTotal);
  }

  async storeUpload(
    source: NodeJS.ReadableStream,
    originalName: string | null | undefined,
  ): Promise<StoredWorkspaceUpload> {
    this.assertActive();
    const label = safeDownloadName(originalName, "upload");
    const storageName = randomUUID();
    const uploadedPath = path.join(this.uploadRoot, storageName);
    let markOpened!: () => void;
    const opened = new Promise<void>((resolve) => {
      markOpened = resolve;
    });
    const activeUpload: ActiveUpload = {
      source,
      storageName,
      handle: null,
      reservedBytes: 0,
      opened,
      markOpened,
    };
    this.activeUploads.add(activeUpload);
    let handle: FileHandle | null = null;
    try {
      try {
        handle = await fs.open(
          descriptorPath(this.uploadRootHandle, storageName),
          constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
          0o600,
        );
      } finally {
        activeUpload.markOpened();
      }
      activeUpload.handle = handle;
      this.assertActive();
      const openedStat = await handle.stat({ bigint: true });
      if (!openedStat.isFile()) {
        throw new Error("Upload storage target is not a regular file");
      }

      for await (const value of source as NodeJS.ReadableStream &
        AsyncIterable<unknown>) {
        const chunk =
          typeof value === "string"
            ? Buffer.from(value)
            : Buffer.isBuffer(value)
              ? value
              : null;
        if (!chunk) {
          throw new Error("Upload stream produced a non-byte chunk");
        }
        this.reserveUploadBytes(chunk.byteLength);
        activeUpload.reservedBytes += chunk.byteLength;
        let offset = 0;
        while (offset < chunk.byteLength) {
          const result = await handle.write(
            chunk,
            offset,
            chunk.byteLength - offset,
            null,
          );
          if (result.bytesWritten <= 0) {
            throw new Error("Upload write made no progress");
          }
          offset += result.bytesWritten;
        }
      }

      const stat = await handle.stat({ bigint: true });
      if (!stat.isFile() || stat.size !== BigInt(activeUpload.reservedBytes)) {
        throw new Error("Stored upload identity or size is invalid");
      }
      await handle.close();
      handle = null;
      activeUpload.handle = null;
      this.assertActive();

      this.inFlightBytes -= activeUpload.reservedBytes;
      this.retainedBytes += activeUpload.reservedBytes;
      this.uploadedFiles.set(uploadedPath, {
        label,
        storageName,
        device: stat.dev,
        inode: stat.ino,
        bytes: activeUpload.reservedBytes,
      });
      activeUpload.reservedBytes = 0;
      return { label, path: uploadedPath, fsPath: uploadedPath };
    } catch (error) {
      this.inFlightBytes -= activeUpload.reservedBytes;
      activeUpload.reservedBytes = 0;
      await closeHandle(handle).catch(() => undefined);
      handle = null;
      activeUpload.handle = null;
      await fs
        .rm(descriptorPath(this.uploadRootHandle, storageName), { force: true })
        .catch(() => undefined);
      throw error;
    } finally {
      await closeHandle(handle).catch(() => undefined);
      this.activeUploads.delete(activeUpload);
    }
  }

  async discardUpload(uploadedPath: string): Promise<void> {
    if (!uploadedPath || !path.isAbsolute(uploadedPath)) {
      throw new WorkspacePathError("Upload cleanup path must be absolute");
    }
    const resolvedPath = path.resolve(uploadedPath);
    if (!isPathInside(resolvedPath, this.uploadRoot)) {
      throw new WorkspacePathError(
        "Upload cleanup path is outside upload root",
      );
    }
    const record = this.uploadedFiles.get(resolvedPath);
    if (!record) {
      return;
    }

    const activeDiscard = this.activeUploadDiscards.get(resolvedPath);
    if (activeDiscard) {
      return activeDiscard;
    }

    const discard = this.discardRegisteredUpload(resolvedPath, record);
    this.activeUploadDiscards.set(resolvedPath, discard);
    try {
      await discard;
    } finally {
      if (this.activeUploadDiscards.get(resolvedPath) === discard) {
        this.activeUploadDiscards.delete(resolvedPath);
      }
    }
  }

  private async discardRegisteredUpload(
    resolvedPath: string,
    record: UploadRecord,
  ): Promise<void> {
    const finishOperation = this.beginAuthorityOperation();
    let handle: FileHandle | null = null;
    try {
      let openedStat!: BigIntStats;
      try {
        const opened = await openWorkspacePathWithinRoot(
          this.uploadRootHandle,
          record.storageName,
          "Registered upload",
          "file",
        );
        handle = opened.handle;
        openedStat = opened.stat;
        if (
          !openedStat.isFile() ||
          openedStat.dev !== record.device ||
          openedStat.ino !== record.inode ||
          openedStat.size !== BigInt(record.bytes)
        ) {
          throw unsafeUploadDiscardError();
        }
      } catch {
        throw unsafeUploadDiscardError();
      }

      // Node has no identity-checked unlinkat API. The upload root is created
      // mode 0700 inside a private per-process runtime and normal service code
      // mutates it only through this authority. Opening with O_NOFOLLOW through
      // the pinned root rejects substitutions already present; the fstat after
      // unlink also prevents quota release unless this opened inode lost the
      // registered directory entry. This does not claim atomic protection from
      // a hostile same-UID process swapping the name between fstat and unlink.
      try {
        await fs.unlink(
          descriptorPath(this.uploadRootHandle, record.storageName),
        );
        const discardedStat = await handle.stat({ bigint: true });
        if (
          discardedStat.dev !== openedStat.dev ||
          discardedStat.ino !== openedStat.ino ||
          discardedStat.size !== openedStat.size ||
          openedStat.nlink < 1n ||
          discardedStat.nlink !== openedStat.nlink - 1n
        ) {
          throw new Error("registered upload link count did not decrease");
        }
      } catch {
        throw unsafeUploadDiscardError();
      }

      if (this.uploadedFiles.get(resolvedPath) === record) {
        this.uploadedFiles.delete(resolvedPath);
        this.retainedBytes -= record.bytes;
      }
    } finally {
      try {
        await closeHandle(handle);
      } finally {
        finishOperation();
      }
    }
  }

  async openAllowedFile(input: string): Promise<OpenedAllowedWorkspaceFile> {
    this.assertActive();
    const classified = this.classifyPath(input, true);
    const finishOperation = this.beginAuthorityOperation();
    const rootHandle =
      classified.root === "upload"
        ? this.uploadRootHandle
        : this.browseRootHandle;
    let handle: FileHandle | null = null;
    let shouldCloseHandle = false;
    try {
      const opened = await openWorkspacePathWithinRoot(
        rootHandle,
        classified.relativePath,
        "File path",
        "file",
      );
      handle = opened.handle;
      shouldCloseHandle = opened.ownsHandle;
      const stat = opened.stat;
      this.assertActive();

      let downloadName: string;
      if (classified.root === "upload") {
        const record = this.uploadedFiles.get(classified.requestedPath);
        if (!record) {
          throw new WorkspacePathError("Upload file is not registered", 403);
        }
        if (
          record.device !== stat.dev ||
          record.inode !== stat.ino ||
          BigInt(record.bytes) !== stat.size
        ) {
          throw new WorkspacePathError(
            "Upload file identity no longer matches its registration",
            403,
          );
        }
        downloadName = record.label;
      } else {
        downloadName = safeDownloadName(classified.requestedPath);
      }

      const stream = handle.createReadStream({ autoClose: true });
      handle = null;
      this.activeReadStreams.add(stream);
      stream.once("close", () => this.activeReadStreams.delete(stream));
      return {
        path: classified.requestedPath,
        downloadName,
        source: classified.root === "upload" ? "upload" : "workspace",
        stream,
      };
    } catch (error) {
      if (shouldCloseHandle) {
        await closeHandle(handle).catch(() => undefined);
      }
      throw error;
    } finally {
      finishOperation();
    }
  }

  async cleanup(): Promise<void> {
    if (this.cleanupPromise) {
      return this.cleanupPromise;
    }
    this.cleanedUp = true;
    this.cleanupPromise = (async () => {
      await Promise.all([...this.activeAuthorityOperations]);
      const readCompletions = [...this.activeReadStreams].map((stream) =>
        finished(stream).catch(() => undefined),
      );
      for (const stream of this.activeReadStreams) {
        stream.destroy(new Error("Workspace file authority is shutting down"));
      }
      for (const upload of this.activeUploads) {
        const destroy = (
          upload.source as NodeJS.ReadableStream & {
            destroy?: (error?: Error) => void;
          }
        ).destroy;
        destroy?.call(upload.source);
        this.inFlightBytes -= upload.reservedBytes;
        upload.reservedBytes = 0;
      }
      const uploadClosures = [...this.activeUploads].map(async (upload) => {
        await upload.opened;
        await closeHandle(upload.handle).catch(() => undefined);
        upload.handle = null;
        await fs
          .rm(descriptorPath(this.uploadRootHandle, upload.storageName), {
            force: true,
          })
          .catch(() => undefined);
      });
      await Promise.all([...readCompletions, ...uploadClosures]);
      this.activeUploads.clear();

      this.uploadedFiles.clear();
      this.retainedBytes = 0;
      this.inFlightBytes = 0;
      const errors: unknown[] = [];
      try {
        await fs.rm(this.runtimeRoot, { recursive: true, force: true });
      } catch (error) {
        errors.push(error);
      }
      for (const handle of [this.uploadRootHandle, this.browseRootHandle]) {
        try {
          await handle.close();
        } catch (error) {
          errors.push(error);
        }
      }
      if (errors.length > 0) {
        throw new AggregateError(
          errors,
          "Workspace file authority cleanup failed",
        );
      }
    })();
    return this.cleanupPromise;
  }
}
