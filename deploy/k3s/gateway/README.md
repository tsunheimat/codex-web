# Desktop gateway on k3s

Deploy this directory as a separate gateway service. It serves the web/mobile UI
and relays supported operations to the existing Windows Codex Desktop. The Windows
connector opens an outbound WSS connection; the cluster needs no Windows inbound
port, Desktop account credentials or replacement execution runtime.

This deployment uses `Dockerfile.gateway`, port **8215**, namespace
`codex-web-gateway`, and backend ID **windows-desktop**. The existing
`deploy/k3s/deployment.yaml` and default Dockerfile run the original server; they
are independent of this deployment.

## 1. Choose the host, image and storage

Run the following commands from the repository root on a Linux build/admin machine
with kubectl configured for the intended k3s cluster. GitHub Actions builds and
publishes the gateway image; Docker is needed only for an optional manual build.

Edit these files before applying:

| File                  | Set                                                                                                                           |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `kustomization.yaml`  | Keep `ghcr.io/tsunheimat/codex-web-gateway`; set `newTag` to `sha-<full commit SHA>` from a successful gateway image workflow |
| `ingress.yaml`        | Both occurrences of `codex.example.com` to the gateway DNS hostname                                                           |
| `gateway.config.json` | The matching HTTPS URL in `allowedOrigins`; the real Windows project path in `cwd`                                            |
| `storage.yaml`        | Keep `local-path` for standard k3s, or choose a suitable block-storage class                                                  |

Point the hostname's DNS record at the reachable Traefik ingress address. This
example assumes Traefik's `websecure` entrypoint and a TLS certificate trusted by
both Windows and the browser. If your cluster uses another ingress controller,
adapt `ingressClassName` and the controller-specific annotations.

The gateway stores its SQLite database under `/data`. Keep **one replica** and the
**Recreate** deployment strategy; do not attach multiple gateway writers to this
database or place it on NFS. K3s local-path storage binds the workload to the node
holding the volume, so it survives pod recreation but does not provide automatic
failover after loss of that node. Back up the data before removing its PVC.
[K3s storage documentation](https://docs.k3s.io/add-ons/storage).

## 2. Get the gateway image from CI

The [gateway image workflow](../../../.github/workflows/gateway-image.yml) runs
gateway tests, renders these manifests, builds `Dockerfile.gateway`, and smoke-tests
the actual container with a read-only filesystem before publication. Pull requests
build and test without publishing. Pushes to `main` publish:

```text
ghcr.io/tsunheimat/codex-web-gateway:sha-<full commit SHA>
ghcr.io/tsunheimat/codex-web-gateway:latest
```

Version tags also publish the matching semver tag; other Git tags publish the SHA
tag only. The workflow can be run manually on `main`. Existing SHA tags are reused
on reruns. Actions authenticates using its built-in `GITHUB_TOKEN` with package
write permission; no Desktop token or cluster credential is used in the build.

Wait for **gateway image** to finish successfully, then copy its SHA tag from the
job summary to `newTag` in `kustomization.yaml`. The example defaults to `latest`
for initial setup; pin a SHA tag or digest for reproducible deployments. The
workflow publishes `linux/amd64` images. ARM64 nodes need a separate matching
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

Alternatively, use your installed cert-manager issuer to manage this TLS Secret;
add its actual issuer annotation to `ingress.yaml`. No particular issuer or
certificate controller is assumed by these files.

The ingress routes `/` to the gateway, including `/api/v1/desktop` for the Windows
connector and `/api/v1/events` for viewers. Traefik handles WebSocket upgrades
without extra middleware. Avoid attaching a browser-only login redirect to the
Desktop socket route; the connector authenticates using its own first-frame token.
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
kubectl -n codex-web-gateway get pods,svc,ingress,pvc
curl --fail https://codex.example.com/healthz
```

Replace the URL in the last command. The health response is `{"ok":true}`. The
gateway can be healthy while Windows is offline; health probes deliberately check
the service, not whether a Desktop is currently attached.

Open the same HTTPS address in your browser and sign in with
`CODEX_WEB_GATEWAY_TOKEN`. Configure the Windows connector with:

```text
Gateway:    https://your-actual-gateway-hostname
Backend ID: windows-desktop
Token:      the value of CODEX_WEB_DESKTOP_AGENT_TOKEN
```

Run Windows **Check**, then **Run** or **InstallStartup**. Check is temporary and
disconnects when finished. A persistent run should make **Windows Codex Desktop**
appear connected in the web client. Open an existing Desktop-owned task.
See [Windows setup](../../../docs/windows-desktop-connector.md).

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
kubectl -n codex-web-gateway describe pods
kubectl -n codex-web-gateway describe pvc codex-web-gateway-data
```

| Symptom                             | Check                                                                             |
| ----------------------------------- | --------------------------------------------------------------------------------- |
| ImagePullBackOff                    | Registry/tag exists, node architecture matches, image-pull Secret is configured   |
| CreateContainerConfigError          | Both required keys exist in `codex-web-gateway-tokens`                            |
| PVC Pending                         | Storage class/provisioner and eligible node availability                          |
| Database permission error           | Data volume is writable by UID/GID 1000                                           |
| Browser API returns 403             | HTTPS frontend origin matches `allowedOrigins` exactly                            |
| Windows reports certificate failure | Certificate hostname and chain; configure its private CA on Windows if applicable |
| Windows handshake rejected          | Backend ID and agent token match; only one bridge occupies that ID                |
| Gateway healthy, Desktop offline    | Start Desktop and its Windows connector; inspect the connector log                |

This deployment enables the existing gateway connection. Native ChatGPT photo
submission and direct Computer Use controls still require the missing verified
unmodified-Desktop interface; deploying the service does not enable those flags.

Do not use `kubectl delete -k` as an ordinary stop command: this package includes
the namespace and PVC. To stop the gateway while retaining its data, scale the
Deployment to zero; restore it to one to start again.
