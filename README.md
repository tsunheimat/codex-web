# codex-web

a browser frontend for codex desktop, running on a machine you control.

https://github.com/user-attachments/assets/0a33cbd8-741c-412c-9e75-46dfe9324596

## motivation

the agents were never meant to stay trapped in a terminal window for long.
codex desktop brought the power of agents to your local computer, where your
files, credentials, and tools already live.

codex-web brings codex desktop to the browser while keeping the backend on a
machine you control (a linux box in the cloud, your home lab, or a desktop / mac
mini). agents keep running after your laptop closes. you can reconnect from any
device with a browser.

this project aims to be as thin a wrapper as possible to ensure upstream changes
to the codex desktop app can be integrated quickly.

## usage

`codex-web` serves the browser client and hosts the desktop-side bridge. by
default, it listens on `127.0.0.1:8214`.

it will use `codex` from `PATH` if available, or `CODEX_CLI_PATH` if you set
it.

run it with `npx`:

```bash
npx --yes github:0xcaff/codex-web
```

or with nix:

```bash
nix run github:0xcaff/codex-web
```

then open <http://127.0.0.1:8214> in a browser.

### docker compose

The repository includes a production Compose file that pulls
`ghcr.io/tsunheimat/codex-web:latest`, publishes the UI on loopback, persists
Codex state in a named volume, and bind-mounts `./workspace` at `/workspace`.
GHCR pulls normally do not need credentials, but run `docker login ghcr.io`
first if your environment requires authenticated access.

```bash
mkdir -p workspace
docker compose up -d
```

Then open <http://127.0.0.1:8214>. Set `CODEX_WEB_IMAGE` to an immutable
`sha-...` tag or `@sha256:...` digest before `docker compose up -d` when you
need a pinned deploy. Set `CODEX_WEB_PORT` or `CODEX_WEB_WORKSPACE_DIR` in a
local `.env` as needed. Use `CODEX_WEB_BIND_ADDRESS=0.0.0.0` only behind a
trusted reverse proxy; anyone who can reach codex-web can operate Codex as the
container user.

The image uses its default container user, so operators are responsible for
making bind-mounted volumes writable for the user the container runs as. Codex
credentials and config are stored in the `codex-web-codex-home` volume, and no
credentials are embedded in Compose or `.env.example`. Sign in once from the
container if needed:

```bash
docker compose run --rm codex-web codex login --device-auth
```

### workspace file boundary

The project picker, workspace file previews/downloads, and workspace-related
runtime roots are restricted to `CODEX_WEBUI_BROWSE_ROOT`. It defaults to the
server user's home directory. Set it to the directory that should be available
to Browser users before starting the server; container deployments can use
`/workspace` without changing source code:

```bash
CODEX_WEBUI_BROWSE_ROOT=/workspace codex-web
```

The configured path must already exist and be a directory. It is canonicalized
at startup, pinned for the server lifetime on Linux, and paths outside it or
through symlinks are rejected. Picker listings and Web-owned file responses are
consumed through authorized open descriptors, so replacing a pathname after it
has been opened does not redirect the operation.

Uploaded attachments are kept in a disposable per-process directory. Their
aggregate retained and in-flight storage defaults to exactly 512 MiB. Set a
different process-wide byte budget with a positive decimal safe integer:

```bash
CODEX_WEBUI_UPLOAD_QUOTA_BYTES=1073741824 codex-web
```

Invalid, zero, negative, fractional, or unsafe values fail startup before the
server listens. This quota is separate from the 25 MiB per-file multipart
limit.

The disposable upload root is private to the server process and created with
mode `0700`. Discard reopens the registered random name without following
symlinks, verifies its recorded device, inode, and size through the pinned root,
and releases retained quota only after the opened inode proves that its link was
removed. Node does not expose an identity-checked `unlinkat`, so the final unlink
assumes that another same-UID process does not mutate this private root between
verification and removal; the implementation does not claim otherwise.

### sign in

ensure the codex cli on the host machine is signed in before starting the
server.

```bash
codex login --device-auth
```

### proxying to app-server (advanced usage)

it’s often useful to run the app server separately, so a crash or restart of
codex-web doesn’t interrupt the codex process executing commands.

it's possible to hook codex-web up to an already-running app server using the
`codex_remote_proxy` script.

start a long-lived app server somewhere:

```bash
mkdir -p /tmp/codex-app-server
cd /tmp/codex-app-server
codex app-server --listen unix://codex-app-server.sock
```

then run `codex-web` with the proxy helper:

```bash
nix shell github:0xcaff/codex-web github:0xcaff/codex-web#codex_remote_proxy -c bash -lc '
  export CODEX_UNIX_SOCKET=/tmp/codex-app-server/codex-app-server.sock
  export CODEX_CLI_PATH="$(command -v codex_remote_proxy)"
  codex-web
'
```

The `--listen unix://...` endpoint is text WebSocket-over-Unix. The production
`codex_remote_proxy` helper adapts that endpoint to the newline-delimited stdio
transport expected by codex-web. The installed
`codex app-server proxy --sock ...` command targets Codex's separate control
socket topology and is not interchangeable with this helper.

With this external topology, restarting only codex-web preserves accepted work
in the long-lived app-server. A stale Browser tab reloads in place, keeps its
canonical `/thread/:id` route, consumes a same-tab/session restart marker once,
and asks the official renderer to hydrate authoritative app-server history. No
retired bridge frames are stored or replayed, and codex-web does not resubmit
the accepted turn.

