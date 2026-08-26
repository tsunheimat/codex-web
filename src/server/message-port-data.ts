const BINARY_KIND = "uint8array";
const BINARY_MARKER = "__codex_web_message_port_data__";
const BASE64_ALPHABET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

// Browser MessagePort values cross the reliable bridge as JSON. Preserve the
// binary values used by fileAttachments.persistImageFileToTemp instead of
// letting JSON.stringify turn a Uint8Array into an object of numeric keys.

type BinaryEnvelope = {
  [BINARY_MARKER]: typeof BINARY_KIND;
  data: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function encodeBase64(bytes: Uint8Array): string {
  let result = "";
  for (let index = 0; index < bytes.length; index += 3) {
    const first = bytes[index] ?? 0;
    const second = bytes[index + 1];
    const third = bytes[index + 2];
    result += BASE64_ALPHABET[first >> 2] ?? "";
    result +=
      BASE64_ALPHABET[((first & 0x03) << 4) | ((second ?? 0) >> 4)] ?? "";
    result +=
      second === undefined
        ? "="
        : BASE64_ALPHABET[((second & 0x0f) << 2) | ((third ?? 0) >> 6)] ?? "";
    result += third === undefined ? "=" : BASE64_ALPHABET[third & 0x3f] ?? "";
  }
  return result;
}

function decodeBase64(value: string): Uint8Array | null {
  if (
    value.length % 4 !== 0 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
      value,
    )
  ) {
    return null;
  }
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  const output = new Uint8Array((value.length / 4) * 3 - padding);
  let outputIndex = 0;
  for (let index = 0; index < value.length; index += 4) {
    const first = BASE64_ALPHABET.indexOf(value[index]!);
    const second = BASE64_ALPHABET.indexOf(value[index + 1]!);
    const third =
      value[index + 2] === "="
        ? 0
        : BASE64_ALPHABET.indexOf(value[index + 2]!);
    const fourth =
      value[index + 3] === "="
        ? 0
        : BASE64_ALPHABET.indexOf(value[index + 3]!);
    output[outputIndex++] = (first << 2) | (second >> 4);
    if (outputIndex < output.length) {
      output[outputIndex++] = ((second & 0x0f) << 4) | (third >> 2);
    }
    if (outputIndex < output.length) {
      output[outputIndex++] = ((third & 0x03) << 6) | fourth;
    }
  }
  return output;
}

export function encodeMessagePortData(value: unknown): unknown {
  if (value instanceof Uint8Array) {
    return {
      [BINARY_MARKER]: BINARY_KIND,
      data: encodeBase64(value),
    } satisfies BinaryEnvelope;
  }
  if (value instanceof ArrayBuffer) {
    return {
      [BINARY_MARKER]: BINARY_KIND,
      data: encodeBase64(new Uint8Array(value)),
    } satisfies BinaryEnvelope;
  }
  if (Array.isArray(value)) {
    return value.map(encodeMessagePortData);
  }
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        encodeMessagePortData(item),
      ]),
    );
  }
  return value;
}

export function decodeMessagePortData(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(decodeMessagePortData);
  }
  if (isRecord(value)) {
    if (
      value[BINARY_MARKER] === BINARY_KIND &&
      typeof value.data === "string" &&
      Object.keys(value).length === 2
    ) {
      return decodeBase64(value.data) ?? value;
    }
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        decodeMessagePortData(item),
      ]),
    );
  }
  return value;
}
