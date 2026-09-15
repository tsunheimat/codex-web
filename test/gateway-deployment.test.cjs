// The k3s gateway deployment is two services behind one HTTPRoute: the
// API-only gateway and the original renderer's compatibility server, which
// serves the page. These checks keep the manifests, the images and the CI
// smoke tests describing the same deployment, so a green /healthz can never
// again stand in for a browser that gets 404 at /.
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "..");
const deployRoot = path.join(root, "deploy", "k3s", "gateway");
const read = (...segments) =>
  fs.readFileSync(path.join(root, ...segments), "utf8");

const HOSTNAME = "codex-test.test.tsunhei.com";
const kustomization = read("deploy/k3s/gateway/kustomization.yaml");
const ingress = read("deploy/k3s/gateway/ingress.yaml");
const webDeployment = read("deploy/k3s/gateway/web-deployment.yaml");
const gatewayDeployment = read("deploy/k3s/gateway/deployment.yaml");
const dockerfile = read("Dockerfile");
const workflow = read(".github/workflows/ci.yml");

/** The `volumeMounts:` list of the first container named `name`. */
function mountPaths(manifest, name) {
  const start = manifest.indexOf(`- name: ${name}\n`);
  assert.notEqual(start, -1, `container ${name} missing`);
  const section = manifest.slice(start);
  const mounts = section.slice(section.indexOf("volumeMounts:"));
  const end = mounts.indexOf("\n      volumes:");
  return [...mounts.slice(0, end === -1 ? undefined : end).matchAll(/mountPath: (\S+)/g)].map(
    (m) => m[1],
  );
}

test("kustomization deploys both services with images pinned to one commit", () => {
  for (const resource of ["deployment.yaml", "web-deployment.yaml", "web-service.yaml", "ingress.yaml", "storage.yaml"])
    assert.match(kustomization, new RegExp(`^  - ${resource.replace(".", "\\.")}$`, "m"), resource);
  const pins = [...kustomization.matchAll(/newName: (\S+)\n\s+newTag: (\S+)/g)].map(
    (m) => [m[1], m[2]],
  );
  assert.deepEqual(
    pins.map(([name]) => name),
    ["ghcr.io/tsunheimat/codex-web-gateway", "ghcr.io/tsunheimat/codex-web"],
  );
  for (const [name, tag] of pins)
    assert.match(tag, /^sha-[0-9a-f]{40}$/, `${name} must pin an immutable sha- tag`);
  assert.equal(pins[0][1], pins[1][1], "both images must come from the same CI run");
});

test("HTTPRoute sends the page to the renderer and the API to the gateway", () => {
  assert.match(ingress, new RegExp(`hostnames:\\n\\s+- ${HOSTNAME.replace(/\\./g, "\\.")}\\n`));
  assert.match(ingress, /parentRefs:\n\s+- name: main-tsunhei\n\s+namespace: default/);
  const apiRule = ingress.match(
    /type: PathPrefix\n\s+value: \/api\/\n\s+- path:\n\s+type: Exact\n\s+value: \/healthz\n\s+backendRefs:\n\s+- name: (\S+)\n\s+namespace: codex-web-gateway\n\s+port: (\d+)/,
  );
  assert.ok(apiRule, "/api/ and /healthz rule missing");
  assert.deepEqual([apiRule[1], apiRule[2]], ["codex-web-gateway", "8215"]);
  const pageRule = ingress.match(
    /type: PathPrefix\n\s+value: \/\n\s+backendRefs:\n\s+- name: (\S+)\n\s+namespace: codex-web-gateway\n\s+port: (\d+)/,
  );
  assert.ok(pageRule, "/ rule missing");
  assert.deepEqual([pageRule[1], pageRule[2]], ["codex-web-desktop-ui", "8214"]);
  assert.ok(
    ingress.indexOf("value: /api/") < ingress.indexOf("value: /\n"),
    "API rule listed before the catch-all",
  );
});

