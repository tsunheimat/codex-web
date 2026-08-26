const assert = require("node:assert/strict");
const test = require("node:test");
const {
  decodeMessagePortData,
  encodeMessagePortData,
} = require("../src/server/message-port-data.js");

test("message-port serialization preserves nested binary image bytes", () => {
  const original = {
    bytes: new Uint8Array([0, 1, 2, 137, 80, 78, 71, 255]),
    nested: [new Uint8Array([254, 253])],
  };
  const wire = encodeMessagePortData(original);
  assert.equal(JSON.stringify(wire).includes('"0":0'), false);

  const decoded = decodeMessagePortData(JSON.parse(JSON.stringify(wire)));
  assert(decoded && typeof decoded === "object");
  assert.deepEqual(Array.from(decoded.bytes), Array.from(original.bytes));
  assert.equal(Array.isArray(decoded.nested), true);
  assert.deepEqual(Array.from(decoded.nested[0]), [254, 253]);
});

test("message-port serialization leaves malformed binary envelopes untouched", () => {
  const malformed = {
    __codex_web_message_port_data__: "uint8array",
    data: "not base64",
  };
  assert.deepEqual(decodeMessagePortData(malformed), malformed);
});
