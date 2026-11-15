# agentic-coding-container

Run **Pi** (the Pi coding agent) or **Claude Code** inside an Apple container while editing the current host project directory. The container mounts the current directory as `/workspace/<basename>`, uses your host `~/.pi` and `~/.claude` configurations, and leaves the normal non-containerized commands untouched.

## Commands

| Command | Use when |
|---------|----------|
| `pic` | Containerized Pi with direct networking. |
| `pic --proxy` | Containerized Pi through the host-side proxy. |
| `pic-proxy` | Compatibility alias for `pic --proxy`. |
| `pic-keys` | Status or refresh of the provider key files in `~/.config/pi/keys`. |
| `clc-proxy` | Claude Code with host-side proxy, persistent Linux auth, and host-inspectable sessions. |

## Requirements

- macOS 26.x with Apple container installed.
- Apple container system services started.
- Node.js/npm on the host for the command runners.

Install Apple container from:
https://github.com/apple/container/releases

Start the container system:
```bash
container system start
```

## Build the Image

Build the container image:
```bash
container build --dns 1.1.1.1 -t agentic-coding-node:24 .
```

If Apple `container build` fails with `Temporary failure resolving 'deb.debian.org'`,
the long-running `buildkit` helper may be using the wrong resolver. Repair it with:
```bash
container exec buildkit /bin/sh -lc 'printf "nameserver 1.1.1.1\n" > /etc/resolv.conf'
```
Then rerun the build command.

If a VPN is connected and the build still cannot resolve Debian hosts, the
problem may be broader than DNS: Apple `container`/`buildkit` may be unable to
reach public internet addresses directly. In that case, start a temporary
host-side HTTP/HTTPS proxy on the Apple container bridge and pass it as build
args:
```bash
npm install

node - <<'NODE' &
const ProxyChain = require('proxy-chain');
const server = new ProxyChain.Server({ host: '192.168.64.1', port: 8891 });
server.listen().then(() => console.log('proxy listening on 192.168.64.1:8891'));
process.on('SIGTERM', async () => { await server.close(true); process.exit(0); });
NODE
PID=$!

container build --dns 192.168.64.1 \
  --build-arg HTTP_PROXY=http://192.168.64.1:8891 \
  --build-arg HTTPS_PROXY=http://192.168.64.1:8891 \
  --build-arg http_proxy=http://192.168.64.1:8891 \
  --build-arg https_proxy=http://192.168.64.1:8891 \
  -t agentic-coding-node:24 .

kill $PID
```

This is helpful when DNS changes such as `--dns 1.1.1.1` or a local router DNS
still fail because the VPN blocks direct public egress from the builder VM.

## Install the Commands

Install dependencies and link the command runners:

```bash
npm install
npm link
```

This installs `pic`, `pic-proxy`, and `clc-proxy`. Remove any existing shell
function or alias named `pic`, because shell definitions take precedence over the
linked executable.

`pic` uses direct networking by default. `pic --proxy` enables the host-side
proxy; the older `pic-proxy` command remains an equivalent compatibility alias.

Direct mode explicitly clears uppercase and lowercase HTTP, HTTPS, and ALL proxy
variables, including when it reuses a container originally started in proxy mode.
Containers started by the runner use `--rm`, and a proxy owned by the runner is
closed when the Pi process exits.

Do not bind-mount macOS `~/.claude.json` into the container. Claude Code stores
macOS credentials in Keychain, while Linux stores credentials under
`$CLAUDE_CONFIG_DIR/.credentials.json`. `clc-proxy` lets you run `/login` once
inside Linux and persists that credential in the host-backed Linux config directory
`~/.clc-container/claude-config`. The directory can be shared by concurrent Apple
Container VMs without attaching one writable block volume to multiple VMs.

Personal agent preferences:
- Pi reads your host `~/.pi/agent/SYSTEM.md` through the normal `~/.pi` mount.
- Claude Code reads user memory from `~/.claude/CLAUDE.md` and
  `~/.claude/rules/*.md`; `clc-proxy` copies those into `/claude-config`.
- For project-local Claude-only notes, use repo-root `CLAUDE.local.md` and keep
  it gitignored. Do not use `.claude.local.md`; Claude Code does not load that
  as a standard memory file.


## Provider API Keys

`~/.pi/agent/models.json` resolves its own keys. Each provider's `apiKey` is a command, so
neither the repo, the shell, nor the container configuration ever holds the value:

```json
"apiKey": "!cat \"${PI_KEY_DIR:-$HOME/.config/pi/keys}/omlx-clanker\" 2>/dev/null || op read \"op://Private/OMLX_API_KEY/credential\""
```

