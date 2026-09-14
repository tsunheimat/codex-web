# Desktop gateway on k3s

Deploy this directory as two services in one namespace: the gateway, which
relays supported operations to the existing Windows Codex Desktop, and the
original Codex Desktop renderer served by its compatibility server in gateway
mode. The Windows connector opens an outbound WSS connection; the cluster needs
no Windows inbound port, Desktop account credentials or replacement execution
runtime.

The gateway uses `Dockerfile.gateway` (image `codex-web-gateway`), port **8215**,
namespace `codex-web-gateway` and backend ID **windows-desktop**. The renderer
uses the repository's default `Dockerfile` (image `codex-web`) on port **8214**
with `CODEX_WEB_GATEWAY_URL` pointing at the gateway Service. Browsers reach the
renderer at `/` and the gateway under `/api/`.

## 1. Choose the host, image and storage

Run the following commands from the repository root on a Linux build/admin machine
with kubectl configured for the intended k3s cluster. GitHub Actions builds and
publishes the gateway image; Docker is needed only for an optional manual build.

Edit these files before applying:

| File                  | Set                                                                                                                           |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `kustomization.yaml`  | Set both `newTag` values to `sha-<full commit SHA>` from a successful `ci` workflow run on `main`                              |
| `ingress.yaml`        | Set the HTTPRoute hostname and backend namespace for the cluster Gateway; attach your authentication policy to the `/` rule  |
| `web-deployment.yaml` | `CODEX_WEB_ALLOWED_ORIGINS` to the exact HTTPS origin of the hostname                                                        |
| `gateway.config.json` | The real Windows project path in `cwd`; `allowedOrigins` may stay as is because browsers never call the gateway directly      |
| `storage.yaml`        | Keep `local-path` for standard k3s, or choose a suitable block-storage class                                                  |

Point the hostname's DNS record at the reachable Gateway address. This deployment
uses the cluster's `main-tsunhei` Gateway and its wildcard TLS certificate; the
HTTPRoute is cross-namespace and therefore requires an appropriate
`ReferenceGrant` in the Gateway namespace.

