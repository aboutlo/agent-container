// Provider API keys without a secret on a container command line, in a container log, or
// on disk anywhere.
//
// Pi resolves an `apiKey` that starts with `!` by running the rest as a shell command and
// using stdout. The convention used here:
//
//   "apiKey": "!cat \"${PI_KEY_DIR:-$HOME/.config/pi/keys}/<provider>\" 2>/dev/null || op read \"<URI>\""
//
// Native pi (no PI_KEY_DIR, no container): the `cat` fails and `op read` runs live, so
// nothing is exported and nothing needs to be stored.
//
// Containers: the secret manager cannot run there, and every declarative way to hand a
// value in is persisted by Apple container before the VM boots -
//   `-e NAME=value`        -> plaintext in instances/<id>/config.json (0644) + inspect
//   `--env-file <path>`    -> the file itself, plus the same config.json
//   `--volume <host dir>`  -> a persistent host copy, and the bind lines land in
//                             logs/container/<id>.log
// So the value is piped in *after* start over `container exec -i` stdin into a tmpfs, and
// the entrypoint waits for a ready marker before exec'ing pi (pi caches a resolved key for
// its whole process). tmpfs is guest RAM: `container stop --rm` discards it.
//
// Why the file is read from $PI_KEY_DIR rather than injected as an env var: an env var
// would still have to cross the boundary declaratively, i.e. be recorded.

const fs = require('node:fs');

const keysTransportDefault = 'tmpfs';
const keysReadyFile = '.ready';
const keysFailedFile = '.failed';

// Provider ids of every model provider whose apiKey is externalised as `!command`.
function commandKeyProviderIds(modelsText) {
  let parsed;
  try {
    parsed = JSON.parse(modelsText);
  } catch {
    return [];
  }
  const providers = parsed && typeof parsed.providers === 'object' && parsed.providers !== null ? parsed.providers : {};
  return Object.entries(providers)
    .filter(([, config]) => config && typeof config.apiKey === 'string' && config.apiKey.startsWith('!'))
    .map(([providerId]) => providerId);
}

function keyFileName({ keysDir, providerId }) {
  const name = safeKeyFileName(providerId);
  return name ? `${keysDir}/${name}` : null;
}

// Providers whose key file is absent on the host: in tmpfs mode that is normal (the live
// read fills it in), so this only matters for the legacy bind transport.
function missingCommandKeys({ modelsText, keysDir, existsSync = fs.existsSync, isFile = fs.statSync }) {
  const missing = [];
  for (const providerId of commandKeyProviderIds(modelsText)) {
    const target = keyFileName({ keysDir, providerId });
    if (!target) continue; // unusable as a file name; the injector reports it
    let stat = null;
    try {
      stat = existsSync(target) ? isFile(target) : null;
    } catch {
      stat = null;
    }
    if (!stat || !stat.isFile()) missing.push({ providerId, target, uri: keyCommandUri(modelsText, providerId) });
  }
  return missing;
}

// Two shapes on purpose: keyCommandUri(apiKeyCommand) for a single provider's apiKey, and
// keyCommandUri(modelsText, providerId) to look one up in models.json.
function keyCommandUri(modelsText, providerId) {
  const command =
    providerId === undefined ? String(modelsText || '') : String(providerKeyCommand(modelsText, providerId) || '');
  const quoted = /op read\s+"([^"]+)"/.exec(command);
  if (quoted) return quoted[1];
  const bare = /op read\s+(\S+)/.exec(command);
  return bare ? bare[1] : null;
}

function keysMountArgs({ keysDir, containerDir, existsSync = fs.existsSync }) {
  return keysDir && containerDir && existsSync(keysDir) ? ['--volume', `${keysDir}:${containerDir}:ro`] : [];
}

function tmpfsMountArgs({ containerDir }) {
  return containerDir ? ['--tmpfs', containerDir] : [];
}

function keysEnvArgs({ keysDir, containerDir, transport = keysTransportDefault, existsSync = fs.existsSync }) {
  if (!containerDir) return [];
  if (transport === 'bind') return existsSync(keysDir) ? ['-e', `PI_KEY_DIR=${containerDir}`] : [];
  return ['-e', `PI_KEY_DIR=${containerDir}`];
}

// Seconds the entrypoint waits for the ready marker before starting pi regardless.
function keysGateArgs({ waitSeconds }) {
  const args = ['-e', `PIC_KEYS_WAIT=${waitSeconds}`];
  // The verdict lives in the container, so the choice to start anyway has to travel with it.
  if (process.env.PIC_KEYS_REQUIRED === '0') args.push('-e', 'PIC_KEYS_REQUIRED=0');
  return args;
}

// Provider ids become file names inside the key tmpfs. Rather than mangle them (the
// models.json command names the file literally, so "openai.gpt" must stay "openai.gpt"),
// anything that could escape the directory is refused and the caller warns.
function safeKeyFileName(value) {
  const id = String(value);
  if (!id || id === '.' || id === '..' || id.startsWith('.') || id.includes('/') || id.includes('\\')) return null;
  return id;
}

// Named container so the launcher can address it with `container exec` while it is still
// booting; derived from the per-workdir volume suffix, so it is stable and collision-free.
function containerNameFor({ prefix = 'pic', volumeSuffix }) {
  return volumeSuffix ? `${prefix}-${volumeSuffix}` : null;
}

function keyTargetPath({ containerDir, providerId }) {
  const name = safeKeyFileName(providerId);
  return name ? `${containerDir}/${name}` : null;
}