| Where | What answers | On disk |
|---|---|---|
| native `pi` | the `op read` fallback: live from 1Password per process | nothing |
| native `pi`, with a key file present | `cat ~/.config/pi/keys/<provider>` (a cache, opt-in) | 0600 file |
| `pic` / `pic-proxy` | `cat /run/pi-keys/<provider>` — a **tmpfs** the launcher fills after start | nothing |

How the container gets the key without it being declared anywhere (`PIC_KEYS_TRANSPORT=tmpfs`,
the default):

1. `pic` names the container (`pic-<workdir suffix>`) and adds `--tmpfs /run/pi-keys`, plus
   `PI_KEY_DIR=/run/pi-keys` and `PIC_KEYS_WAIT=<seconds>`.
2. The entrypoint's `pi` branch waits for `/run/pi-keys/.ready`, bounded by `PIC_KEYS_WAIT`
   (25s by default) — pi resolves an `apiKey` once and caches it for its whole process, so a
   race would silently drop the provider for the session.
3. In parallel, `pic-keys-inject.cjs` resolves each key **on the host** by running the very
   command from models.json (with `PI_KEY_DIR` unset, exactly as native pi would), waits for
   the container to be running, pipes each value through `container exec -i` stdin into the
   tmpfs (mode 0600), then touches `.ready`.

The value therefore exists only in this process' memory and in guest RAM: not in argv (which
lands in logs), not in `config.json`, not in the image, not on the VM's disk image. Stop the
container and it is gone. A provider whose live read fails is reported by name at launch and
simply stays unavailable; the session still starts.