The gateway stores its SQLite database under `/data`. Keep **one replica** and the
**Recreate** deployment strategy; do not attach multiple gateway writers to this
database or place it on NFS. K3s local-path storage binds the workload to the node
holding the volume, so it survives pod recreation but does not provide automatic
failover after loss of that node. Back up the data before removing its PVC.
[K3s storage documentation](https://docs.k3s.io/add-ons/storage).

## 2. Get the gateway image from CI

The [ci workflow](../../../.github/workflows/ci.yml) runs the gateway tests,
the manifest contract tests (`test/gateway-deployment.test.cjs`) and renders
these manifests first; only then does it build `Dockerfile.gateway` and
smoke-test the actual container with a read-only filesystem
(`scripts/test_gateway_container.cjs`), and build the renderer image and run it
next to that gateway image as UID 1000 on a read-only root with emptyDir-style
volumes, asserting that `GET /` serves the Desktop UI
(`scripts/test_renderer_container.cjs`). A green gateway `/healthz` alone never
publishes a renderer that cannot serve the page. Pull requests build and test
without publishing. Pushes to `main` publish:

```text
ghcr.io/tsunheimat/codex-web-gateway:sha-<full commit SHA>
ghcr.io/tsunheimat/codex-web-gateway:latest
```

Version tags also publish the matching semver tag; other Git tags publish the SHA
tag only. The workflow can be run manually on `main`. Existing SHA tags are reused
on reruns. Actions authenticates using its built-in `GITHUB_TOKEN` with package
write permission; no Desktop token or cluster credential is used in the build.

The renderer image `ghcr.io/tsunheimat/codex-web:sha-<full commit SHA>` is
published by the same workflow run for the same commit. It contains the prepared upstream renderer bundle and the
compatibility server; in gateway mode it spawns no Codex runtime.

Wait for **ci** to finish successfully, then copy the SHA tag from the job
summary to both `newTag` values in `kustomization.yaml`; the contract test
rejects two different commits. Pin a SHA tag or digest for reproducible
deployments. The workflow publishes `linux/amd64` images. ARM64 nodes need a separate matching
build. If the new GHCR package is private, configure an image-pull Secret as
described below or set its package visibility to public in GitHub.

The workflow delivers the image to GHCR; it does not apply manifests to your k3s
cluster. Complete the remaining steps on your cluster admin machine.

For an optional manual build with a separate tag:

Replace the example image with the same repository/tag entered above:

```bash
GATEWAY_IMAGE=ghcr.io/tsunheimat/codex-web-gateway:manual-v1
docker build -f Dockerfile.gateway -t "$GATEWAY_IMAGE" .
docker push "$GATEWAY_IMAGE"
```

Build for the architecture of the cluster nodes. For example, use an ARM64-capable
build when deploying to ARM64 k3s nodes. For later releases, use a new immutable
tag, or set an image digest in Kustomize rather than reusing a cached tag.

## 3. Create the namespace and private tokens

```bash
kubectl apply -f deploy/k3s/gateway/namespace.yaml
```

Create two independent tokens in a file outside the repository. These commands
refuse to overwrite an existing token file, so rerunning setup does not silently
rotate a working Windows connection:

```bash
mkdir -p "$HOME/.config/codex-web-gateway"
chmod 700 "$HOME/.config/codex-web-gateway"
(
  set -C
  umask 077
  printf 'CODEX_WEB_GATEWAY_TOKEN=%s\nCODEX_WEB_DESKTOP_AGENT_TOKEN=%s\n' \
    "$(openssl rand -hex 32)" "$(openssl rand -hex 32)" \
    > "$HOME/.config/codex-web-gateway/gateway.env"
)

kubectl -n codex-web-gateway create secret generic codex-web-gateway-tokens \
  --from-env-file="$HOME/.config/codex-web-gateway/gateway.env" \
  --dry-run=client -o yaml | kubectl apply -f -
```

`CODEX_WEB_GATEWAY_TOKEN` is for browser/mobile login.
`CODEX_WEB_DESKTOP_AGENT_TOKEN` must match the token entered privately during
Windows connector setup. This deployment deliberately contains no Secret manifest
with real tokens or placeholder values that could overwrite working credentials.

For a private image registry, create an image-pull Secret in this namespace using
your normal registry credential provisioning, then enable `imagePullSecrets` in
`deployment.yaml` with that Secret's name. Do not mount Desktop's `auth.json` or
run the original Codex credential bootstrap init container here.

## 4. Provide HTTPS

If you already have the certificate and private key for your hostname:

```bash
kubectl -n codex-web-gateway create secret tls codex-web-gateway-tls \
  --cert=/secure/path/fullchain.pem \
  --key=/secure/path/privkey.pem \
  --dry-run=client -o yaml | kubectl apply -f -
```

The shared Gateway terminates TLS, so no per-gateway TLS Secret is created here.
If the cluster does not provide that Gateway, install/configure an equivalent
Gateway and update `parentRefs` before applying.

The HTTPRoute sends `/api/` (including `/api/v1/desktop` for the Windows
connector) and `/healthz` to the gateway, and everything else to the renderer's
compatibility server: the page, its `/__backend/` IPC WebSocket and `/@fs/`
image reads. Traefik handles WebSocket upgrades without extra middleware. The
compatibility server has no login and holds the gateway token, so attach the
cluster's authenticating policy (for example a forward-auth filter) to the `/`
rule before exposing the hostname beyond a trusted network. Do not attach a
browser login redirect to the `/api/` rule; the connector authenticates using
its own first-frame token.
An additional upstream proxy must also preserve WebSockets and allow the image
upload request sizes (up to the gateway's 15 MiB HTTP body limit).
[Traefik Ingress TLS](https://doc.traefik.io/traefik/reference/routing-configuration/kubernetes/ingress/),
[Traefik WebSockets](https://doc.traefik.io/traefik/v3.4/user-guides/websocket/).

## 5. Review, deploy and check

```bash
kubectl kustomize deploy/k3s/gateway
kubectl apply --dry-run=server -k deploy/k3s/gateway
kubectl apply -k deploy/k3s/gateway
kubectl -n codex-web-gateway rollout status deployment/codex-web-gateway --timeout=180s
kubectl -n codex-web-gateway rollout status deployment/codex-web-desktop-ui --timeout=180s
kubectl -n codex-web-gateway get pods,svc,httproute,pvc
curl --fail https://codex-test.test.tsunhei.com/healthz
```

The health response is `{"ok":true}`. The
gateway can be healthy while Windows is offline; health probes deliberately check
the service, not whether a Desktop is currently attached.

The renderer Deployment runs the shell as UID 1000 on a read-only root
filesystem with emptyDir volumes at `/home/codex-web`, `/home/codex-web/.codex`,
`/workspace` and `/tmp`. The `.codex` mount is required: the image declares that
path as a `VOLUME`, and without an explicit mount containerd substitutes a
root-owned anonymous directory, after which the shell exits with `EACCES`
creating `.codex/sqlite` and the page answers 503. The shell also exits when the
gateway refuses its app-server WebSocket at startup, so a `wait-for-gateway`
init container polls the gateway Service first. Both containers answer
`/healthz` for their probes; the public `/healthz` is the gateway's.

Verify the page itself, not only the gateway:

```bash
curl --fail -o /dev/null -w '%{http_code} %{content_type}\n' https://codex-test.test.tsunhei.com/
```

Expect `200 text/html; charset=utf-8`. A 404 `Route GET:/ not found` means the
route sends `/` to the gateway; a 503 means the renderer Deployment has no ready
pod (`kubectl -n codex-web-gateway logs deployment/codex-web-desktop-ui`).

Open the same HTTPS address in your browser: the original Codex Desktop UI
loads, signed in as the Desktop's ChatGPT account once the connector is running
(no token prompt; the renderer's server holds the viewer token). Configure the
Windows connector with:

```text
Gateway:    https://your-actual-gateway-hostname
Backend ID: windows-desktop
Token:      the value of CODEX_WEB_DESKTOP_AGENT_TOKEN
```

Run Windows **Check**, then **Run** or **InstallStartup**. Check is temporary and
disconnects when finished. With a persistent run the sidebar lists Desktop's
projects and chats; open an existing Desktop-owned chat, send a prompt and
watch Desktop answer. See [Windows setup](../../../docs/windows-desktop-connector.md).

For a local HTTP health check without ingress, run
`kubectl -n codex-web-gateway port-forward service/codex-web-gateway 8215:8215`,
then request `http://127.0.0.1:8215/healthz` from that same admin machine.

## Updates and troubleshooting

Configuration changes in `gateway.config.json` generate a new ConfigMap name and
trigger a rollout on `kubectl apply -k deploy/k3s/gateway`. For image changes, update
the image tag/digest and apply again. Token Secret changes need an explicit
`kubectl -n codex-web-gateway rollout restart deployment/codex-web-gateway` because
the values are supplied through environment variables; update the Windows token
too if its agent token was rotated.

```bash
kubectl -n codex-web-gateway logs deployment/codex-web-gateway --tail=100
kubectl -n codex-web-gateway logs deployment/codex-web-desktop-ui --all-containers --tail=100
kubectl -n codex-web-gateway describe pods
kubectl -n codex-web-gateway describe pvc codex-web-gateway-data
```

| Symptom                             | Check                                                                             |
| ----------------------------------- | --------------------------------------------------------------------------------- |
| ImagePullBackOff                    | Registry/tag exists, node architecture matches, image-pull Secret is configured   |
| CreateContainerConfigError          | Both required keys exist in `codex-web-gateway-tokens`                            |
| PVC Pending                         | Storage class/provisioner and eligible node availability                          |
| Database permission error           | Data volume is writable by UID/GID 1000                                           |
| Renderer exits `EACCES ... .codex/sqlite` | `codex-home` emptyDir is mounted at `/home/codex-web/.codex` (see above)   |
| Renderer exits `ECONNREFUSED`       | Gateway Service unreachable at shell startup; the init container should wait     |
| Page returns 404 `Route GET:/ not found` | HTTPRoute `/` rule points at the gateway instead of `codex-web-desktop-ui` |
| Page returns 503                    | No ready renderer pod; check its startup/readiness probe and logs                 |
| Browser API returns 403             | HTTPS frontend origin matches `allowedOrigins` exactly                            |
| Windows reports certificate failure | Certificate hostname and chain; configure its private CA on Windows if applicable |
| Windows handshake rejected          | Backend ID and agent token match; only one bridge occupies that ID                |
| Gateway healthy, Desktop offline    | Start Desktop and its Windows connector; inspect the connector log                |
| Page shows "Sign in to ChatGPT"     | The connector was configured with `-PrivateAccount`, or Desktop itself is signed out |
| Sidebar shows no chats              | Connector offline, or the chat is not in Desktop's session index / project list  |
| Page loads but never connects       | `CODEX_WEB_GATEWAY_TOKEN` in the tokens Secret; renderer pod logs name the gateway URL |

This deployment enables the existing gateway connection. Native ChatGPT photo
submission and direct Computer Use controls still require the missing verified
unmodified-Desktop interface; deploying the service does not enable those flags.

Do not use `kubectl delete -k` as an ordinary stop command: this package includes
the namespace and PVC. To stop the gateway while retaining its data, scale the
Deployment to zero; restore it to one to start again.
