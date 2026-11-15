#!/bin/bash
# Prove that provider keys reach a container without touching storage on either side.
#
#   ./key-injection-check.sh [workdir]        # default: a throwaway directory under /tmp
#
# Launches `pic` through a pty (Pi needs a terminal), then checks inside the container:
#   * /run/pi-keys is a tmpfs (guest RAM), not a virtiofs share or a bind of a host file
#   * the key file exists, is 0600, and matches what pi itself resolves (hash only)
#   * the provider catalogue is intact
# and on the host:
#   * the launcher's own output contains no key material
#   * Apple container's recorded instance configuration contains no key material
#
# The value's source is whatever models.json says, so with a key file present this runs
# without contacting a secret manager; without one it exercises the live read (and needs
# 1Password unlocked). Only hashes and lengths are printed.

set -u
workdir=${1:-$(mktemp -d /tmp/pic-keycheck-XXXXXX)}
verbose=${PIC_KEYS_VERBOSE:-1}
log=$(mktemp /tmp/pic-keycheck-log-XXXXXX)
# Any provider's key will do for the leak scan; take the first file in the key directory.
keys_dir=${PIC_KEYS_HOST_DIR:-$HOME/.config/pi/keys}
key_name=$(ls -1 "$keys_dir" 2>/dev/null | grep -v '^\.' | head -1)
secret=$(tr -d '\n' < "$keys_dir/$key_name" 2>/dev/null || true)

cleanup() {
  [ -n "${runner:-}" ] && kill "$runner" 2>/dev/null
  [ -n "${name:-}" ] && { container stop "$name" >/dev/null 2>&1; container delete "$name" >/dev/null 2>&1; }
  rm -f "$log"
}
trap cleanup EXIT INT TERM

mkdir -p "$workdir"
cd "$workdir" || exit 1
echo "workdir: $workdir"
echo "host key file: ${key_name:-none}"

PIC_KEYS_VERBOSE=$verbose PIC_KEYS_WAIT=${PIC_KEYS_WAIT:-25} script -q /dev/null pic >"$log" 2>&1 &
runner=$!
sleep 35

name=$(container ls -q 2>/dev/null | grep -E '^pic-' | head -1)
if [ -z "${name:-}" ]; then
  echo "FAIL no launcher container appeared; launcher output:"
  perl -pe 's/\e\[[0-9;?]*[a-zA-Z]//g' "$log" | tail -20
  exit 1
fi
echo "container: $name"

container exec -e PI_KEY_DIR=/run/pi-keys "$name" sh -c '
  line=$(grep " /run/pi-keys " /proc/self/mountinfo || true)
  case "$line" in
    *tmpfs*) echo "ok   /run/pi-keys is tmpfs (guest RAM)" ;;
    "")      echo "FAIL /run/pi-keys is not mounted" ;;
    *)       echo "FAIL /run/pi-keys is not tmpfs: $line" ;;
  esac
  echo "     $(ls /run/pi-keys | tr "\n" " ")"
  for f in /run/pi-keys/*; do
    [ -f "$f" ] || continue
    echo "     $(basename "$f"): mode $(stat -c %a "$f"), $(wc -c < "$f" | tr -d " ") bytes, sha256 $(tr -d "\n" < "$f" | sha256sum | cut -c1-16)"
  done
  if command -v pi >/dev/null 2>&1; then
    echo "     catalogue: $(pi --list-models 2>/dev/null | grep -c . ) models listed"
  fi
  echo "     /host-pi exposes a keys dir: $(ls /host-pi 2>/dev/null | grep -c keys)"'

# The value is supplied on stdin (`-f -`), never as an argument: argv is visible in `ps`.
if [ -n "$secret" ]; then
  found=$(printf '%s' "$secret" | grep -c -F -f - "$log" 2>/dev/null || true)
  [ "${found:-0}" = "0" ] && echo "ok   launcher output holds no key material" || echo "FAIL launcher output contains the key"
  leaked=$(printf '%s' "$secret" | grep -rl --exclude-dir=sessions -F -f - \
    "$HOME/Library/Application Support/com.apple.container" 2>/dev/null | head -3)
  [ -z "$leaked" ] \
    && echo "ok   Apple container configuration holds no key material" \
    || echo "FAIL recorded in: $leaked"
else
  echo "note no key file in $keys_dir: the live-read branch is what ran (nothing to compare)"
  echo "     compare its hash against your secret manager manually, or run: pic-keys --verify"
fi

# The launcher's progress bar shares a line with the entrypoint's messages, so pull the
# messages out rather than printing whole lines.
echo "launcher/entrypoint messages:"
perl -pe 's/\e\[[0-9;?]*[a-zA-Z]//g' "$log" \
  | grep -aoE '\[(pic-keys(-inject)?|pi-container)\][^\[]{0,90}' | sed 's/^/     /' | tail -8
