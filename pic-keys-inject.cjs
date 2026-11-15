#!/usr/bin/env node
// Put provider keys and environment secrets into a starting container, over exec stdin.
//
// Spawned by pic/pic-proxy alongside `container run`. It is safe to start before the container
// exists: it waits for it to be running, resolves each secret on the host, pipes the values into
// the key tmpfs, and finally writes a marker that /usr/local/bin/entrypoint.sh waits on:
//
//   /run/pi-keys/.ready    at least one provider key is usable - start pi
//   /run/pi-keys/.failed   no provider key could be read - do NOT start pi; the names are the
//                          marker's content, so the entrypoint can say what is missing
//
// Starting pi without a credential produces a confusing mid-session "Failed to resolve API key"
// error, so the launcher reports the real cause (locked secret manager, missing key file) instead.
// Values travel only through this process' memory and a stdin pipe: never argv, never a file on
// either side, never output.
//
//   node pic-keys-inject.cjs <container> [--wait seconds] [--gate seconds]

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  commandKeyProviderIds,
  execMarkerArgs,
  execWriteArgs,
  keyCommandUri,
  keysFailedFile,
  keyReadTimeoutMs,
  keysReadyFile,
  keyTargetPath,
  keysMarkerPath,
  keysOutcome,
  providerKeyCommand,
  resolveKeyCommandValue,
  safeKeyFileName,
} = require('./provider-keys.cjs');
const { resolveEnvSecretValues } = require('./host-secrets.cjs');

const verbose = process.env.PIC_KEYS_VERBOSE === '1';
const log = (...args) => {
  if (verbose) console.error('[pic-keys-inject]', ...args);
};
const warn = (...args) => console.error('[pic-keys]', ...args);

const cliArgs = process.argv.slice(2);
const container = cliArgs.find((arg) => !arg.startsWith('--'));
const flagNumber = (flag, fallback) => {
  const index = cliArgs.indexOf(flag);
  const value = index >= 0 ? Number(cliArgs[index + 1]) : NaN;
  return Number.isFinite(value) && value > 0 ? value : fallback;
};
// --wait bounds waiting for the container to exist; --gate mirrors the entrypoint's
// PIC_KEYS_WAIT, which is the deadline that actually matters for reading keys.
const waitSeconds = flagNumber('--wait', 240);
const gateSeconds = flagNumber('--gate', 90);
const retryDelaySeconds = 3;
const containerDir = process.env.PI_KEY_DIR || '/run/pi-keys';

if (!container) {
  console.error('usage: pic-keys-inject <container-name> [--wait seconds] [--gate seconds]');
  process.exit(2);
}

function sleepSync(seconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.round(seconds * 1000));
}

function modelsJsonPath() {
  const explicit = process.env.PI_MODELS_JSON;
  if (explicit && fs.existsSync(explicit)) return explicit;
  const scoped = path.join(os.homedir(), '.pi', 'agent', 'models.json');
  return fs.existsSync(scoped) ? scoped : path.join(os.homedir(), '.pi', 'models.json');
}

function providersEnvText() {
  const file = process.env.PI_PROVIDERS_ENV || path.join(os.homedir(), '.config', 'pi', 'providers.env');
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : undefined;
}

let staleMount = false;

// The container is created by the sibling `container run`, so poll until exec is accepted and
// return when it started (the entrypoint's gate is counted from there).
function waitForContainer(seconds) {
  const deadline = Date.now() + seconds * 1000;
  while (Date.now() < deadline) {
    const result = spawnSync('container', ['inspect', container], { encoding: 'utf8' });
    if (result.status === 0) {
      try {
        // `container inspect` returns a JSON array even for one container.
        const parsed = JSON.parse(result.stdout);
        const info = Array.isArray(parsed) ? parsed[0] : parsed;
        const status = (info && info.status) || {};
        const state = String(status.state || info?.state || '').toLowerCase();
        if (state.includes('running')) {
          if (keyMountIsReadOnly(info)) {
            staleMount = true;
            warn(
              `${container} was created with a read-only key mount at ${containerDir} (an older launch). ` +
                `Stop that container so pic can create a tmpfs one: container stop ${container}`,
            );
            return { ready: false, staleMount: true };
          }
          const startedMs = Date.parse(status.startedDate || '') || Date.now();
          return { ready: true, startedMs };
        }
        // Not running yet, and deliberately not treated as fatal: the launcher's container name
        // is stable per workdir, so an exited container with the same name can be visible for a
        // moment while `container run` replaces it.
        log(`waiting for ${container} (state: ${state || 'unknown'})`);
      } catch {
        // Not observable yet.
      }
    }
    sleepSync(0.25);
  }
  return { ready: false };
}

// A virtiofs mount here means the container predates tmpfs injection: writing would fail on a
// read-only filesystem, so say so instead of timing out.
function keyMountIsReadOnly(info) {
  const mounts = (info && info.configuration && info.configuration.mounts) || [];
  return mounts.some((mount) => mount.destination === containerDir && mount.options?.includes('ro'));
}

const modelsPath = modelsJsonPath();
const modelsText = fs.existsSync(modelsPath) ? fs.readFileSync(modelsPath, 'utf8') : '';
const providerIds = commandKeyProviderIds(modelsText).filter((providerId) => {
  if (safeKeyFileName(providerId)) return true;
  warn(`${providerId}: provider id cannot be used as a file name; its key was not injected`);
  return false;
});

// PI_ANTHROPIC_KEY_CMD is an opt-in host command (for example an `op read` lookup).
function runKeyCommand(cmd) {
  const result = spawnSync(cmd, { shell: true, encoding: 'utf8', timeout: keyReadTimeoutMs() });
  if (result.error || result.status !== 0) {
    warn(`PI_ANTHROPIC_KEY_CMD failed: ${String(result.stderr || result.error?.message || `exit ${result.status}`).trim()}`);
    return '';
  }
  return String(result.stdout || '');
}

