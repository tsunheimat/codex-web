import { emitRendererEvent, isRecord } from "./shim";

type CodexFetchMessage = {
  body?: string;
  headers?: Record<string, string>;
  hostId?: string;
  method: string;
  requestId: string;
  type: "fetch";
  url: string;
};

type PickFilesRequest = {
  imagesOnly?: boolean;
  pickerTitle?: string;
};

function downloadFilename(
  contentDisposition: string | null,
  filePath: string,
): string {
  const encoded = contentDisposition?.match(/filename\*=UTF-8''([^;]+)/i)?.[1];
  if (encoded) {
    try {
      return decodeURIComponent(encoded);
    } catch {
      // Fall back to the safe ASCII filename supplied by the server.
    }
  }
  const ascii = contentDisposition?.match(/filename="([^"]+)"/i)?.[1];
  return ascii || filePath.split(/[\\/]/).at(-1) || "download";
}

export async function downloadWorkspaceFileCopy({
  hostId,
  path,
}: {
  hostId: string;
  path: string;
}): Promise<void> {
  if (hostId !== "local") {
    throw new Error("Only local workspace files can be downloaded");
  }
  const downloadUrl = new URL("/__backend/download", window.location.href);
  downloadUrl.searchParams.set("path", path);
  const response = await fetch(downloadUrl);
  if (!response.ok) {
    throw new Error(
      `Download failed: ${response.status} ${response.statusText}`,
    );
  }

  const objectUrl = URL.createObjectURL(await response.blob());
  const anchor = document.createElement("a");
  anchor.href = objectUrl;
  anchor.download = downloadFilename(
    response.headers.get("content-disposition"),
    path,
  );
  anchor.style.display = "none";
  document.body.append(anchor);
  try {
    anchor.click();
  } finally {
    anchor.remove();
    window.setTimeout(() => URL.revokeObjectURL(objectUrl), 0);
  }
}

function openBrowserFilePicker({
  allowMultiple,
  imagesOnly,
}: {
  allowMultiple: boolean;
  imagesOnly?: boolean;
}): Promise<File[]> {
  return new Promise((resolve, reject) => {
    const input = document.createElement("input");
    let settled = false;

    function cleanup(): void {
      input.removeEventListener("cancel", handleCancel);
      input.removeEventListener("change", handleChange);
      input.remove();
    }

    function finish(files: File[]): void {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      resolve(files);
    }

    function fail(error: unknown): void {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      reject(error);
    }

    function handleCancel(): void {
      finish([]);
    }

    function handleChange(): void {
      finish(Array.from(input.files ?? []));
    }

    input.type = "file";
    input.multiple = allowMultiple;
    if (imagesOnly) {
      input.accept = "image/*";
    }
    Object.assign(input.style, {
      height: "1px",
      left: "-9999px",
      opacity: "0",
      position: "fixed",
      top: "0",
      width: "1px",
    });
    input.addEventListener("cancel", handleCancel);
    input.addEventListener("change", handleChange);
    document.body.append(input);

    try {
      input.click();
    } catch (error) {
      fail(error);
    }
  });
}

async function uploadFiles(files: File[]) {
  if (files.length === 0) {
    return [];
  }

  const uploadUrl = new URL("/__backend/upload", window.location.href);
  const formData = new FormData();

  for (const file of files) {
    formData.append("files", file, file.name || "upload");
  }

  const response = await fetch(uploadUrl, {
    method: "POST",
    body: formData,
  });

  if (!response.ok) {
    throw new Error(`Upload failed: ${response.status} ${response.statusText}`);
  }

  return (await response.json()).files;
}

export async function handleLocalFilePickerMessage(message: CodexFetchMessage) {
  try {
    const response = await handleLocalFilePickerMessageInner(message);

    sendFetchResponse(message, {
      responseType: "success",
      body: response,
    });
  } catch (error) {
    console.error(error);

    sendFetchResponse(message, {
      responseType: "error",
      status: 432,
      error: errorMessage(error),
    });
  }
}

async function handleLocalFilePickerMessageInner(message: CodexFetchMessage) {
  const request = parsePickFilesRequest(message);
  const allowMultiple = message.url === "vscode://codex/pick-files";

  const selectedFiles = await openBrowserFilePicker({
    allowMultiple,
    imagesOnly: request.imagesOnly,
  });

  const uploadedFiles = await uploadFiles(selectedFiles);

  return allowMultiple
    ? { files: uploadedFiles }
    : { file: uploadedFiles[0] ?? null };
}

function isCodexFetchMessage(value: unknown): value is CodexFetchMessage {
  return isRecord(value) && value.type === "fetch";
}

export function isLocalFilePickerMessage(
  value: unknown,
): value is CodexFetchMessage {
  return (
    isCodexFetchMessage(value) &&
    value.method.toUpperCase() === "POST" &&
    (value.url === "vscode://codex/pick-files" ||
      value.url === "vscode://codex/pick-file")
  );
}

function parsePickFilesRequest(message: CodexFetchMessage): PickFilesRequest {
  if (!message.body) {
    return {};
  }

  try {
    const parsed = JSON.parse(message.body) as unknown;
    if (!isRecord(parsed)) {
      return {};
    }
    return {
      imagesOnly:
        typeof parsed.imagesOnly === "boolean" ? parsed.imagesOnly : undefined,
      pickerTitle:
        typeof parsed.pickerTitle === "string" ? parsed.pickerTitle : undefined,
    };
  } catch {
    return {};
  }
}

function sendFetchResponse(
  message: CodexFetchMessage,
  response:
    | {
        responseType: "success";
        body: unknown;
        status?: number;
      }
    | {
        responseType: "error";
        error: string;
        status?: number;
      },
): void {
  const payload =
    response.responseType === "success"
      ? {
          type: "fetch-response",
          responseType: "success",
          requestId: message.requestId,
          status: response.status ?? 200,
          headers: { "content-type": "application/json" },
          bodyJsonString: JSON.stringify(response.body),
        }
      : {
          type: "fetch-response",
          responseType: "error",
          requestId: message.requestId,
          status: response.status ?? 432,
          error: response.error,
        };

  emitRendererEvent("codex_desktop:message-for-view", [payload]);
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}