test("renderer deployment gives UID 1000 a writable Codex home on a read-only root", () => {
  assert.match(webDeployment, /runAsNonRoot: true\n\s+runAsUser: 1000\n\s+runAsGroup: 1000\n\s+fsGroup: 1000/);
  assert.equal((webDeployment.match(/readOnlyRootFilesystem: true/g) ?? []).length, 3);
  assert.deepEqual(mountPaths(webDeployment, "desktop-ui").sort(), [
    "/home/codex-web",
    "/home/codex-web/.codex",
    "/tmp",
    "/workspace",
  ]);
  // Every VOLUME the image declares is covered by an explicit mount, so the
  // runtime never substitutes a root-owned anonymous directory.
  const volumes = dockerfile.match(/^VOLUME \[(.*)\]$/m);
  assert.ok(volumes, "Dockerfile VOLUME declaration missing");
  const declared = volumes[1].split(",").map((v) => v.trim().replace(/"/g, ""));
  assert.deepEqual(declared.sort(), ["/home/codex-web/.codex", "/workspace"]);
  for (const mountPath of declared)
    assert.ok(mountPaths(webDeployment, "desktop-ui").includes(mountPath), mountPath);
  for (const name of ["home", "codex-home", "workspace", "tmp"])
    assert.match(webDeployment, new RegExp(`- name: ${name}\\n\\s+emptyDir:`), `${name} volume`);
  assert.match(webDeployment, /name: HOME\n\s+value: \/home\/codex-web\n/);
  assert.match(webDeployment, /name: CODEX_HOME\n\s+value: \/home\/codex-web\/\.codex\n/);
});

test("renderer image owns its home for the deployment user", () => {
  const runtimeStage = dockerfile.slice(dockerfile.indexOf("FROM ${NODE_IMAGE} AS runtime"));
  assert.match(runtimeStage, /chown -R node:node \/workspace \/home\/codex-web/);
  assert.match(runtimeStage, /CODEX_HOME=\/home\/codex-web\/\.codex/);
  assert.doesNotMatch(runtimeStage, /^USER /m, "the manifests choose the UID");
});

test("renderer deployment waits for the gateway and probes /healthz over HTTP", () => {
  assert.match(webDeployment, /initContainers:\n(.*\n)*?\s+- name: wait-for-gateway\n/);
  assert.match(webDeployment, /name: gateway-loopback\n\s+image: codex-web:desktop-ui\n\s+imagePullPolicy: Always\n\s+restartPolicy: Always/);
  assert.match(webDeployment, /net\.connect\(8215, "codex-web-gateway"\)/);
  assert.match(webDeployment, /\.listen\(8215, "127\.0\.0\.1"\)/);
  assert.equal((webDeployment.match(/CODEX_WEB_GATEWAY_URL\n\s+value: http:\/\/127\.0\.0\.1:8215/g) ?? []).length, 2);
  assert.equal((webDeployment.match(/image: codex-web:desktop-ui/g) ?? []).length, 3);
  for (const probe of ["startupProbe", "readinessProbe", "livenessProbe"])
    assert.match(
      webDeployment,
      new RegExp(`${probe}:\\n\\s+httpGet:\\n\\s+path: /healthz\\n\\s+port: http`),
      probe,
    );
  assert.match(webDeployment, /CODEX_WEB_RUNTIME_OWNERSHIP\n\s+value: external/);
  assert.match(webDeployment, /CODEX_WEB_GATEWAY_BACKEND\n\s+value: windows-desktop/);
  assert.match(webDeployment, new RegExp(`CODEX_WEB_ALLOWED_ORIGINS\\n\\s+value: https://${HOSTNAME.replace(/\\./g, "\\.")}\\n`));
  assert.match(webDeployment, /secretKeyRef:\n\s+name: codex-web-gateway-tokens\n\s+key: CODEX_WEB_GATEWAY_TOKEN/);
  assert.doesNotMatch(webDeployment, /CODEX_WEB_DESKTOP_AGENT_TOKEN/, "the renderer never holds the connector token");
});

test("gateway deployment keeps one writer on persistent /data", () => {
  assert.match(gatewayDeployment, /replicas: 1\n/);
  assert.match(gatewayDeployment, /type: Recreate/);
  assert.match(gatewayDeployment, /CODEX_WEB_DESKTOP_AGENT_TOKEN\n\s+valueFrom:\n\s+secretKeyRef:\n\s+name: codex-web-gateway-tokens/);
  assert.match(gatewayDeployment, /persistentVolumeClaim:\n\s+claimName: codex-web-gateway-data/);
  assert.match(read("deploy/k3s/gateway/gateway.config.json"), /"statePath": "\/data\/gateway\.sqlite"/);
  const config = JSON.parse(read("deploy/k3s/gateway/gateway.config.json"));
  assert.deepEqual(config.allowedOrigins, [`https://${HOSTNAME}`]);
  assert.equal(config.backends[0].id, "windows-desktop");
  assert.equal(config.backends[0].transport.agentTokenEnv, "CODEX_WEB_DESKTOP_AGENT_TOKEN");
});

test("CI smoke-tests both containers before publishing", () => {
  assert.match(workflow, /node scripts\/test_gateway_container\.cjs codex-web-gateway:ci/);
  assert.match(workflow, /node scripts\/test_renderer_container\.cjs codex-web:ci codex-web-gateway:ci/);
  const rendererJob = workflow.slice(workflow.indexOf("  container-image:"), workflow.indexOf("  gateway-image:"));
  assert.ok(
    rendererJob.indexOf("test_renderer_container.cjs") < rendererJob.indexOf("push: true"),
    "the renderer smoke test runs before the image is published",
  );
  const gatewayJob = workflow.slice(workflow.indexOf("  gateway-image:"));
  assert.ok(
    gatewayJob.indexOf("test_gateway_container.cjs") < gatewayJob.indexOf("push: true"),
    "the gateway smoke test runs before the image is published",
  );
});

test("rendered kustomization contains both deployments and the route", (t) => {
  let rendered;
  try {
    rendered = execFileSync("kubectl", ["kustomize", deployRoot], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    if (error.code === "ENOENT") {
      t.skip("kubectl is not installed here; CI renders the manifests");
      return;
    }
    throw error;
  }
  const kinds = [...rendered.matchAll(/^kind: (\S+)$/gm)].map((m) => m[1]).sort();
  assert.deepEqual(kinds, ["ConfigMap", "Deployment", "Deployment", "HTTPRoute", "Namespace", "PersistentVolumeClaim", "Service", "Service"]);
  const tag = kustomization.match(/newTag: (sha-[0-9a-f]{40})/)[1];
  assert.equal((rendered.match(new RegExp(`image: ghcr.io/tsunheimat/codex-web:${tag}`, "g")) ?? []).length, 3);
  assert.equal((rendered.match(new RegExp(`image: ghcr.io/tsunheimat/codex-web-gateway:${tag}`, "g")) ?? []).length, 1);
  assert.doesNotMatch(rendered, /image: codex-web(-gateway)?:/);
  assert.match(rendered, /name: codex-web-desktop-ui\n\s+namespace: codex-web-gateway\n\s+port: 8214/);
});
