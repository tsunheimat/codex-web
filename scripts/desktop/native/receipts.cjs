const fs = require("node:fs");
const path = require("node:path");
const { randomUUID, createHash } = require("node:crypto");
const { checkedId, nativeError } = require("./contract.cjs");
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((k) => [k, canonical(value[k])]),
    );
  return value;
}
function fingerprint(value) {
  return createHash("sha256")
    .update(JSON.stringify(canonical(value)))
    .digest("hex");
}
/** Durable Desktop-side receipts. No account credentials or upload URLs stored. */
class NativeReceipts {
  constructor(directory) {
    this.directory = directory;
    this.records = new Map();
    this.running = new Map();
    if (directory) {
      fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
      for (const name of fs
        .readdirSync(directory)
        .filter((n) => /^[\w-]+\.json$/.test(n))) {
        const row = JSON.parse(
          fs.readFileSync(path.join(directory, name), "utf8"),
        );
        checkedId(row.id);
        if (row.state === "dispatching") {
          row.state = "unknown";
          row.error =
            "Desktop restarted before native acknowledgement; reconcile this operation";
        }
        this.put(row);
      }
    }
  }
  put(row) {
    checkedId(row.id);
    if (this.directory) {
      const dest = path.join(this.directory, row.id + ".json"),
        tmp = dest + "." + randomUUID() + ".tmp";
      const fd = fs.openSync(tmp, "wx", 0o600);
      try {
        fs.writeFileSync(fd, JSON.stringify(row));
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      fs.renameSync(tmp, dest);
    }
    this.records.set(row.id, row);
    return row;
  }
  get(id) {
    return this.records.get(checkedId(id));
  }
  async run(method, params, work) {
    const id = checkedId(params.commandId),
      digest = fingerprint({ method, params });
    const prior = this.get(id);
    if (prior) {
      if (prior.fingerprint !== digest)
        throw nativeError("Native command ID was reused for different input");
      if (this.running.has(id)) return this.running.get(id);
      if (prior.state === "complete") return prior.result;
      throw nativeError(
        prior.error ??
          "Native operation outcome is unknown; reconcile before another command",
        prior.state !== "failed",
      );
    }
    this.put({
      id,
      method,
      fingerprint: digest,
      state: "dispatching",
      conversationId: params.conversationId,
      stageId: params.stageId,
    });
    const task = (async () => {
      try {
        const result = await work((partial) =>
          this.put({ ...this.get(id), ...partial }),
        );
        this.put({ ...this.get(id), state: "complete", result });
        return result;
      } catch (error) {
        this.put({
          ...this.get(id),
          state: error.deliveryUnknown === false ? "failed" : "unknown",
          error: error.message,
        });
        throw nativeError(error.message, error.deliveryUnknown !== false);
      } finally {
        this.running.delete(id);
      }
    })();
    this.running.set(id, task);
    return task;
  }
}
module.exports = { NativeReceipts, fingerprint };
