const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "..");

test("prepare_asar gives Prettier enough heap for the Desktop bundle", () => {
  const script = readFileSync(
    path.join(root, "scripts", "prepare_asar"),
    "utf8",
  );

  assert.match(
    script,
    /PRETTIER_MAX_OLD_SPACE_SIZE="\$\{PRETTIER_MAX_OLD_SPACE_SIZE:-6144\}"/,
  );
  assert.match(script, /must be a positive integer/);
  assert.match(script, /--max-old-space-size=/);
  assert.match(script, /NODE_OPTIONS=.*prettier/);
});