// One attempt per provider that has not resolved yet. A secret manager that needs a human
// (unlock, touch, approval dialog) usually succeeds on a later attempt, so this runs repeatedly
// until the entrypoint's gate is about to expire.
const attempts = new Map();

function resolvePass(round) {
  for (const providerId of providerIds) {
    if (attempts.get(providerId)?.value) continue;
    const startedAt = Date.now();
    const { value, reason } = resolveKeyCommandValue({ apiKey: providerKeyCommand(modelsText, providerId) });
    // A read that fails in 50ms (locked vault, wrong URI) leaves room for many attempts before
    // the gate expires; one that burns the full timeout leaves room for few.
    attempts.set(providerId, { value, reason, ms: Date.now() - startedAt });
    if (value) log(`resolved ${providerId} on attempt ${round}`);
  }
}

function unresolvedIds() {
  return providerIds.filter((providerId) => !attempts.get(providerId)?.value);
}

function reportFailures() {
  for (const providerId of unresolvedIds()) {
    const reason = String(attempts.get(providerId)?.reason || 'unknown');
    const uri = keyCommandUri(modelsText, providerId);
    const hint = reason.includes('ETIMEDOUT')
      ? `the read exceeded PIC_KEY_READ_TIMEOUT (${keyReadTimeoutMs() / 1000}s); a secret manager waiting on a prompt needs an unlocked app and a terminal that can show it`
      : 'check that the URI is right and the secret manager answered';
    warn(`${providerId}: could not read the key${uri ? ` (${uri})` : ''}: ${reason} - ${hint}`);
  }
}

// Environment secrets (Anthropic credentials, legacy "${NAME}" providers) travel through the same
// tmpfs; they never decide whether the session starts, pi simply sees them as unset.
let requestedEnvNames = [];

function writeEnvSecrets() {
  const exportNames = (process.env.PIC_ENV_EXPORT || '').split(',').map((name) => name.trim()).filter(Boolean);
  requestedEnvNames = exportNames;
  if (exportNames.length === 0) return [];
  const { values, missing } = resolveEnvSecretValues({
    names: exportNames,
    modelsText,
    env: process.env,
    providersEnvText: providersEnvText(),
    anthropicEnabled: process.env.PIC_ANTHROPIC === '1',
    runCommand: runKeyCommand,
  });
  if (missing.length > 0) warn(`no value for ${missing.join(', ')}; Pi will see those as unset in the container`);
  return Object.entries(values)
    .filter(([name]) => safeKeyFileName(name))
    .map(([name, value]) => ({ providerId: name, value }));
}

function writeMarker(marker, content) {
  const other = marker === keysReadyFile ? keysFailedFile : keysReadyFile;
  const args = execMarkerArgs({ container, markerPath: keysMarkerPath({ containerDir, marker }), otherPath: keysMarkerPath({ containerDir, marker: other }) });
  const result = spawnSync('container', args, { input: content, encoding: 'utf8' });
  if (result.status !== 0) warn(`failed to write ${marker} into the container: ${(result.stderr || '').trim()}`);
  return result.status === 0;
}

function failWithoutSession(outcome) {
  const names = outcome.failed.join(' ');
  writeMarker(keysFailedFile, `${names}\n`);
  warn(
    `no provider key could be injected (${names}); the container will not start pi. ` +
      'Unlock the secret manager and run again, or store a key file with pic-keys <provider>.',
  );
  process.exit(1);
}

// First attempt while the container is still booting, so the common case (a key file, or an
// already-unlocked manager) costs nothing extra.
resolvePass(1);

const envSecrets = writeEnvSecrets();
const containerState = waitForContainer(waitSeconds);
if (!containerState.ready) {
  if (!staleMount) warn(`container ${container} never became runnable; provider keys were not injected`);
  process.exit(1);
}

// Retry until shortly before the entrypoint's gate expires, then decide.
const gateDeadline = containerState.startedMs + gateSeconds * 1000 - 5000;
let round = 1;
while (unresolvedIds().length > 0) {
  const remaining = gateDeadline - Date.now();
  const nextAttemptMs = Math.max(
    1000,
    ...unresolvedIds().map((providerId) => attempts.get(providerId)?.ms ?? keyReadTimeoutMs()),
  );
  if (remaining < nextAttemptMs * 1.5 + retryDelaySeconds * 1000) break;
  round += 1;
  log(`retrying ${unresolvedIds().length} key read(s) in ${retryDelaySeconds}s (attempt ${round}, ${Math.max(0, Math.round(remaining / 1000))}s of gate left)`);
  sleepSync(retryDelaySeconds);
  resolvePass(round);
}
reportFailures();

const outcome = keysOutcome({ expected: providerIds, failed: unresolvedIds() });
const resolvedKeys = providerIds
  .filter((providerId) => attempts.get(providerId)?.value)
  .map((providerId) => ({ providerId, value: attempts.get(providerId).value }));
const toWrite = [...resolvedKeys, ...envSecrets];

let written = 0;
for (const { providerId, value } of toWrite) {
  const args = execWriteArgs({ container, target: keyTargetPath({ containerDir, providerId }) });
  const result = spawnSync('container', args, { input: value, encoding: 'utf8' });
  if (result.status === 0) written += 1;
  else warn(`${providerId}: failed to write the key into the container: ${(result.stderr || '').trim()}`);
}
log(`wrote ${written}/${toWrite.length} values into ${containerDir}`);

if (!outcome.ok) failWithoutSession(outcome);

writeMarker(keysReadyFile, `${written} values\n`);
log(`released ${containerDir}/${keysReadyFile} with ${written} values`);
