#!/usr/bin/env bash
# Idempotent setup and doctor for the pi container toolchain.
#
#   ./install.sh            apply every step
#   ./install.sh --check    report only, change nothing (exit 1 if drift found)
#   ./install.sh --no-cache rebuild the image without cache (upgrades pi in the image)
#   ./install.sh --reap     stop and delete containers older than the rebuilt image
#
# Steps: prereqs, npm deps + link, host pi self-update, models.json staging from
# ~/dotfiles/pi/models.json (machine overrides from ~/.config/pi/models.local.json),
# container image rebuild, stale-container scan, tests.
#
# The models.json apiKey contract for shell-command keys is:
#   !cat "${PI_KEY_DIR:-$HOME/.config/pi/keys}/<provider>" 2>/dev/null || op read "op://Vault/Item/Field"
# which is what provider-keys.cjs and the container injector expect.

set -u
cd "$(dirname "$0")"

IMAGE=agentic-coding-node:24
MODELS_SRC="${DOTFILES:-$HOME/dotfiles}/pi/models.json"
MODELS_LOCAL="$HOME/.config/pi/models.local.json"
MODELS_DST="$HOME/.pi/agent/models.json"

tmpdir=$(mktemp -d /tmp/pi-container-install-XXXXXX)
node_stage="$tmpdir/stage-models.cjs"
node_list="$tmpdir/list-containers.cjs"
staged_file="$tmpdir/models.json"
stale_file="$tmpdir/stale.txt"
trap 'rm -rf "$tmpdir"' EXIT

check_only=0; reap=0; no_cache=""
for arg in "$@"; do
  case "$arg" in
    --check) check_only=1 ;;
    --reap) reap=1 ;;
    --no-cache) no_cache="--no-cache" ;;
    -h|--help) sed -n '2,16p' "$0"; exit 0 ;;
    *) echo "install.sh: unknown argument: $arg" >&2; exit 2 ;;
  esac
done

drift=0
step() { printf '\n== %s\n' "$1"; }
ok()   { printf '   ok:    %s\n' "$1"; }
warn() { printf '   warn:  %s\n' "$1"; }
fail() { printf '   FAIL:  %s\n' "$1"; drift=1; }
note() { printf '   note:  %s\n' "$1"; }
act()  { # act "<description>" <command...>
  local desc="$1"; shift
  if [ "$check_only" -eq 1 ]; then
    printf '   DRIFT: %s (would run: %s)\n' "$desc" "$*"
    drift=1
  else
    printf '   fix:   %s\n' "$desc"
    "$@" || { fail "command failed: $*"; return 1; }
  fi
}

step "[1/7] prerequisites"
for cmd in container node npm pi op; do
  command -v "$cmd" >/dev/null 2>&1 && ok "$cmd found" || fail "$cmd not on PATH"
done
if [ -f "$MODELS_SRC" ]; then
  ok "models source: $MODELS_SRC"
else
  fail "missing models source: $MODELS_SRC (check \$DOTFILES)"
fi
if command -v op >/dev/null 2>&1; then
  accounts=$(op account list 2>/dev/null | tail -n +2 | grep -c . || true)
  [ "${accounts:-0}" -ge 1 ] && ok "op has $accounts account(s) enrolled" \
    || warn "no 1Password CLI account: op read fallbacks will not resolve"
fi

step "[2/7] npm dependencies and command links"
if [ -d node_modules/proxy-chain ]; then
  ok "node_modules present"
else
  act "node_modules missing" npm install --no-audit --no-fund
