const BINDING_ID = "codex-web-native/26.908.40834/v1";
const METHODS = new Set([
  "native/photo/upload",
  "native/message/send",
  "native/operation/read",
  "native/cu/attach",
  "native/cu/sync",
  "native/cu/answer",
  "native/cu/stop",
]);
const MUTATIONS = new Set([
  "native/photo/upload",
  "native/message/send",
  "native/cu/answer",
  "native/cu/stop",
]);
const FRAME_LIMIT = 8 * 1024 * 1024;
const CAPTURE_LIMIT = 1024 * 1024;
function checkedId(value) {
  if (typeof value !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(value))
    throw new Error("Invalid native identity");
  return value;
}
function nativeError(message, deliveryUnknown = false) {
  return Object.assign(new Error(message), { deliveryUnknown });
}
module.exports = {
  BINDING_ID,
  METHODS,
  MUTATIONS,
  FRAME_LIMIT,
  CAPTURE_LIMIT,
  checkedId,
  nativeError,
};
