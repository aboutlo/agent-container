#!/bin/sh
set -e

# If the caller provides a real executable, run it directly instead of
# treating the arguments as a Pi prompt. This allows commands like:
#   container run image pandoc README.md --pdf-engine=typst -o README.pdf
if [ -n "${1:-}" ] && [ "${1:-}" != "pi" ] && [ "${1:-}" != "claude" ] && command -v "$1" >/dev/null 2>&1; then
  exec "$@"
fi

case "${1:-}" in
  claude)
    # Claude Code setup
    # Keep Linux-native auth/state in the persistent config volume, but seed only
    # user-authored config from the host. Avoid copying host work/history/cache files.
    claude_config_dir="${CLAUDE_CONFIG_DIR:-/root/.claude}"
    mkdir -p "$claude_config_dir"

    if [ -d /host-claude ]; then
      for item in \
        settings.json \
        settings.local.json \
        statusline-command.sh \
        CLAUDE.md \
        commands \
        agents \
        skills \
        plugins \
        rules
      do
        if [ -e "/host-claude/$item" ]; then
          rm -rf "$claude_config_dir/$item"
          cp -a "/host-claude/$item" "$claude_config_dir/$item"
        fi
      done
    fi

    shift  # remove 'claude' from args
    exec claude "$@"
    ;;
  pi|*)
    # Pi setup (unchanged from pi-container-entrypoint.sh)
    if [ -d /host-pi ]; then
      rm -rf /root/.pi
      mkdir -p /root/.pi
      # Build the exclude list as a single word-split string (no spaces in the
      # patterns). When the runner passes PIC_EXCLUDE_AUTH=1 (an Anthropic key env was
      # provided), also drop auth.json so the env key wins over any stored credential
      # instead of being shadowed by it. Provider keys never appear here: they are piped
      # into a tmpfs at /run/pi-keys after start (see pic-keys-inject.cjs), so there is
      # nothing to exclude from the ~/.pi copy.
      _pi_excludes="--exclude=./agent/bin --exclude=./agent/sessions --exclude=./agent/npm --exclude=./agent/git --exclude=./agent/skills --exclude=./agent/extensions --exclude=./agent/settings.json.lock --exclude=./agent/auth.json.lock"
      if [ "${PIC_EXCLUDE_AUTH:-0}" = "1" ]; then
        _pi_excludes="$_pi_excludes --exclude=./agent/auth.json"
      fi
      # shellcheck disable=SC2086 # intentional word-splitting into tar args
      tar -C /host-pi $_pi_excludes -cf - . | tar -C /root/.pi -xf -
    fi

    mkdir -p /root/.pi/agent
    # npm and git are bound directly rather than snapshotted (node_modules and checkouts are not
    # worth copying). Fall back to the legacy paths when the whole ~/.pi is mounted instead.
    if [ -d /host-pi-npm ]; then
      ln -s /host-pi-npm /root/.pi/agent/npm
    elif [ -d /host-pi/agent/npm ]; then
      ln -s /host-pi/agent/npm /root/.pi/agent/npm
    fi
    if [ -d /host-pi-git ]; then
      ln -s /host-pi-git /root/.pi/agent/git
    elif [ -d /host-pi/agent/git ]; then
      ln -s /host-pi/agent/git /root/.pi/agent/git
    fi

    # Extensions are staged by pic-runner with host symlinks dereferenced.
    # Never link /root/.pi to host-absolute extension paths.
    mkdir -p /root/.pi/agent/extensions
    if [ -d "$PWD/.pi/host-agent-extensions" ]; then
      for extension in "$PWD"/.pi/host-agent-extensions/*; do
        [ -e "$extension" ] || continue
        target="/root/.pi/agent/extensions/$(basename "$extension")"
        rm -rf "$target"
        cp -aL "$extension" "$target"
      done
    fi
    extension_names=$(find /root/.pi/agent/extensions -maxdepth 2 -type f -print 2>/dev/null | sort | tr '\n' ' ')
    echo "[pi-container] staged extensions: ${extension_names:-none}" >&2

    # Pi skills may live in:
    #   ./skills/<name>                 (versioned project skills, preferred here)
    #   ./.pi/skills/<name>             (Pi project-local convention)
    #   ./.pi/agent/skills/<name>       (legacy compatibility)
    #   ./.pi/host-agent-skills/<name>  (host ~/.pi/agent/skills and ~/.agents/skills
    #                                   staged by pic-runner)
    # Pi loads runtime skills from ~/.pi/agent/skills. Materialize skills there
    # at container startup. Precedence is: ./skills > ./.pi/skills >
    # ./.pi/agent/skills > staged host skills.
    mkdir -p /root/.pi/agent/skills

    # Install skills by copying and dereferencing symlinks instead of linking to
    # the source. Host skills are staged by the host-side runner first, because
    # arbitrary host symlink targets are not visible from inside the container.
    install_skill() {
      src="$1"
      dest="$2"
      tmp="$dest.$$"
      lock="$dest.lock"
      if mkdir "$lock" 2>/dev/null; then
        rm -rf "$tmp"
        if cp -aL "$src" "$tmp" 2>/dev/null; then
          rm -rf "$dest"
          if mv "$tmp" "$dest" 2>/dev/null; then
            rmdir "$lock" 2>/dev/null || true
            return 0
          fi
        fi
        rm -rf "$tmp"
        rmdir "$lock" 2>/dev/null || true
        return 1
      fi
      [ -e "$dest" ] || [ -L "$dest" ]
    }

    if [ -d "$PWD/skills" ]; then
      for skill in "$PWD"/skills/*; do
        [ -e "$skill/SKILL.md" ] || continue
        target="/root/.pi/agent/skills/$(basename "$skill")"
        rm -rf "$target"
        install_skill "$skill" "$target"
      done
    fi

    for skill_dir in "$PWD"/.pi/skills "$PWD"/.pi/agent/skills "$PWD"/.pi/host-agent-skills; do
      [ -d "$skill_dir" ] || continue
      for skill in "$skill_dir"/*; do
        [ -e "$skill/SKILL.md" ] || continue
        target="/root/.pi/agent/skills/$(basename "$skill")"
        # If a stale/dangling entry is present, remove it before materializing
        # this accessible skill directory.
        if [ -e "$target" ]; then
          continue
        fi
        if [ -L "$target" ]; then
          rm -rf "$target"
        fi
        install_skill "$skill" "$target"
      done
    done

    should_pnpm_install=false
    if [ "${PIC_PNPM_INSTALL:-1}" != "0" ] && [ -f package.json ] && command -v pnpm >/dev/null 2>&1; then
      if [ -f pnpm-lock.yaml ]; then
        should_pnpm_install=true
      elif command -v node >/dev/null 2>&1 && node -e "const fs=require('fs'); const pkg=JSON.parse(fs.readFileSync('package.json','utf8')); process.exit(String(pkg.packageManager || '').startsWith('pnpm@') ? 0 : 1)"; then
        should_pnpm_install=true
      fi
    fi

    if [ "$should_pnpm_install" = true ]; then
      echo "[pi-container] pnpm project detected; skipping automatic install"
      echo "[pi-container] run manually if needed: pnpm approve-builds <package> && pnpm install"
    fi

    # If args start with 'pi', shift it off
    if [ "${1:-}" = "pi" ]; then shift; fi

    if [ "${PIC_HERDR_BRIDGE:-0}" = "1" ] && [ -n "${HERDR_SOCKET_PATH:-}" ]; then
      cat > /tmp/pic-herdr-bridge.cjs <<'EOF'
const net = require('node:net');
const fs = require('node:fs');
const socketPath = process.env.HERDR_SOCKET_PATH;
const host = process.env.PIC_HERDR_BRIDGE_HOST || '192.168.64.1';
const port = Number(process.env.PIC_HERDR_BRIDGE_PORT || 0);
try { fs.unlinkSync(socketPath); } catch {}
const server = net.createServer((local) => {
  const remote = net.connect(port, host);
  local.pipe(remote);
  remote.pipe(local);
  const closeBoth = () => { local.destroy(); remote.destroy(); };
  local.on('error', closeBoth);
  remote.on('error', closeBoth);
});
server.on('error', (error) => {
  console.error('[pic-herdr-bridge] ' + (error && error.stack || error));
  process.exit(1);
});
server.listen(socketPath, () => {
  fs.chmodSync(socketPath, 0o600);
  console.error('[pic-herdr-bridge] listening on ' + socketPath + ' -> ' + host + ':' + port);
});
EOF
      node /tmp/pic-herdr-bridge.cjs &
      bridge_pid=$!
      trap 'kill "$bridge_pid" 2>/dev/null || true; rm -f "$HERDR_SOCKET_PATH"' EXIT INT TERM
      sleep 0.2
    fi

    if [ "${HERDR_ENV:-}" = "1" ]; then
      for extension in /root/.pi/agent/extensions/herdr-agent-state.ts; do
        [ -f "$extension" ] || continue
        set -- -e "$extension" "$@"
      done
    fi

    # Provider keys are piped in after start (pic runs pic-keys-inject alongside the
    # container), so wait for the ready marker: pi resolves an apiKey once and caches it for
    # its whole process, so a race would make the provider vanish for the session. The wait
    # is bounded, and the session still starts without the key rather than hanging.
    if [ -n "${PI_KEY_DIR:-}" ] && [ "${PIC_KEYS_WAIT:-0}" != "0" ] && [ ! -e "$PI_KEY_DIR/.ready" ]; then
      echo "[pi-container] waiting for provider keys in $PI_KEY_DIR (up to ${PIC_KEYS_WAIT}s)"
      _key_ticks=$(( PIC_KEYS_WAIT * 5 ))
      _key_try=0
      while [ ! -e "$PI_KEY_DIR/.ready" ] && [ "$_key_try" -lt "$_key_ticks" ]; do
        sleep 0.2
        _key_try=$((_key_try + 1))
      done
      if [ -e "$PI_KEY_DIR/.ready" ]; then
        echo "[pi-container] provider keys ready"
      else
        echo "[pi-container] warning: no keys after ${PIC_KEYS_WAIT}s; starting without them"
      fi
    fi

    # Environment-form secrets (Anthropic credentials, legacy "${NAME}" providers) arrive as
    # files in the key tmpfs, piped in over exec stdin after start, so nothing sensitive is ever
    # declared in the container configuration. Export exactly the requested names from there,
    # right before exec'ing pi: an allowlist rather than "every file", so a stray file cannot
    # override PATH, NODE_OPTIONS, LD_PRELOAD or the launcher's own PIC_* knobs.
    if [ -n "${PIC_ENV_EXPORT:-}" ] && [ -n "${PI_KEY_DIR:-}" ]; then
      _exported=''
      _absent=''
      _saved_ifs=$IFS
      IFS=','
      for _name in $PIC_ENV_EXPORT; do
        case "$_name" in
          ''|*[!A-Za-z0-9_]*|[0-9]*|PIC_*|PI_CONTAINER_*|HERDR_*)
            echo "[pi-container] refusing to export disallowed variable name: ${_name:-<empty>}" >&2
            continue
            ;;
        esac
        if [ -f "$PI_KEY_DIR/$_name" ]; then
          export "$_name=$(cat "$PI_KEY_DIR/$_name")"
          _exported="$_exported $_name"
        else
          _absent="$_absent $_name"
        fi
      done
      IFS=$_saved_ifs
      if [ -n "$_absent" ]; then
        echo "[pi-container] no value for:${_absent}; pi sees those as unset" >&2
      fi
      if [ -n "$_exported" ]; then
        echo "[pi-container] exported from $PI_KEY_DIR:${_exported}"
      fi
    fi

    exec pi "$@"
    ;;
esac
