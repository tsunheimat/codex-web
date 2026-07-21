const assert = require("node:assert/strict");
const test = require("node:test");
const {
  consumeBackendRestartRecoveryMarker,
  storeBackendRestartRecoveryMarker,
} = require("../src/server/restart-recovery-marker.js");

class FakeStorage {
  values = new Map();

  getItem(key) {
    return this.values.get(key) ?? null;
  }

  removeItem(key) {
    this.values.delete(key);
  }

  setItem(key, value) {
    this.values.set(key, value);
  }
}

test("backend restart marker is exact and single use", () => {
  const storage = new FakeStorage();
  assert.equal(storeBackendRestartRecoveryMarker(storage), true);
  assert.equal(
    consumeBackendRestartRecoveryMarker(storage),
    "backend-restarted",
  );
  assert.equal(consumeBackendRestartRecoveryMarker(storage), null);
});

test("invalid marker values are consumed fail closed", () => {
  const storage = new FakeStorage();
  storage.setItem("codex-web:backend-restart-recovery:v1", "backend restarted");
  assert.equal(consumeBackendRestartRecoveryMarker(storage), null);
  assert.equal(consumeBackendRestartRecoveryMarker(storage), null);
  assert.equal(storeBackendRestartRecoveryMarker(null), false);
  assert.equal(consumeBackendRestartRecoveryMarker(null), null);
});

test("unavailable session storage fails closed", () => {
  const storage = {
    getItem() {
      throw new Error("blocked");
    },
    removeItem() {
      throw new Error("blocked");
    },
    setItem() {
      throw new Error("blocked");
    },
  };
  assert.equal(storeBackendRestartRecoveryMarker(storage), false);
  assert.equal(consumeBackendRestartRecoveryMarker(storage), null);
});
