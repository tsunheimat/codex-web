const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} = require("node:fs");
const { tmpdir } = require("node:os");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "..");
const script = path.join(root, "container-init.sh");

function fixture() {
  const directory = mkdtempSync(path.join(tmpdir(), "codex-web-init-"));
  const codexHome = path.join(directory, "codex-home");
  const source = path.join(directory, "source");
  mkdirSync(codexHome);
  mkdirSync(source);
  writeFileSync(path.join(source, "config.toml"), 'model = "gpt-5"\n');
  writeFileSync(path.join(source, "auth.json"), '{"tokens":{"access_token":"fixture"}}\n');
  return { directory, codexHome, source };
}

function runInit({ codexHome, source, ...overrides }) {
  execFileSync("/bin/sh", [script], {
    cwd: root,
    env: {
      ...process.env,
      CODEX_HOME: codexHome,
      CODEX_CONFIG_SOURCE: path.join(source, "config.toml"),
      CODEX_AUTH_SOURCE: path.join(source, "auth.json"),
      CODEX_BOOTSTRAP_FORCE_COPY: "false",
      ...overrides,
    },
    stdio: "pipe",
  });
}

test("does not overwrite existing files by default and copies missing files", () => {
  const state = fixture();
  try {
    writeFileSync(path.join(state.codexHome, "config.toml"), "existing config\n");
    runInit(state);

    assert.equal(readFileSync(path.join(state.codexHome, "config.toml"), "utf8"), "existing config\n");
    assert.equal(
      readFileSync(path.join(state.codexHome, "auth.json"), "utf8"),
      '{"tokens":{"access_token":"fixture"}}\n',
    );
    assert.equal(statSync(path.join(state.codexHome, "config.toml")).mode & 0o777, 0o600);
    assert.equal(statSync(path.join(state.codexHome, "auth.json")).mode & 0o777, 0o600);
  } finally {
    rmSync(state.directory, { recursive: true, force: true });
  }
});

test("overwrites both files atomically when force copy is enabled", () => {
  const state = fixture();
  try {
    writeFileSync(path.join(state.codexHome, "config.toml"), "old config\n");
    writeFileSync(path.join(state.codexHome, "auth.json"), '{"old":true}\n');
    runInit({ ...state, CODEX_BOOTSTRAP_FORCE_COPY: "true" });

    assert.equal(readFileSync(path.join(state.codexHome, "config.toml"), "utf8"), 'model = "gpt-5"\n');
    assert.equal(
      readFileSync(path.join(state.codexHome, "auth.json"), "utf8"),
      '{"tokens":{"access_token":"fixture"}}\n',
    );
    assert.equal(statSync(path.join(state.codexHome, "config.toml")).mode & 0o777, 0o600);
    assert.equal(statSync(path.join(state.codexHome, "auth.json")).mode & 0o777, 0o600);
  } finally {
    rmSync(state.directory, { recursive: true, force: true });
  }
});

test("rejects an invalid force-copy value", () => {
  const state = fixture();
  try {
    assert.throws(
      () => runInit({ ...state, CODEX_BOOTSTRAP_FORCE_COPY: "sometimes" }),
      /CODEX_BOOTSTRAP_FORCE_COPY must be true or false/,
    );
  } finally {
    rmSync(state.directory, { recursive: true, force: true });
  }
});
