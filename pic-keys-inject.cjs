#!/usr/bin/env node
// Push provider API keys into a container that is starting, over exec stdin into a tmpfs.
//
// Spawned by pic/pic-proxy next to `container run` and safe to run before the container
// exists: it waits for the container to be running, writes each key, then touches the
// ready marker that /usr/local/bin/entrypoint.sh waits on. Values travel only through this
// process' memory and a stdin pipe - never argv, never a file on either side, never output.
//
//   node pic-keys-inject.cjs <container-name>            # inject, then release the gate
//   node pic-keys-inject.cjs <container-name> --wait N   # give up after N seconds (default 45)

const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const {
  commandKeyProviderIds,
  execReadyArgs,
  execWriteArgs,
  keyCommandUri,
  keyReadTimeoutMs,
  keyTargetPath,
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
const waitIndex = cliArgs.indexOf('--wait');
const waitSeconds = waitIndex >= 0 ? Number(cliArgs[waitIndex + 1]) || 45 : 45;
const containerDir = process.env.PI_KEY_DIR || '/run/pi-keys';

if (!container) {
  console.error('usage: pic-keys-inject <container-name> [--wait seconds]');
  process.exit(2);
}

function modelsJsonPath() {
  const explicit = process.env.PI_MODELS_JSON;
  if (explicit && fs.existsSync(explicit)) return explicit;
  const scoped = path.join(os.homedir(), '.pi', 'agent', 'models.json');
  return fs.existsSync(scoped) ? scoped : path.join(os.homedir(), '.pi', 'models.json');
}

function sleepSync(seconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.round(seconds * 1000));
}

let staleMount = false;

// The container is created by the sibling `container run`; poll until exec is accepted.
// Returns true when runnable, false on timeout/exit, 'stale-mount' for a read-only key mount.
function waitForContainer(seconds) {
  const deadline = Date.now() + seconds * 1000;
  while (Date.now() < deadline) {
    const result = spawnSync('container', ['inspect', container], { encoding: 'utf8' });
    if (result.status === 0) {
      try {
        // `container inspect` returns a JSON array even for one container.
        const parsed = JSON.parse(result.stdout);
        const info = Array.isArray(parsed) ? parsed[0] : parsed;
        const state = String((info && (info.status?.state || info.state || info.status)) || '').toLowerCase();
        if (state.includes('running')) {
          if (keyMountIsReadOnly(info)) {
            staleMount = true;
            warn(
              `${container} was created with a read-only key mount at ${containerDir} (an older launch). `
                + 'Stop that container so pic can create a tmpfs one: container stop ' + container,
            );
            return 'stale-mount';
          }
          return true;
        }
        // Not running yet. Deliberately not fatal: the launcher's container name is stable per
        // workdir, so an exited container with the same name can be visible for a moment while
        // `container run` replaces it. Poll until the deadline instead.
        log(`waiting for ${container} (state: ${state || 'unknown'})`);
      } catch {
        // Not observable yet.
      }
    }
    sleepSync(0.25);
  }
  return false;
}

// A virtiofs mount here means the container predates tmpfs injection: writing would fail
// on a read-only filesystem, so say so instead of timing out.
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

// Environment-form secrets (Anthropic credentials, legacy "${NAME}" providers) travel through
// the same tmpfs: the launcher declares the names in PIC_ENV_EXPORT, and entrypoint.sh exports
// them inside the VM. Nothing sensitive is ever recorded in the container configuration.
const exportNames = (process.env.PIC_ENV_EXPORT || '').split(',').map((name) => name.trim()).filter(Boolean);
const anthropicRequested = process.env.PIC_ANTHROPIC === '1';

function providersEnvText() {
  const file = process.env.PI_PROVIDERS_ENV || path.join(os.homedir(), '.config', 'pi', 'providers.env');
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : undefined;
}

// PI_ANTHROPIC_KEY_CMD is an opt-in host command (e.g. an `op read` lookup); bounded like every
// other read so a manager waiting on an approval dialog cannot stall the launch.
function runKeyCommand(cmd) {
  const result = spawnSync(cmd, { shell: true, encoding: 'utf8', timeout: keyReadTimeoutMs() });
  if (result.error || result.status !== 0) {
    warn(`PI_ANTHROPIC_KEY_CMD failed: ${(result.stderr || result.error?.message || `exit ${result.status}`)}`.trim());
    return '';
  }
  return String(result.stdout || '');
}

const envSecrets = exportNames.length
  ? resolveEnvSecretValues({
      names: exportNames,
      modelsText,
      env: process.env,
      providersEnvText: providersEnvText(),
      anthropicEnabled: anthropicRequested,
      runCommand: runKeyCommand,
    })
  : { values: {}, missing: [] };

if (envSecrets.missing.length > 0) {
  warn(`no value for ${envSecrets.missing.join(', ')}; Pi will see those as unset in the container`);
}

const resolved = [];
for (const providerId of providerIds) {
  const apiKey = providerKeyCommand(modelsText, providerId);
  const { value, reason } = resolveKeyCommandValue({ apiKey });
  if (!value) {
    const uri = keyCommandUri(modelsText, providerId);
    warn(
      `${providerId}: could not read the key to inject${uri ? ` (${uri})` : ''}: ${reason}. ` +
        'The provider will be unavailable in the container' +
        (String(reason).includes('ETIMEDOUT')
          ? ` - the read exceeded PIC_KEY_READ_TIMEOUT (${require('./provider-keys.cjs').keyReadTimeoutMs() / 1000}s); a secret manager waiting for approval needs a terminal where it can prompt`
          : '') +
        '.',
    );
    continue;
  }
  resolved.push({ providerId, value });
}

for (const [name, value] of Object.entries(envSecrets.values)) {
  if (!safeKeyFileName(name)) continue;
  resolved.push({ providerId: name, value });
}

if (waitForContainer(waitSeconds) !== true) {
  if (!staleMount) warn(`container ${container} never became runnable; provider keys were not injected`);
  process.exit(1);
}

let failures = 0;
for (const { providerId, value } of resolved) {
  const args = execWriteArgs({ container, target: keyTargetPath({ containerDir, providerId }) });
  const result = spawnSync('container', args, { input: value, encoding: 'utf8' });
  if (result.status !== 0) {
    failures += 1;
    warn(`${providerId}: failed to write the key into the container: ${(result.stderr || '').trim()}`);
  } else {
    log(`wrote ${providerId} to ${keyTargetPath({ containerDir, providerId })}`);
  }
}

// Release the entrypoint gate even on partial failure, so a broken provider cannot hang
// the whole container; pi then reports that single provider as unavailable.
const ready = spawnSync('container', execReadyArgs({ container, containerDir }), { encoding: 'utf8' });
if (ready.status !== 0) {
  warn(`failed to release the startup gate: ${(ready.stderr || '').trim()}`);
  process.exit(1);
}
log(`released ${containerDir}/.ready after ${resolved.length - failures}/${resolved.length} keys`);