fi
npm_prefix=$(npm prefix -g 2>/dev/null)
link_target="$npm_prefix/lib/node_modules/pi-container"
link_ok=1
for bin in pic pic-proxy pic-keys clc-proxy; do
  resolved=$(readlink "$npm_prefix/bin/$bin" 2>/dev/null || true)
  case "$resolved" in
    *pi-container/*) ;;
    *) link_ok=0; note "host command $bin not linked (found: ${resolved:-nothing})" ;;
  esac
done
if [ "$(cd "$link_target" 2>/dev/null && pwd -P)" = "$(pwd -P)" ] && [ "$link_ok" -eq 1 ]; then
  ok "pic, pic-proxy, pic-keys, clc-proxy linked to this repo"
else
  act "global link stale or incomplete" npm link
fi

step "[3/7] host pi"
host_pi=$(pi --version 2>/dev/null || echo 0)
latest_pi=$(npm view @earendil-works/pi-coding-agent version 2>/dev/null || echo "")
if [ -z "$latest_pi" ]; then
  warn "cannot read published pi version (offline?): host pi is $host_pi"
elif [ "$(printf '%s\n%s\n' "$host_pi" "$latest_pi" | sort -V | head -1)" = "$latest_pi" ]; then
  ok "host pi $host_pi is current (published $latest_pi)"
else
  act "host pi $host_pi older than published $latest_pi" pi update self
fi

step "[4/7] models.json"
if [ -f "$MODELS_SRC" ]; then
  cat > "$node_stage" <<'NODE'
const fs = require('node:fs');
const src = process.env.MODELS_SRC, local = process.env.MODELS_LOCAL;
let doc;
try { doc = JSON.parse(fs.readFileSync(src, 'utf8')); }
catch (e) { console.error('invalid JSON in ' + src + ': ' + e.message); process.exit(3); }
if (fs.existsSync(local)) {
  let over;
  try { over = JSON.parse(fs.readFileSync(local, 'utf8')); }
  catch (e) { console.error('invalid JSON in ' + local + ': ' + e.message); process.exit(3); }
  for (const [name, patch] of Object.entries(over.providers || {})) {
    doc.providers[name] = Object.assign({}, doc.providers[name] || {}, patch);
    console.error('note: applied machine overrides from ' + local + ' to provider "' + name + '"');
  }
}
for (const [name, p] of Object.entries(doc.providers || {})) {
  const key = p.apiKey || '';
  if (!key.startsWith('!')) continue;
  const prefix = '!cat "${PI_KEY_DIR:-$HOME/.config/pi/keys}/' + name + '" 2>/dev/null || op read "';
  const valid = key.startsWith(prefix) && key.endsWith('"')
    && /^op:\/\/[^"]+"$/.test(key.slice(prefix.length));
  if (!valid) {
    console.error('apiKey contract broken for provider "' + name + '":');
    console.error('  got:      ' + key);
    console.error('  expected: !cat "${PI_KEY_DIR:-$HOME/.config/pi/keys}/' + name + '" 2>/dev/null || op read "op://Vault/Item/Field"');
    process.exit(4);
  }
}
process.stdout.write(JSON.stringify(doc, null, 2) + '\n');
NODE
  MODELS_SRC="$MODELS_SRC" MODELS_LOCAL="$MODELS_LOCAL" node "$node_stage" > "$staged_file"
  stage_rc=$?
  if [ "$stage_rc" -ne 0 ]; then
    fail "models.json staging aborted (node exit $stage_rc)"
  elif [ -f "$MODELS_DST" ] && cmp -s "$staged_file" "$MODELS_DST"; then
    ok "$MODELS_DST matches canonical source"
  elif [ "$check_only" -eq 1 ]; then
    printf '   DRIFT: %s differs from %s (would back up and restage)\n' "$MODELS_DST" "$MODELS_SRC"
    drift=1
  else
    backup="${MODELS_DST}.bak-$(date +%Y%m%d-%H%M%S)"
    [ -f "$MODELS_DST" ] && cp "$MODELS_DST" "$backup" && note "previous file saved to $backup"
    cp "$staged_file" "$MODELS_DST" && chmod 600 "$MODELS_DST" \
      && ok "staged $MODELS_DST" || fail "could not write $MODELS_DST"
    ls -1t "${MODELS_DST}.bak-"* 2>/dev/null | tail -n +4 | while read -r old; do rm -f "$old"; done
  fi
fi

step "[5/7] container image $IMAGE"
image_created=$(container image inspect "$IMAGE" 2>/dev/null \
  | grep -m1 '"creationDate"' | cut -d'"' -f4 || true)
newest_src=$(stat -f %m Dockerfile entrypoint.sh 2>/dev/null | sort -n | tail -1)
if [ -z "$image_created" ]; then
  act "image missing" container build --dns 1.1.1.1 -t "$IMAGE" .
elif [ "$no_cache" = "--no-cache" ]; then
  act "cache bust requested" container build --dns 1.1.1.1 --no-cache -t "$IMAGE" .
else
  created_epoch=$(date -j -u -f "%Y-%m-%dT%H:%M:%SZ" "$image_created" +%s 2>/dev/null || echo 0)
  if [ "${newest_src:-0}" -gt "$created_epoch" ]; then
    act "Dockerfile/entrypoint newer than image ($image_created)" \
      container build --dns 1.1.1.1 -t "$IMAGE" .
  else
    ok "image built $image_created, newer than Dockerfile/entrypoint"
  fi
fi

step "[6/7] containers on the previous image"
image_epoch=$(date -j -u -f "%Y-%m-%dT%H:%M:%SZ" "$(container image inspect "$IMAGE" 2>/dev/null \
  | grep -m1 '"creationDate"' | cut -d'"' -f4)" +%s 2>/dev/null || echo 0)
cat > "$node_list" <<'NODE'
let s = "";
process.stdin.on("data", d => s += d).on("end", () => {
  let items;
  try { items = JSON.parse(s); } catch { process.exit(0); }
  items = items.items || items;
  for (const it of items) {
    const cfg = it.configuration || {};
    const image = cfg.image;
    const ann = image && image.descriptor && image.descriptor.annotations;
    const name = typeof image === "string" ? image : (ann && ann["com.apple.containerization.image.name"]) || "";
    if (name !== process.env.IMAGE_TAG) continue;
    const started = (it.status && it.status.startedDate) || cfg.creationDate || "";
    if (started) console.log(it.id + " " + started);
  }
});
NODE
container ls -a --format json 2>/dev/null | IMAGE_TAG="$IMAGE" node "$node_list" > "$stale_file"
stale_found=0
if [ "$image_epoch" -gt 0 ]; then
  while read -r cid started; do
    [ -n "$cid" ] || continue
    started_epoch=$(date -j -u -f "%Y-%m-%dT%H:%M:%SZ" "$started" +%s 2>/dev/null || echo 0)
    if [ "$started_epoch" -lt "$image_epoch" ]; then
      stale_found=1
      if [ "$reap" -eq 1 ] && [ "$check_only" -eq 0 ]; then
        container stop "$cid" >/dev/null 2>&1; container delete "$cid" >/dev/null 2>&1 \
          && ok "reaped $cid (started $started)" || fail "could not reap $cid"
      else
        fail "container $cid started $started, before the current image (stale entrypoint; pass --reap)"
      fi
    fi
  done < "$stale_file"
fi
[ "$stale_found" -eq 0 ] && ok "no containers older than the current image"

step "[7/7] tests"
if [ "$check_only" -eq 1 ]; then
  note "skipped in --check mode"
else
  test_out=$(npm test 2>&1); test_rc=$?
  echo "$test_out" | grep -E "^(ℹ (tests|pass|fail)|# (tests|pass|fail))" || true
  [ "$test_rc" -eq 0 ] && ok "npm test passed" || fail "npm test failed"
fi

printf '\n== result\n'
if [ "$drift" -eq 0 ]; then
  echo "   clean: everything applied and current"
  exit 0
elif [ "$check_only" -eq 1 ]; then
  echo "   drift detected: run ./install.sh to apply"
  exit 1
else
  echo "   finished with problems: see FAIL lines above"
  exit 1
fi