function keysMarkerPath({ containerDir, marker = keysReadyFile }) {
  return `${containerDir}/${marker}`;
}

function readyTargetPath({ containerDir }) {
  return keysMarkerPath({ containerDir, marker: keysReadyFile });
}

// Value goes to stdin, never to argv (argv lands in logs). `sh -c 'umask 0600; cat > f'`
// works on a tmpfs the exec user cannot write to as a plain file creation.
// umask is a mask of bits to *remove* from 0666, hence 0177 (not 0600, which would strip
// the owner's own read/write).
function execWriteArgs({ container, target, umask = '0177' }) {
  if (!container || !target) return [];
  return ['exec', '-i', container, 'sh', '-c', `umask ${umask}; cat > '${target}'`];
}

// Markers are written through stdin as well (the content of .failed is a list of provider ids).
// The opposite marker is removed so a reused container cannot read a stale verdict from the
// previous launch.
function execMarkerArgs({ container, markerPath, otherPath, umask = '0177' }) {
  if (!container || !markerPath) return [];
  const remove = otherPath ? `rm -f '${otherPath}'; ` : '';
  return ['exec', '-i', container, 'sh', '-c', `umask ${umask}; ${remove}cat > '${markerPath}'`];
}

// Turn a secret manager's stderr into the thing to do next. Generic "unlock your vault" advice
// is wrong for the most common case on a machine where the desktop app integration is off: there
// is nothing to unlock, the CLI simply has no session token in this shell.
function credentialAdvice(reason) {
  const text = String(reason || '').toLowerCase();
  if (text.includes('not currently signed in') || text.includes('not signed in')) {
    return 'the CLI has no session in this shell: sign in here, then run again  (opin, or eval "$(op signin --account my)")';
  }
  if (text.includes('owned by the current user') || text.includes('logged in user')) {
    return 'op cannot run outside your GUI login session: compare `stat -f %Su /dev/console` with `id -un`, or use a key file (pic-keys <provider>)';
  }
  if (text.includes('no accounts found') || text.includes('account is not signed in')) {
    return 'op has no account configured here: `op account list`, then export OP_ACCOUNT=<shorthand>';
  }
  if (text.includes('prompt') || text.includes('biometric') || text.includes('timeout') || text.includes('timed out')) {
    return 'the secret manager did not answer: unlock it, or raise PIC_KEYS_WAIT / PIC_KEY_READ_TIMEOUT, or use a key file (pic-keys <provider>)';
  }
  return 'check the URI in models.json, or write a key file from a terminal where it can prompt: pic-keys <provider>';
}

// Whether the session is worth starting: a container whose every command-key provider failed is
// not a working pi, and the error pi itself reports ("Failed to resolve API key") points at the
// container rather than at the host-side read that failed. Missing env secrets do not decide.
function keysOutcome({ expected = [], failed = [] }) {
  const expectedIds = expected.map(String);
  const failedIds = expectedIds.filter((id) => failed.map(String).includes(id));
  return {
    usable: expectedIds.filter((id) => !failedIds.includes(id)),
    failed: failedIds,
    ok: expectedIds.length === 0 || failedIds.length < expectedIds.length,
  };
}

// A human may have to unlock a secret manager or approve a touch prompt before the read can
// answer, so a single attempt is not enough: the injector retries until the gate is about to
// expire. The gate default has to cover that (see PIC_KEYS_WAIT in pic-runner).
function keyReadTimeoutMs() {
  const seconds = Number(process.env.PIC_KEY_READ_TIMEOUT);
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 30_000;
}

// Run a models.json `!command` apiKey on the host exactly as native pi would: PI_KEY_DIR
// unset, so the host key file is used if it exists and the live read (op read) otherwise.
function resolveKeyCommandValue({
  apiKey,
  env = process.env,
  spawn = require('node:child_process').spawnSync,
  shell = '/bin/bash',
  timeoutMs = keyReadTimeoutMs(),
}) {
  if (typeof apiKey !== 'string' || !apiKey.startsWith('!')) return { value: null, reason: 'apiKey is not a !command' };
  const childEnv = { ...env };
  delete childEnv.PI_KEY_DIR;
  const result = spawn(shell, ['-c', apiKey.slice(1)], { encoding: 'utf8', env: childEnv, timeout: timeoutMs });
  if (result.error) return { value: null, reason: result.error.message };
  const value = String(result.stdout || '').trim();
  if (result.status !== 0 || !value) {
    const firstError = String(result.stderr || '')
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line && !line.includes('keychain'))[0];
    return { value: null, reason: firstError || `command exited with ${result.status}` };
  }
  return { value, reason: null };
}

function providerKeyCommand(modelsText, providerId) {
  try {
    const config = (JSON.parse(modelsText).providers || {})[providerId] || {};
    return typeof config.apiKey === 'string' && config.apiKey.startsWith('!') ? config.apiKey : null;
  } catch {
    return null;
  }
}

module.exports = {
  commandKeyProviderIds,
  containerNameFor,
  execMarkerArgs,
  execWriteArgs,
  keyReadTimeoutMs,
  keyCommandUri,
  keyFileName,
  keysFailedFile,
  keyTargetPath,
  keysEnvArgs,
  credentialAdvice,
  keysGateArgs,
  keysMarkerPath,
  keysOutcome,
  keysMountArgs,
  keysReadyFile,
  keysTransportDefault,
  missingCommandKeys,
  providerKeyCommand,
  readyTargetPath,
  resolveKeyCommandValue,
  safeKeyFileName,
  tmpfsMountArgs,
};