If a renderer reconnects after codex-web observed `turn/started` but missed
`turn/completed`, codex-web reconciles the captured turn IDs with an
authoritative `thread/read` request using `includeTurns: true`. It keeps turns
reported as `inProgress` and turns that started after the wait began. Transient
read or validation failures retry at a bounded cadence; after 15 seconds the
renderer receives at most one fail-open history hydration so it cannot wait
forever. That fallback reads history only and never starts or restarts a turn.

These server-only restart guarantees do not make an in-flight turn survive the
default topology, where codex-web owns and terminates its app-server child. They
also do not cover an app-server crash or the ambiguous window before an external
app-server accepts a turn.

### controlled whole-instance restart

The default owned-child topology supports an operator-controlled whole-instance
restart only while idle. Persist `CODEX_HOME` and every required workspace path,
wait until every accepted turn is terminal, gracefully stop codex-web and its
owned app-server, and do not start the replacement until the old process tree
has exited and the web listener is unavailable. The replacement creates a fresh
app-server and runtime directory against the persisted state. An already-open
Browser tab then consumes the same exact one-shot backend-restart marker and
uses official thread history hydration to recover its canonical thread route;
codex-web does not replay a bridge frame, renderer invoke, provider request or
`turn/start`.

On Kubernetes, use one non-overlapping owner for the persisted state: a
single-replica Deployment with `strategy.type: Recreate`, or an equivalently
ordered single-replica StatefulSet replacement. Do not use overlapping
`RollingUpdate` Pods with the same `CODEX_HOME` or workspace volume. This is an
operational lifecycle boundary, not a live deployment manifest.

This controlled lifecycle does not promise active-turn migration, forced-crash
continuation, pre-accept exactly-once behavior, zero downtime, or raw bridge
persistence. Authentication and HTTPS remain the responsibility of the trusted
reverse-proxy boundary described below.

## security

run `codex-web` only on trusted networks. treat anyone who can reach the
`codex-web` server as someone who can operate codex on the host machine as the
same user running the server.

if you need authn or authz, implement it outside of `codex-web`: proxy it through
wireguard, tailscale, or an ssh tunnel and put an authentication gateway or
reverse proxy in front.

someone with access to the web ui may be able to:

- run commands on the host, limited only by the permissions of the `codex-web`
  server process.
- read or modify files, environment variables, credentials, ssh keys, and other
  local resources that are accessible to that process.
- use the codex / chatgpt account already signed in on the host. this may
  consume usage quota or billing credits, and may expose account metadata shown
  by the app or cli, such as name or email address.

## features

- hostable on macOS, Linux (and anything codex cli + node will run on)
- reachable from the browser
- thin wrapper, so updates should land fast
- working today:
  - subagents
  - inline images
  - editor sidepanel
  - transcription

## roadmap

some parts of the desktop experience are not wired up yet:

- browser panel support, likely rebuilt around iframes
- computer use on linux, which could become a very powerful feature
- terminal support
- git worker integration
- whatever else people find and file issues for

## browser lifecycle test

The browser lifecycle regression test drives the patched official Desktop
renderer in Chromium through a same-page WebSocket reconnect, a hard refresh,
and a full browser close/reopen. It starts an isolated Codex runtime and a local
deterministic Responses provider; it does not use the host's Codex home,
credentials, configuration, workspace, or a real model provider.

Install the disposable Playwright Chromium build once, then run the test on a
Linux host with `xvfb-run` available:

```bash
npm run test:browser:install
npm run test:browser
npm run test:browser:restart
npm run test:browser:pod-restart
```

The test uses ordinary loopback HTTP, fresh browser profiles, and temporary
runtime directories, and fails if its child processes survive teardown.
`test:browser:restart` additionally requires an installed Codex CLI compatible
with the external WebSocket-over-Unix app-server topology; it keeps one real
app-server alive across two sequential codex-web processes and uses a local
deterministic Responses provider.

`test:browser:pod-restart` requires exactly Codex CLI 0.144.6. It completes and
authoritatively verifies a turn in server A's default owned app-server, proves
the old server, app-server, listener and isolated runtime are gone, then starts
server B with a distinct app-server and runtime against the same persisted
`CODEX_HOME` and workspace. The same real Chromium page recovers the unique
result from official history with one provider request and one accepted
`turn/start`; teardown rejects process, listener, profile or temporary-root
residue.

## issues welcome

if something is broken, missing, or rough around the edges, please file an
issue.

using `codex-web` in an interesting way? post about it on x and tag me
[@0xcaff](https://x.com/0xcaff).

using this at a company and need something more tailored? email me and we can
talk.

## alternatives

- [davej/pocodex](https://github.com/davej/pocodex) i used this until the wheels fell off. i needed subagents
  and an inline image viewer. this didn't have them and was having a hard time
  keeping up with upstream codex updates.
- the native codex remote feature (behind a feature flag) is great for
  connecting to remote codex hosts over ssh to manage long running tasks but
  this only works if you have codex desktop on your client device. this means it
  doesn't work on mobile.
- upcoming first party mobile app from openai. `codex-web` exists and works
  today. i can't wait for the mobile app but judging by the other openai mobile
  apps, i'm a little bit skeptical about the quality of the mobile experience.
  time will tell.