One caveat decides whether you can delete the key files entirely: **a secret manager can only
answer where it can get authorization.** 1Password's desktop integration answers in an
interactive shell and refuses from a non-interactive one (`op read` → `promptError`, seen from
an agent's shell, cron, or a GUI launcher, with the app running and the account registered). So:

* you launch `pic` from your own terminal → no key file needed, nothing stored
* agents or other headless contexts launch `pic` → keep `~/.config/pi/keys/<provider>` as a
  cache, or that provider is unavailable in the container (the read is bounded by
  `PIC_KEY_READ_TIMEOUT`, 12s, so a manager waiting on an approval dialog cannot stall a launch)

Injector messages go to `$TMPDIR/<command>-keys-<container>.log` and are printed after Pi
exits, because writing to the terminal over Pi's TUI corrupts the screen. `PIC_KEYS_VERBOSE=1`
prints them live instead, for debugging.

```bash
pic-keys                    # status; in the default transport nothing is stored, by design
pic-keys --verify           # read live, compare hashes: proves the URI and the authorization
pic-keys omlx-clanker       # write ~/.config/pi/keys/<provider> (opt-in cache / bind transport)
pic-keys omlx-clanker "op://Vault/Item/Field"   # first time, or after a rotation
pic-keys --all
```

Environment secrets use the same pipe. `pic --anthropic` (and the legacy `"${NAME}"`
providers) used to cross as `-e ANTHROPIC_API_KEY=<value>`, which is recorded verbatim in the
container's `config.json` and shown by `container inspect`. Now only the *names* are declared
(`-e PIC_ENV_EXPORT=ANTHROPIC_API_KEY,...`), the injector writes each value into the key tmpfs,
and the entrypoint exports them inside the VM just before exec'ing pi:

```
[pi-container] exported from /run/pi-keys: ANTHROPIC_API_KEY
```

Only names that models.json references, plus the Anthropic trio when `--anthropic` was asked
for, are resolvable (`host-secrets.cjs`), and `PATH`, `NODE_OPTIONS`, `LD_PRELOAD`, `DYLD_*`,
`PIC_*` and `HERDR_*` can never be exported, so a stray file in the tmpfs cannot hijack the
process. Measured with canaries: the value reaches pi's own environment, and no canary appears
in any recorded configuration on the host. If the transport cannot inject
(`PIC_KEYS_TRANSPORT=bind|off`) the old `-e` behaviour is used and says so.

Files, when you choose to have them, are written 0600 in a 0700 directory through a temp file
and a rename. The value is never printed, never a command-line argument, never exported. For an
API-credential item the 1Password field is `credential`, singular. Pi caches a resolved key for
the lifetime of its process, so test with a fresh process, and note that `pi --list-models`
never validates a key.

Why not `-e NAME=<key>` (measured on Apple container 1.7.1):

* `-e` values appear verbatim in `container inspect` and `container list --format json`, and are
  written to `~/Library/Application Support/com.apple.container/containers/<id>/config.json`
  with mode **0644** for the life of the container. `--env-file` changes nothing, and
  `pi --api-key` is recorded in `initProcess.arguments` too.
* `vminitd` logs the environment of the workload and of every `container exec` at debug level
  (apple/containerization#518; the `op run … container exec --env` pattern is apple/container
  discussion #1153).
* Inside the container the environment is readable by every process Pi spawns, including the
  agent's own shell tool.

A read-only bind mount of a host key directory (`PIC_KEYS_TRANSPORT=bind`) records only the
directory path, which is why `~/.config/pi/keys` sits outside `~/.pi`: `~/.pi` is mounted whole
at `/host-pi`, so keys inside it would be reachable at a second path. Use it when the host shell
cannot reach 1Password. Containers created before the tmpfs default still carry the old
read-only mount; `pic` says so and prints the `container stop <id>` to run.

Re-run the whole proof (pty launch, tmpfs check, hash comparison, host-side leak scan):

```bash
./key-injection-check.sh            # uses a throwaway workdir under /tmp
```

Knobs: `PIC_KEYS_TRANSPORT` (`tmpfs` | `bind` | `off`), `PIC_KEYS_WAIT` (gate seconds, `0`
disables), `PIC_KEY_READ_TIMEOUT` (seconds for one live read), `PIC_HOST_PI_SNAPSHOT`,
`PIC_HOST_PI_SNAPSHOT_DIR`, `PIC_HOST_PI_EXTRA_EXCLUDES`, `PIC_KEYS_HOST_DIR`,
`PIC_PROVIDER_KEYS_DIR`, `PIC_KEYS_VERBOSE=1`, and `OP_BIN` (`pic-keys` only; `models.json`
names the binary itself).

The legacy form is still supported: if `models.json` interpolates `${NAME}` names, they are
resolved from the host environment, then from `~/.config/pi/providers.env`, and forwarded with
`-e` — with the exposure above, which the runner logs as a note. Nothing in the dotfiles uses it
any more. Rules and tests live in `provider-env.cjs`; the file form in `provider-keys.cjs`,
`pic-keys.cjs` and `pic-keys-inject.cjs`.

### When does the secret manager get asked

* With a key file present: never, for this provider — the `cat` short-circuits the `||` and the
  secret manager is never invoked. That is why no 1Password dialog appeared on your first run.
* Without one: once per process that resolves the credential — once per `pic`/`pic-proxy`
  invocation (the injector re-reads on the reuse path too, which is how a rotation lands) and
  once per native `pi` process. Not per model request, and not per token.
* `1Password has to be able to answer`: it refuses where it cannot get authorization
  (`op read` → `promptError` from a non-interactive shell, cron, a GUI launcher), which is the
  one reason to keep a key file on a machine where agents launch containers.
* `pic-keys --verify` is the explicit, value-free check that a URI and its authorization work.

### How long does a container, and the key inside it, live?

`pic` runs `container run --rm`: the container exists while its main process (Pi, or the shell
from `pic attach`) is alive, and is **deleted** as soon as that exits or you `container stop`
it — `container ls -a` shows nothing and `container inspect` reports it gone. The keys live in a
tmpfs inside the VM, so they disappear with it; nothing to scrub, nothing to shred. The only
thing that outlives a container is the named `<workdir>-<hash>-node-modules` volume, which is
deliberate: `container volume delete <name>` removes it. The entrypoint's gate and the reuse path
mean a second `pic` in the same directory execs into the running container and refreshes the keys
rather than starting a new one.

## What a container can see of the host

`~/.pi` is **not** mounted into containers. It holds `agent/sessions` (every transcript pi has
recorded - the largest credential sink pi produces) and `agent/auth.json` (stored provider
credentials), and a read-only mount is still readable by every process in the container: measured
from inside as 25 transcripts and an `auth.json`.

Instead `pic` refreshes a filtered snapshot before each launch
(`~/.cache/pi-container/host-pi`, mode 0700, via `rsync -a --delete`, with a `tar` fallback) and
mounts that read-only at `/host-pi`:

| excluded from the snapshot | why |
|---|---|
| `agent/sessions` | transcripts: contains anything ever printed in a session |
| `agent/auth.json` | stored credentials; use `pic --anthropic` or a model key |
| `agent/npm`, `agent/git` | bound read-only at `/host-pi-npm` and `/host-pi-git` instead (node_modules and checkouts are not worth copying) |
| `agent/skills`, `agent/extensions`, `agent/bin`, `*.lock` | staged into the workspace, dereferenced |

Extras: `PIC_HOST_PI_EXTRA_EXCLUDES=agent/prompts,...`. `PIC_HOST_PI_SNAPSHOT=0` restores the old
whole-`~/.pi` mount and logs that it does so; if the snapshot cannot be built the launch is
refused rather than silently falling back to the whole tree. Measured from inside after the
change: 0 transcripts, no `auth.json`, and pi still lists all its models.

## Provider reachability: tunnels need the host proxy

A model server whose address is reachable only through a host-only tunnel (WireGuard,
Tailscale, any `utun`) **cannot be reached from a container**, and `pic` says so before Pi
starts instead of letting you sit through a connect timeout:

```
warning: 172.31.221.1 is reachable only through utun1 on this host, so a container cannot
         connect to it (the peer sees the VM's address and drops it). Providers affected: omlx-clanker.
         run it through the host-side proxy instead: pic --proxy   (or simply pic-proxy)
```

Measured on this machine with `http://172.31.221.1:8080`:

| Path | Result |
|---|---|
| host `curl` | `200` |
| container, direct | connect timeout |
| container through the host proxy (`pic-proxy`) | `401`/`200` (reached the server) |
| container, general internet | `200` |

`net.inet.ip.forwarding=1` does not help: the host forwards the VM's packets into the tunnel
with the VM's source address and does not SNAT them, so the peer drops the reply. Only sockets
owned by the host get the tunnel address - which is exactly what `pic-proxy`'s proxy-chain
instance provides: it dials from the host, so tunnel, VPN and LAN-only hosts all work. Use it
for any provider living behind a tunnel; the detection is host-side (`route -n get`), needs one
second at most, and stays quiet when the proxy is already enabled. Rules and tests live in
`provider-reachability.cjs`.

When the proxy is off, empty proxy variables are exported only for names the caller actually
set, so a container that starts without a proxy does not carry six blank `-e` entries that a
later `pic-proxy` exec has to override.

## Run

From any project directory:
```bash
pic              # Pi with direct networking
pic --proxy      # Pi through the host-side proxy
pic-proxy        # compatibility alias for `pic --proxy`
pic-proxy attach # shell in the matching project container, or start one
clc-proxy        # Claude Code through the host-side proxy
```

### Package resources

The runners stage the resources of enabled Pi packages into the container. A package declares
them in `package.json` under `pi.extensions` and `pi.skills`.

Sources installed under `~/.pi/agent` (`npm:` and git) already reach the container through the
read-only `~/.pi` mount, so the runners copy only packages that live outside that directory.
Staged names are qualified as `<package>--<resource>`, because two packages can expose the same
file name. Tests and `node_modules` are never staged.

Skills also come from the two host skill directories the container cannot see: `~/.pi/agent/skills`
then `~/.agents/skills`. On a name clash the earlier source wins, in the order: project directory,
`~/.pi/agent/skills`, `~/.agents/skills`, packages.

### Herdr integration

When `pic` or `pic-proxy` is launched inside a Herdr pane, the runner auto-enables Pi status reporting through a host/container socket bridge. No Herdr socket is bind-mounted into the Apple container.

```bash
pic-proxy
# or
herdr agent start "$(basename "$PWD")" --cwd "$PWD" -- pic-proxy
```

The Herdr agent is renamed to the current directory basename by default. Override or disable that with:

```bash
PIC_HERDR_NAME=my-agent pic-proxy
PIC_HERDR_RENAME=0 pic-proxy
PIC_HERDR_BRIDGE=0 pic-proxy   # disable Herdr status bridge
```

Run `herdr integration install pi` on the host once. The entrypoint loads `herdr-agent-state.ts` only when `HERDR_ENV=1`.

You can publish container ports to the host by passing `-p` or `--publish` arguments:
```bash
clc-proxy -p 5173:5173 -p 3000:3000
```

### Session Isolation

Pi stores UUID-named sessions under `./.pi/agent/sessions/`; concurrent Pi
processes can safely share that directory. Claude Code stores project history
under its normal `projects/` layout, but `clc-proxy` bind-mounts that directory outside the container at:

```text
~/.clc-container/claude-projects/<project>/
```

For convenience, `clc-proxy` also creates this ignored project-local symlink:

```text
./.claude/projects -> ~/.clc-container/claude-projects/<project>/
```


### Mounting multiple directories with `--volume`

You can pass `--volume` arguments to mount additional host directories:
```bash
clc-proxy --volume "../web:/workspace/web"
```

### Config Handling

- **Pi**: host `~/.pi` is mounted at `/host-pi` (read-only). The entrypoint copies
  safe config files into `/root/.pi`, excludes lock/session files, and symlinks
  large directories.

### Ignoring local auth with an Anthropic key

Pi resolves stored credentials (from `auth.json`) before env keys, so a copied
`auth.json` would shadow `ANTHROPIC_API_KEY`. The container and host both
support an opt-in `--anthropic` (`-a`) mode that ignores local auth:

- **In the container**: `pic --anthropic "prompt"` (or `pic -a`) forwards
  `ANTHROPIC_API_KEY`/`ANTHROPIC_AUTH_TOKEN`/`ANTHROPIC_OAUTH_TOKEN` from the
  host env into the container and passes `PIC_EXCLUDE_AUTH=1`; `entrypoint.sh`
  then skips copying `~/.pi/agent/auth.json`, so the key wins. Without the flag,
  `pic`/`pic-proxy` run exactly as before and keep using local auth.

- **Source a key without storing it**: when `--anthropic` is passed but no
  `ANTHROPIC_*` key is in the environment, the runner runs the command given by
  the generic `PI_ANTHROPIC_KEY_CMD` env var and uses its stdout as the key
  (e.g. a 1Password lookup). The repo contains only this indirection, never the
  secret or the command itself. Example (in `~/.zshrc`, outside the repo):

  ```bash
  export PI_ANTHROPIC_KEY_CMD='op read --account NFKJESXBABCS5FBEBGKA4ZZ3LQ "op://Employee/Anthropic pi dev key/password"'
  ```

- **On the host** (outside the container), the `pik` shell function (see
  `~/.zshrc`) points `PI_CODING_AGENT_DIR` at `~/.pi-anthropic/agent`, where
  `auth.json` is an empty stub and everything else is symlinked back to
  `~/.pi/agent`. It sources the same `PI_ANTHROPIC_KEY_CMD` (or a set
  `ANTHROPIC_API_KEY`), so `pik "prompt"` also ignores local `auth.json`;
  normal `pi` keeps using it.
- **Claude Code proxy**: host `~/.claude` is mounted read-only at `/host-claude`.
  The entrypoint copies only user-authored config into the persistent, host-backed
  Linux config directory at `~/.clc-container/claude-config`, mounted as
  `/claude-config`: `CLAUDE.md`, `rules`, `settings*.json`, `statusline-command.sh`,
  `commands`, `agents`, `skills`, and `plugins`. It intentionally does not copy
  credentials, history, cache, debug logs, jobs, paste cache, or old projects.
  Run `/login` once in the container; Claude Code persists Linux auth at
  `/claude-config/.credentials.json`. Claude Code project/session history is
  bind-mounted outside the container at `~/.clc-container/claude-projects/<project>`
  via `/claude-config/projects`.


## Test / Debug

Start a shell instead of Pi or Claude Code:
```bash
container volume create "pic-node-modules-$(pwd | shasum | cut -c1-12)" >/dev/null 2>&1 || true
container run -it --memory 4g \
  --volume "$PWD:/workspace/$(basename $PWD)" \
  --mount type=volume,source="pic-node-modules-$(pwd | shasum | cut -c1-12)",target="/workspace/$(basename $PWD)/node_modules" \
  --dns 1.1.1.1 \
  --entrypoint /bin/bash \
  -w "/workspace/$(basename $PWD)" \
  agentic-coding-node:24
```

Smoke test inside the container:
```bash
node --version
npm --version
pnpm --version
fd --version
rg --version
pi --help
claude --version
```

## Public Repo Hygiene

Safe to commit:
- source files, Dockerfile, entrypoint, README, lockfiles
- `Mullvad.md` after keeping it generic and free of account IDs, keys, or personal relay details

Do not commit:
- `.claude/`, `.claude-host-config/`, `.pi/agent/sessions/`, `sessions/`
- `node_modules/`, `.pnpm-store/`
- `CLAUDE.local.md`
- local notes such as `perf-review.md` or `*.local.md`
- Claude tokens, API keys, WireGuard private keys, Mullvad account numbers, or copied auth files

Claude Code sessions are inspectable through the ignored symlink
`./.claude/projects`, but the real data lives under `~/.clc-container/`.

## Image Contents

The custom `node:24-trixie-slim` image includes:
- `@earendil-works/pi-coding-agent`
- `pnpm`
- `fd`
- `ripgrep`
- **Claude Code** installed via the Anthropic native installer (`~/.local/bin/claude`)

## Upgrade

To upgrade Pi to the latest published npm version, rebuild without cache:
```bash
container build --no-cache --dns 1.1.1.1 -t agentic-coding-node:24 .
```

To upgrade Claude Code, rebuild or update within a running container:
```bash
claude update
```
