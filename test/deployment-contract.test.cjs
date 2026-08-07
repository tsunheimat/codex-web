const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "..");

test("runtime image includes xz support for Codex installation", () => {
  const dockerfile = fs.readFileSync(path.join(root, "Dockerfile"), "utf8");
  const runtimeStage = dockerfile.slice(
    dockerfile.indexOf("FROM ${NODE_IMAGE} AS runtime"),
  );

  assert.match(runtimeStage, /\bxz-utils\b/);
});

test("Kubernetes deployment keeps provider credentials in an optional Secret", () => {
  const deployment = fs.readFileSync(
    path.join(root, "deploy", "k3s", "deployment.yaml"),
    "utf8",
  );

  assert.match(
    deployment,
    /name: CODEX_PROVIDER_API_KEY\n\s+valueFrom:\n\s+secretKeyRef:\n\s+name: codex-web-provider\n\s+key: CODEX_PROVIDER_API_KEY\n\s+optional: true/,
  );
  assert.match(deployment, /CODEX_BOOTSTRAP_FORCE_COPY\n\s+value: "false"/);
  assert.match(deployment, /secretName: codex-web-oauth/);
  assert.equal((deployment.match(/imagePullPolicy: Always/g) ?? []).length, 2);
});
