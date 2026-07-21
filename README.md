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
at startup, and paths outside it or through symlinks are rejected.

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

These guarantees do not cover the default topology, where codex-web owns and
terminates its app-server child; an app-server process restart; or the ambiguous
window before the external app-server accepts a turn. They also do not provide
raw bridge persistence, authentication, or HTTPS. Run authentication and TLS at
the trusted-network boundary described below.

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
```

The test uses ordinary loopback HTTP, fresh browser profiles, and temporary
runtime directories, and fails if its child processes survive teardown.
`test:browser:restart` additionally requires an installed Codex CLI compatible
with the external WebSocket-over-Unix app-server topology; it keeps one real
app-server alive across two sequential codex-web processes and uses a local
deterministic Responses provider.

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
