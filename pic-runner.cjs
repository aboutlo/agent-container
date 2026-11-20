#!/usr/bin/env node
const { spawn, spawnSync } = require('node:child_process');
const net = require('node:net');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { listContainersJson: listContainersJsonWithRecovery } = require('./container-system.cjs');
const { stagePackageResources } = require('./pi-package-resources.cjs');
const {
  parseContainerRunnerArgs,
  proxyEnvironmentArgs: buildProxyEnvironmentArgs,
  runChildProcess,
  startProxy: startProxyWithFallback,
} = require('./runner-utils.cjs');
const { resolveProviderEnv } = require('./provider-env.cjs');
const {
  commandKeyProviderIds,
  containerNameFor,
  keysEnvArgs,
  credentialAdvice,
  keyCommandUri,
  keysGateArgs,
  keysMountArgs,
  keysTransportDefault,
  missingCommandKeys,
  providerKeyCommand,
  resolveKeyCommandValue,
  tmpfsMountArgs,
} = require('./provider-keys.cjs');
const { tcpReachable, tunnelOnlyHosts, tunnelWarning } = require('./provider-reachability.cjs');
const {
  buildHostPiSnapshot,
  hostPiMountArgs,
  snapshotDirFor,
} = require('./host-pi-tree.cjs');
const { envExportArgs, envSecretNames, legacySecretEnvArgs, anthropicEnvironmentNames } = require('./host-secrets.cjs');

function readTextIfExists(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

const host = process.env.PIC_PROXY_HOST || '192.168.64.1';
const port = Number(process.env.PIC_PROXY_PORT || 8888);
const proxyUrl = `http://${host}:${port}`;
const verbose = process.env.PIC_PROXY_VERBOSE === '1';
const workdir = process.env.PIC_WORKDIR || process.cwd();
const home = process.env.HOME;
const cliArgs = process.argv.slice(2);
let proxyEnabled = process.env.PIC_PROXY_MODE === '1';
const commandName = process.env.PIC_COMMAND_NAME || 'pic';
if (process.env.HERDR_ENV === '1' && !process.env.HERDR_AGENT) {
  process.env.HERDR_AGENT = 'pi';
}

// Extract runner-level --proxy, --anthropic/-a, --volume, and --publish/-p
// arguments; pass the rest to Pi.
const parsedArgs = parseContainerRunnerArgs(cliArgs, { booleanFlags: ['--proxy', '--anthropic', '-a'] });
if (parsedArgs.flags['--proxy']) proxyEnabled = true;
const anthropicEnabled = parsedArgs.flags['--anthropic'] || parsedArgs.flags['-a'];
const { extraVolumes, extraPublish } = parsedArgs;
const attachMode = parsedArgs.passthroughArgs[0] === 'attach';
const extraPiArgs = attachMode ? parsedArgs.passthroughArgs.slice(1) : parsedArgs.passthroughArgs;

// Use the basename of the current directory so multiple mounts can coexist under /workspace
const dirBasename = path.basename(workdir);
const workspaceTarget = `/workspace/${dirBasename}`;
const volumeSuffix = crypto.createHash('sha1').update(workdir).digest('hex').slice(0, 12);
const volumeBasename = dirBasename.replace(/[^a-zA-Z0-9_.-]/g, '-');
const nodeModulesVolume = `pic-${volumeBasename}-${volumeSuffix}-node-modules`;

// Session directory — pi writes UUID-named session files, no hash needed for isolation
// Two pi processes in the same container won't collide because session IDs are UUIDs.
const sessionDir = `${workspaceTarget}/.pi/agent/sessions`;

// Provider keys: one 0600 file per provider id under ~/.config/pi/keys, mounted read-only
// into the container. models.json points at them with
// `!cat "${PI_KEY_DIR:-$HOME/.config/pi/keys}/<id>"` so pi resolves them without any export
// on the host and without any secret on the container command line. The directory lives
// outside ~/.pi on purpose: ~/.pi is bind-mounted whole at /host-pi, so keys inside it would
// be reachable in the container at a second, undocumented path. See pic-keys.
const providerKeysHostDir = process.env.PIC_KEYS_HOST_DIR || path.join(home || '', '.config', 'pi', 'keys');
const providerKeysContainerDir = process.env.PIC_PROVIDER_KEYS_DIR || '/run/pi-keys';
// 'tmpfs' (default): guest RAM, filled by pic-keys-inject.cjs over exec stdin after start,
// so no secret is written to disk on either side. 'bind': mount the host key directory
// read-only instead (keys stay on disk). 'off': nothing at all.
const providerKeysTransport = (process.env.PIC_KEYS_TRANSPORT || keysTransportDefault).toLowerCase();
// Upper bound for the entrypoint's wait for the keys, in seconds, and therefore how long the
// launcher is willing to wait for a human to unlock a secret manager (the injector retries until
// a few seconds before this expires). Bounded on purpose: a vault that stays locked must end the
// launch with a clear error rather than hang it. The session is not started when it expires
// without a credential (PIC_KEYS_REQUIRED=0 opts out of that).
const providerKeysWaitSeconds = Number(process.env.PIC_KEYS_WAIT ?? 90);

// ~/.pi is never mounted into a container: it holds agent/sessions (every transcript ever
// recorded) and agent/auth.json (stored provider credentials), and a read-only mount is still
// readable by every process in the container. A filtered snapshot of it is mounted instead.
const hostPiSourceDir = path.join(home || '', '.pi');
const hostPiSnapshotEnabled = process.env.PIC_HOST_PI_SNAPSHOT !== '0';
const hostPiSnapshotDir = snapshotDirFor({ home });
const hostPiExtraExcludes = (process.env.PIC_HOST_PI_EXTRA_EXCLUDES || '')
  .split(',')
  .map((entry) => entry.trim())
  .filter(Boolean);
const stagedHostSkillsDir = path.join(workdir, '.pi', 'host-agent-skills');
const stagedHostExtensionsDir = path.join(workdir, '.pi', 'host-agent-extensions');
const herdrEnvironmentNames = ['HERDR_ENV', 'HERDR_WORKSPACE_ID', 'HERDR_TAB_ID', 'HERDR_PANE_ID', 'HERDR_AGENT'];
const herdrSocketMountEnabled = process.env.PIC_HERDR_SOCKET_MOUNT === '1';
const herdrSocketPath = process.env.HERDR_SOCKET_PATH || '';
const herdrSocketDir = herdrSocketMountEnabled && herdrSocketPath ? path.dirname(herdrSocketPath) : '';
const herdrSocketBasename = herdrSocketMountEnabled && herdrSocketPath ? path.basename(herdrSocketPath) : '';
const herdrSocketMountTarget = '/herdr-socket';
const herdrSocketContainerPath = herdrSocketMountEnabled && herdrSocketPath ? `${herdrSocketMountTarget}/${herdrSocketBasename}` : '';
const herdrBridgeEnv = process.env.PIC_HERDR_BRIDGE;
const herdrSessionDetected = process.env.HERDR_ENV === '1'
  && Boolean(herdrSocketPath)
  && Boolean(process.env.HERDR_PANE_ID)
  && fs.existsSync(herdrSocketPath);
const herdrBridgeEnabled = herdrBridgeEnv === '1' || (herdrBridgeEnv !== '0' && herdrSessionDetected);
const herdrBridgeHost = process.env.PIC_HERDR_BRIDGE_HOST || host;
const herdrBridgeRequestedPort = Number(process.env.PIC_HERDR_BRIDGE_PORT || 0);
const herdrBridgeSocketPath = `/tmp/herdr-${String(process.env.HERDR_PANE_ID || 'pane').replace(/[^a-zA-Z0-9_.-]/g, '-')}.sock`;

function proxyEnvironmentArgs() {
  return buildProxyEnvironmentArgs(proxyUrl, { enabled: proxyEnabled });
}

// Anthropic env keys to hand to Pi inside the container. The container does not inherit the
// host env, so without this the key never reaches Pi inside. Values travel through the key
// tmpfs; only the legacy transport puts them on the command line.

// Generic, opt-in way to source a key without storing it anywhere: when
// --anthropic is passed but no ANTHROPIC_* key is in the environment, run the
// command given by PI_ANTHROPIC_KEY_CMD (e.g. an `op read` 1Password lookup)
// on the host and use its stdout as ANTHROPIC_API_KEY. The repo never contains
// the secret or the command itself — only this indirection.
function runAnthropicKeyCommand(cmd) {
  try {
    const result = spawnSync(cmd, { shell: true, encoding: 'utf8' });
    if (result.status === 0) {
      const key = (result.stdout || '').trim();
      return key || '';
    }
    const err = (result.stderr || '').trim();
    log(`warning: PI_ANTHROPIC_KEY_CMD exited with status ${result.status}${err ? `: ${err}` : ''}`);
  } catch (err) {
    log(`warning: PI_ANTHROPIC_KEY_CMD failed: ${err.message}`);
  }
  return '';
}

// Anthropic keys and the legacy "${NAME}" providers used to be forwarded here as
// `-e NAME=<value>`. They now travel through the key tmpfs like every other secret (see
// host-secrets.cjs and pic-keys-inject.cjs); only the fallback for a transport that cannot
// inject keeps the old behaviour, and it warns.

// Providers whose apiKey is `!command` are the only ones needing a key at all.
function providerKeyProviders() {
  return commandKeyProviderIds(providerModelsText());
}

// Environment-form secrets this launch needs inside the container. Names only: the values are
// resolved and piped in by pic-keys-inject.cjs, so the parent process never holds one.

function secretNamesFor({ anthropicEnabled } = {}) {
  return envSecretNames({ modelsText: providerModelsText(), env: process.env, anthropicEnabled });
}

// True when this launcher is responsible for putting secrets inside the container itself
// (tmpfs transport). With bind or off transport the container reads host files and `-e` is
// used for environment secrets, as before.
function shouldInjectSecrets({ anthropicEnabled } = {}) {
  if (providerKeysTransport !== 'tmpfs') return false;
  return providerKeyProviders().length > 0 || secretNamesFor({ anthropicEnabled }).length > 0;
}

// What goes on the container command line for secrets: names in tmpfs mode (nothing sensitive),
// values only when injection is unavailable, with the old warning.
function secretArgsForLaunch({ anthropicEnabled, injectSecrets } = {}) {
  const missingAnthropic = anthropicEnabled && !secretNamesFor({ anthropicEnabled }).some((name) => name.startsWith('ANTHROPIC_'));
  // auth.json is no longer mounted, so there is no stored credential to fall back on: an
  // unsatisfiable --anthropic has to be reported as a missing provider, not as "using local auth".
  const noAnthropicKey = () =>
    log(
      'warning: --anthropic requested but no ANTHROPIC_API_KEY/ANTHROPIC_AUTH_TOKEN in the environment '
        + 'and PI_ANTHROPIC_KEY_CMD produced nothing; the container has no stored credentials '
        + '(~/.pi/agent/auth.json is not mounted), so pi will have no Anthropic provider',
    );
  if (injectSecrets) {
    const names = secretNamesFor({ anthropicEnabled });
    if (missingAnthropic) noAnthropicKey();
    return envExportArgs(names);
  }
  const values = resolveLegacySecretValues({ anthropicEnabled });
  const names = Object.keys(values);
  if (names.length === 0) {
    if (anthropicEnabled) noAnthropicKey();
    return [];
  }
  log(`note: injecting is unavailable, so ${names.join(', ')} is passed with -e; the value is recorded in the container configuration (0644) and shown by container inspect`);
  const args = legacySecretEnvArgs(values);
  // Pi resolves stored credentials before env keys, so a copied auth.json would shadow
  // ANTHROPIC_API_KEY; entrypoint.sh drops it on request.
  if (names.some((name) => name.startsWith('ANTHROPIC_'))) args.push('-e', 'PIC_EXCLUDE_AUTH=1');
  return args;
}

// Values for the legacy `-e` path: Anthropic keys the way they used to be read, plus the
// models.json "${NAME}" interpolation.
function resolveLegacySecretValues({ anthropicEnabled } = {}) {
  const values = {};
  if (anthropicEnabled) {
    for (const name of anthropicEnvironmentNames) {
      if (process.env[name]) values[name] = process.env[name];
    }
    if (!Object.keys(values).length && process.env.PI_ANTHROPIC_KEY_CMD) {
      const key = runAnthropicKeyCommand(process.env.PI_ANTHROPIC_KEY_CMD);
      if (key) values.ANTHROPIC_API_KEY = key;
    }
  }
  const modelsPath = path.join(home, '.pi', 'agent', 'models.json');
  const envPath = process.env.PI_PROVIDERS_ENV || path.join(home, '.config', 'pi', 'providers.env');
  const modelsText = readTextIfExists(modelsPath);
  if (modelsText !== null) {
    const { values: providerValues, missing } = resolveProviderEnv({
      modelsText,
      processEnv: process.env,
      providersEnvText: readTextIfExists(envPath),
    });
    if (missing.length > 0) log(`warning: ${missing.join(', ')} unset and absent from ${envPath}; those providers send an empty key`);
    Object.assign(values, providerValues);
  }
  return values;
}

// Refresh the ~/.pi snapshot that gets mounted. Runs before every launch, including the reuse
function refreshHostPiSnapshot() {
  if (!hostPiSnapshotEnabled) {
    log(`mounting ${hostPiSourceDir} directly (PIC_HOST_PI_SNAPSHOT=0): transcripts and auth.json will be readable in the container`);
    return { ok: false, skipped: true };
  }
  const result = buildHostPiSnapshot({
    source: hostPiSourceDir,
    target: hostPiSnapshotDir,
    extraExcludes: hostPiExtraExcludes,
  });
  if (!result.ok) log(`warning: could not refresh ${hostPiSnapshotDir}: ${result.reason}`);
  else if (result.warning) log(`note: ${result.warning}`);
  if (result.ok && verbose) log(`host pi snapshot: ${hostPiSnapshotDir} (${result.via})`);
  return result;
}

// The mounts a launch needs: the snapshot at /host-pi, plus npm and git bound directly (they
// are node_modules and checkouts, so copying them into the snapshot would be slow and pointless).
function hostPiMountArgsForRun() {
  const agentDir = path.join(hostPiSourceDir, 'agent');
  let snapshotDir = null;
  if (hostPiSnapshotEnabled) {
    if (!fs.existsSync(hostPiSourceDir)) {
      // Nothing to share: pi works without ~/.pi (no providers, no settings), and the
      // entrypoint checks for /host-pi before copying.
      log(`note: no ${hostPiSourceDir} to share; the container starts with an empty pi configuration`);
      return [];
    }
    const result = refreshHostPiSnapshot();
    const hasContent = () => {
      try {
        return fs.readdirSync(hostPiSnapshotDir).length > 0;
      } catch {
        return false;
      }
    };
    if (!result.ok && !hasContent()) {
      throw new Error(
        `cannot build the ${hostPiSnapshotDir} snapshot (${result.reason}). ` +
          'Refusing to mount ~/.pi instead: that would expose agent/sessions and agent/auth.json. ' +
          'Set PIC_HOST_PI_SNAPSHOT=0 to opt into the old behaviour.',
      );
    }
    if (!result.ok) log('note: using the previous snapshot; it may be stale');
    snapshotDir = hostPiSnapshotDir;
  }
  return hostPiMountArgs({
    snapshotDir,
    source: snapshotDir ? null : hostPiSourceDir,
    npmSource: path.join(agentDir, 'npm'),
    gitSource: path.join(agentDir, 'git'),
  });
}

function providerKeysMountArgs({ inject = false } = {}) {
  if (providerKeysTransport === 'off') return [];
  if (inject) return tmpfsMountArgs({ containerDir: providerKeysContainerDir });
  return keysMountArgs({ keysDir: providerKeysHostDir, containerDir: providerKeysContainerDir });
}

// Inside the container the same models.json line reads $PI_KEY_DIR/<provider> instead of
// reaching for a secret manager that cannot run there. The gate is only asked for when this
// launcher injects the keys, otherwise pi would wait for a marker nobody writes.
function providerKeysEnvArgs({ inject = false } = {}) {
  const args = keysEnvArgs({
    keysDir: providerKeysHostDir,
    containerDir: providerKeysContainerDir,
    transport: providerKeysTransport,
  });
  return inject ? [...args, ...keysGateArgs({ waitSeconds: providerKeysWaitSeconds })] : args;
}

// Run alongside `container run`: waits for the container, pipes each key into the tmpfs
// through `container exec -i` stdin, then releases the entrypoint gate. Values never reach
// argv or a file. The child is detached so the interactive container keeps its terminal.
let providerKeyInjectorLog = null;

function spawnProviderKeyInjector(target) {
  if (!target) return;
  const args = [
    path.join(__dirname, 'pic-keys-inject.cjs'),
    target,
    // The injector's clock starts before `container run`, so its budget has to cover image
    // unpacking and VM boot as well; --gate tells it when the entrypoint gives up, which is the
    // deadline for reading keys.
    '--wait',
    String(providerKeysWaitSeconds + 180),
    '--gate',
    String(providerKeysWaitSeconds),
  ];
  let stdio = 'inherit';
  if (verbose !== true && process.env.PIC_KEYS_VERBOSE !== '1') {
    // Pi owns the terminal from here on: a message printed over its TUI corrupts the screen,
    // so the injector writes to a log that is reported after Pi exits.
    providerKeyInjectorLog = path.join(os.tmpdir(), `${commandName}-keys-${target}.log`);
    const fd = fs.openSync(providerKeyInjectorLog, 'w', 0o600);
    stdio = ['ignore', fd, fd];
  }
  const child = spawn(process.execPath, args, {
    detached: true,
    stdio,
    // Names, never values: the injector resolves the values itself and pipes them in.
    env: { ...process.env, PIC_ENV_EXPORT: secretNamesFor({ anthropicEnabled }).join(','), PIC_ANTHROPIC: anthropicEnabled ? '1' : '0' },
  });
  child.on('error', (error) => log(`warning: could not start the key injector: ${error.message}`));
  child.unref();
}

function reportProviderKeyInjector() {
  if (!providerKeyInjectorLog) return;
  let text = '';
  try {
    text = fs.readFileSync(providerKeyInjectorLog, 'utf8');
  } catch {
    return;
  }
  for (const line of text.split('\n')) if (line.trim()) console.error(line.trim());
}

// A `!…` apiKey needs either the host key file or a host that can run its command. In tmpfs
// mode pic reads it live at launch, so a missing file is normal; in bind mode the provider
// would silently vanish from /model, so warn before launching.
// Ask every provider key command once, before anything is started. A deterministic host-side
// failure (no op session in this shell, op refusing to run outside a GUI login session, wrong
// URI) would otherwise surface only after proxy-chain is listening, the container is created and
// the entrypoint gate has counted down: a minute of silence with the real reason in a log file
// nobody reads, because the injector cannot write to a terminal pi is about to own.
//
// Values are measured and dropped; the launcher keeps nothing. The injector reads again later
// (a secret manager read costs a few requests, which is cheaper than holding a secret here), and
// a slow manager is still worth waiting for: that is what the entrypoint gate is for.
function preflightProviderKeys() {
  if (attachMode || !shouldInjectSecrets({ anthropicEnabled })) return;
  if (process.env.PIC_KEYS_REQUIRED === '0') return;
  const modelsText = providerModelsText();
  if (!modelsText) return;
  const providerIds = commandKeyProviderIds(modelsText);
  if (providerIds.length === 0) return;

  const failures = [];
  let usable = 0;
  for (const providerId of providerIds) {
    const { value, reason } = resolveKeyCommandValue({ apiKey: providerKeyCommand(modelsText, providerId) });
    if (value) {
      usable += 1;
      continue;
    }
    failures.push({ providerId, reason, uri: keyCommandUri(modelsText, providerId) });
  }

  if (usable > 0) {
    for (const failure of failures) log(`warning: ${failure.providerId} will be unavailable in the container: ${failure.reason}`);
    return;
  }

  const first = failures[0] || {};
  console.error(
    `[${commandName}] no provider credential; the session would fail on your first message.\n` +
      `  provider : ${failures.map((failure) => failure.providerId).join(', ') || '(none configured)'}\n` +
      `  cause    : ${first.reason || 'unknown'}${first.uri ? `\n  secret   : ${first.uri}` : ''}\n` +
      `  fix      : ${credentialAdvice(first.reason)}\n` +
      `  note     : nothing was started (no proxy, no container). Start anyway with: PIC_KEYS_REQUIRED=0 ${commandName} ...`,
  );
  process.exit(1);
}

function warnMissingProviderKeys() {
  const modelsText = providerModelsText();
  if (!modelsText) return;
  const missing = missingCommandKeys({ modelsText, keysDir: providerKeysHostDir });
  if (missing.length === 0) return;
  if (providerKeysTransport === 'tmpfs') {
    log(`provider keys read live at launch: ${missing.map((entry) => entry.providerId).join(', ')}`);
    return;
  }
  for (const { providerId, target, uri } of missing) {
    log(`warning: ${target} is missing, so ${providerId} resolves only where its apiKey command can run`);
    if (uri) log(`         live read: ${uri} (pic-keys ${providerId} writes the key file)`);
  }
}

// The models.json text, or '' when there is none.
function providerModelsText() {
  return readTextIfExists(path.join(home || '', '.pi', 'agent', 'models.json')) || '';
}

// A provider behind a host-only tunnel (WireGuard, Tailscale, any utun) is reachable from
// this host and unreachable from a container: the VM's packets keep the VM's source address
// and macOS does not SNAT into a utun, so the peer drops them. Pi's 10s connect timeout then
// looks like a bad credential, so name the real cause before the session starts.
async function warnUnreachableProviders() {
  if (proxyEnabled) return; // already dialing from the host, which owns the tunnel
  for (const entry of tunnelOnlyHosts(providerModelsText())) {
    if (await tcpReachable({ host: entry.host, port: entry.port })) {
      log(tunnelWarning(entry, commandName));
    } else {
      log(`warning: ${entry.host}:${entry.port} is unreachable from this host too (providers: ${entry.providers.join(', ')})`);
    }
  }
}

function herdrEnvironmentArgs() {
  const args = [];
  for (const name of herdrEnvironmentNames) {
    const value = process.env[name];
    if (value !== undefined) args.push('-e', `${name}=${value}`);
  }
  if (herdrBridgeEnabled) {
    args.push('-e', `HERDR_SOCKET_PATH=${herdrBridgeSocketPath}`);
  } else if (herdrSocketContainerPath) {
    args.push('-e', `HERDR_SOCKET_PATH=${herdrSocketContainerPath}`);
  } else if (process.env.HERDR_SOCKET_PATH && herdrSocketMountEnabled) {
    args.push('-e', `HERDR_SOCKET_PATH=${process.env.HERDR_SOCKET_PATH}`);
  }
  return args;
}

function herdrBridgeEnvironmentArgs(herdrBridge) {
  if (!herdrBridge.started) return [];
  return [
    '-e', 'PIC_HERDR_BRIDGE=1',
    '-e', `PIC_HERDR_BRIDGE_HOST=${herdrBridgeHost}`,
    '-e', `PIC_HERDR_BRIDGE_PORT=${herdrBridge.port}`,
  ];
}

function herdrSocketVolumeArgs() {
  if (!herdrSocketMountEnabled || !herdrSocketDir) return [];
  return ['--volume', `${herdrSocketDir}:${herdrSocketMountTarget}`];
}

function log(message) {
  console.log(`[${commandName}] ${message}`);
}

// Pi keeps the first skill it sees on a name clash, so later sources skip taken names.
function stagedSkillNames() {
  return new Set(fs.readdirSync(stagedHostSkillsDir));
}

function stageSkillsFrom(sourceDir) {
  if (!fs.existsSync(sourceDir)) return;
  const taken = stagedSkillNames();
  for (const name of fs.readdirSync(sourceDir)) {
    if (taken.has(name)) continue;
    const source = path.join(sourceDir, name);
    if (!fs.existsSync(path.join(source, 'SKILL.md'))) {
      if (fs.lstatSync(source).isSymbolicLink()) log(`warning: skipping host skill "${name}" because its symlink target is unavailable`);
      continue;
    }

    try {
      fs.cpSync(source, path.join(stagedHostSkillsDir, name), {
        recursive: true,
        dereference: true,
        force: true,
      });
    } catch (error) {
      log(`warning: failed to stage host skill "${name}": ${error.message}`);
    }
  }
}

function stageHostSkills() {
  const agentDir = path.join(home, '.pi', 'agent');
  fs.rmSync(stagedHostSkillsDir, { recursive: true, force: true });
  fs.mkdirSync(stagedHostSkillsDir, { recursive: true });
  stageSkillsFrom(path.join(agentDir, 'skills'));
  // Skills-manager installs land in ~/.agents/skills, which the container cannot see.
  stageSkillsFrom(path.join(home, '.agents', 'skills'));
  stagePackageResources(agentDir, stagedHostSkillsDir, 'skills', log);
}

function stageHostExtensions() {
  const agentDir = path.join(home, '.pi', 'agent');
  const sourceDir = path.join(agentDir, 'extensions');
  fs.rmSync(stagedHostExtensionsDir, { recursive: true, force: true });
  fs.mkdirSync(stagedHostExtensionsDir, { recursive: true });
  for (const name of fs.existsSync(sourceDir) ? fs.readdirSync(sourceDir) : []) {
    const source = path.join(sourceDir, name);
    try {
      fs.cpSync(source, path.join(stagedHostExtensionsDir, name), { recursive: true, dereference: true, force: true });
    } catch (error) {
      log(`warning: failed to stage host extension "${name}": ${error.message}`);
    }
  }
  stagePackageResources(agentDir, stagedHostExtensionsDir, 'extensions', log);
}

function maybeRenameHerdrAgent() {
  if (process.env.PIC_HERDR_RENAME === '0') return;
  if (process.env.HERDR_ENV !== '1' || !process.env.HERDR_PANE_ID) return;
  const name = process.env.PIC_HERDR_NAME || dirBasename;
  if (!name) return;
  const herdrBin = process.env.HERDR_BIN_PATH || 'herdr';
  const result = spawnSync(herdrBin, ['agent', 'rename', process.env.HERDR_PANE_ID, name], {
    stdio: verbose ? 'inherit' : 'ignore',
  });
  if (verbose && result.status !== 0) {
    log(`warning: failed to rename Herdr agent ${process.env.HERDR_PANE_ID} to "${name}"`);
  }
}
async function startProxy() {
  return startProxyWithFallback({ host, port, proxyUrl, verbose, log, logPrefix: commandName });
}

function startHerdrHostBridge() {
  if (!herdrBridgeEnabled) return Promise.resolve({ server: null, started: false, port: null });
  if (!herdrSocketPath) throw new Error('PIC_HERDR_BRIDGE=1 requires HERDR_SOCKET_PATH to be set by Herdr');

  return new Promise((resolve, reject) => {
    const sockets = new Set();
    const server = net.createServer((tcpSocket) => {
      const unixSocket = net.connect({ path: herdrSocketPath });
      sockets.add(tcpSocket);
      sockets.add(unixSocket);
      tcpSocket.pipe(unixSocket);
      unixSocket.pipe(tcpSocket);

      const closeBoth = () => {
        sockets.delete(tcpSocket);
        sockets.delete(unixSocket);
        tcpSocket.destroy();
        unixSocket.destroy();
      };
      tcpSocket.on('error', closeBoth);
      unixSocket.on('error', closeBoth);
      tcpSocket.on('close', closeBoth);
      unixSocket.on('close', closeBoth);
    });

    const listen = (listenHost, advertisedHost = herdrBridgeHost) => {
      server.listen(herdrBridgeRequestedPort, listenHost, () => {
        server.removeAllListeners('error');
        const address = server.address();
        const actualPort = typeof address === 'object' && address ? address.port : herdrBridgeRequestedPort;
        const suffix = listenHost === advertisedHost ? '' : ` (advertised to container as ${advertisedHost}:${actualPort})`;
        log(`Herdr bridge listening on ${listenHost}:${actualPort} -> ${herdrSocketPath}${suffix}`);
        resolve({ server, sockets, started: true, port: actualPort });
      });
    };

    server.once('error', (error) => {
      if (error && error.code === 'EADDRNOTAVAIL' && herdrBridgeHost !== '0.0.0.0') {
        log(`Herdr bridge address ${herdrBridgeHost} is not available, falling back to 0.0.0.0`);
        listen('0.0.0.0', herdrBridgeHost);
      } else {
        reject(error);
      }
    });

    listen(herdrBridgeHost);
  });
}

function stopServer(server, sockets = new Set()) {
  for (const socket of sockets) socket.destroy();
  return new Promise((resolve) => server.close(() => resolve()));
}

function interactiveContainerArgs() {
  return process.stdin.isTTY && process.stdout.isTTY ? ['-it'] : [];
}

function warnIgnoredRunOnlyArgs(containerId) {
  if (extraVolumes.length > 0) {
    log(`warning: extra --volume arguments are ignored when reusing container "${containerId}"`);
  }
  if (extraPublish.length > 0) {
    log(`warning: extra --publish arguments are ignored when reusing container "${containerId}"`);
  }
}

function containerExecArgs(containerId, commandArgs, { envArgs = [] } = {}) {
  return [
    'exec',
    ...interactiveContainerArgs(),
    '-w', workspaceTarget,
    ...envArgs,
    containerId,
    ...commandArgs,
  ];
}

function containerRunArgs(commandArgs, { envArgs = [], includeHerdrSocket = false, injectKeys = false, containerName } = {}) {
  return [
    'run', '--rm', ...interactiveContainerArgs(), '--memory', '4g',
    // A stable name lets pic-keys-inject.cjs address the container while it still boots.
    ...(containerName ? ['--name', containerName] : []),
    '--volume', `${workdir}:${workspaceTarget}`,
    '--mount', `type=volume,source=${nodeModulesVolume},target=${workspaceTarget}/node_modules`,
    ...extraVolumes.flatMap(v => ['--volume', v]),
    ...(includeHerdrSocket ? herdrSocketVolumeArgs() : []),
    ...extraPublish.flatMap(p => ['--publish', p]),
    // A filtered snapshot of ~/.pi, never ~/.pi itself: see host-pi-tree.cjs.
    ...hostPiMountArgsForRun(),
    ...providerKeysMountArgs({ inject: injectKeys }),
    '--dns', '1.1.1.1',
    ...envArgs,
    '-w', workspaceTarget,
    'agentic-coding-node:24',
    ...commandArgs,
  ];
}

function containerRunPiCommand(piArgs) {
  return ['pi', ...piArgs];
}

function containerExecPiCommand(piArgs) {
  return ['entrypoint', 'pi', ...piArgs];
}

function listContainersJson() {
  return listContainersJsonWithRecovery({ log });
}

function refreshContainerExtensions(containerId) {
  const staged = fs.existsSync(stagedHostExtensionsDir) ? fs.readdirSync(stagedHostExtensionsDir) : [];
  if (staged.length === 0) return true;
  const source = `${workspaceTarget}/.pi/host-agent-extensions`;
  const command = `mkdir -p /root/.pi/agent/extensions && cp -aL ${source}/. /root/.pi/agent/extensions/`;
  const result = spawnSync('container', ['exec', containerId, 'sh', '-lc', command], { stdio: verbose ? 'inherit' : 'pipe', encoding: 'utf8' });
  if (result.status !== 0) {
    log(`container "${containerId}" failed to refresh staged extensions; it will not be reused`);
    return false;
  }
  log(`refreshed ${staged.length} staged extension(s) in reused container "${containerId}"`);
  return true;
}
// Check if a running container already has workdir mounted as a virtiofs share
function findContainerWithMount(workdirPath) {
  // Normalize the workdir path for comparison
  const normalizedWorkdir = path.resolve(workdirPath);

  log(`checking for running container with mount source "${normalizedWorkdir}"`);

  const listResult = listContainersJson();

  if (listResult.status !== 0) {
    log(`container list failed (exit ${listResult.status}), will start a new container`);
    return null;
  }

  let containers;
  try {
    containers = JSON.parse(listResult.stdout);
    if (!Array.isArray(containers)) {
      // Single object when only one container
      containers = [containers];
    }
  } catch {
    log('failed to parse container list output, will start a new container');
    return null;
  }

  for (const container of containers) {
    const containerId = container.configuration?.id;
    if (!containerId) continue;

    // Inspect this container to get full mount details
    const inspectResult = spawnSync('container', ['inspect', containerId], {
      stdio: ['ignore', 'pipe', 'inherit'],
      encoding: 'utf-8',
    });

    if (inspectResult.status !== 0) continue;

    let detail;
    try {
      detail = JSON.parse(inspectResult.stdout);
      // inspect returns an array (one element per container)
      const items = Array.isArray(detail) ? detail : [detail];
      for (const item of items) {
        if (!item.configuration) continue;
        const image = item.configuration.image;
        const imageName = typeof image === 'string'
          ? image
          : image?.reference || image?.descriptor?.annotations?.['com.apple.containerization.image.name'] || '';
        if (!imageName.includes('agentic-coding')) {
          log(`container "${containerId}" uses image "${imageName || 'unknown'}", will not reuse`);
          continue;
        }
        let hasWorkdirMount = false;
        let hasPiConfigMount = false;
        let hasNodeModulesMount = false;
        let hasHerdrSocketMount = !herdrSocketDir;
        for (const mount of item.configuration.mounts || []) {
          const mountTarget = mount.target || mount.destination || mount.mountpoint || mount.mountPoint;
          const mountSourcePath = mount.source ? path.resolve(mount.source) : '';
          const mountSourceName = String(mount.type?.volume?.name || mount.name || mount.source || '');
          if (mount.type === 'virtiofs' || mount.type?.virtiofs !== undefined) {
            if (mountSourcePath === normalizedWorkdir && mountTarget === workspaceTarget) {
              hasWorkdirMount = true;
            }
            // Same source the launch uses (containerMountArgs): the filtered snapshot, or
            // ~/.pi only when PIC_HOST_PI_SNAPSHOT=0. Containers from before 719f0e3 mounted
            // ~/.pi here and must stay non-reusable; that is the leak this removes.
            if (mountSourcePath === path.resolve(hostPiSnapshotEnabled ? hostPiSnapshotDir : path.join(home, '.pi')) && mountTarget === '/host-pi') {
              hasPiConfigMount = true;
            }
          }
            if (herdrSocketDir && mountSourcePath === path.resolve(herdrSocketDir) && mountTarget === herdrSocketMountTarget) {
              hasHerdrSocketMount = true;
            }
          if (mountTarget === `${workspaceTarget}/node_modules` && mountSourceName.includes(nodeModulesVolume)) {
            hasNodeModulesMount = true;
          }
        }
        if (hasWorkdirMount && hasPiConfigMount && hasNodeModulesMount && hasHerdrSocketMount) {
          if (!refreshContainerExtensions(containerId)) {
            spawnSync('container', ['stop', containerId], { stdio: verbose ? 'inherit' : 'ignore' });
            continue;
          }
          log(`found compatible running container "${containerId}" with ${workspaceTarget} mounted`);
          return containerId;
        }
        if (hasWorkdirMount) {
          log(`container "${containerId}" has the workdir mounted but is missing current Pi config/node_modules/Herdr socket mounts; will not reuse`);
        }
      }
    } catch (error) {
      log(`failed to inspect container "${containerId}": ${error?.message || error}`);
      continue;
    }
  }

  return null;
}

async function main() {
  if (!home) throw new Error('HOME is not set');

  fs.mkdirSync(path.join(workdir, '.pi', 'agent', 'sessions'), { recursive: true });
  warnMissingProviderKeys();
  const injectKeys = shouldInjectSecrets({ anthropicEnabled });
  preflightProviderKeys();
  await warnUnreachableProviders();
  stageHostSkills();
  stageHostExtensions();

  maybeRenameHerdrAgent();

  // Check if a container is already running with our workdir mounted
  const existingContainerId = findContainerWithMount(workdir);

  if (existingContainerId) {
    // Volume is already created by the existing container — skip creation
    log(`reusing container "${existingContainerId}" via exec`);
  } else {
    spawnSync('container', ['volume', 'create', nodeModulesVolume], { stdio: verbose ? 'inherit' : 'ignore' });
  }

  const proxy = proxyEnabled
    ? await startProxy()
    : { server: null, started: false };
  const herdrBridge = await startHerdrHostBridge();
  if (!proxyEnabled) log('proxy disabled; clearing proxy environment for the Pi process');
  let cleanedUp = false;

  async function cleanup() {
    if (cleanedUp) return;
    cleanedUp = true;
    if (proxy.started && proxy.server) {
      log('stopping proxy-chain');
      await proxy.server.close(true);
    }
    if (herdrBridge.started && herdrBridge.server) {
      log('stopping Herdr bridge');
      await stopServer(herdrBridge.server, herdrBridge.sockets);
    }
    // Key-injector messages cannot be printed while the TUI owns the terminal, so they are
    // collected in a log and reported once Pi is gone.
    reportProviderKeyInjector();
  }

  const keysTarget = existingContainerId || containerNameFor({ prefix: commandName, volumeSuffix });

  if (attachMode) {
    const shellArgs = extraPiArgs.length > 0 ? extraPiArgs : ['/bin/bash'];
    const envArgs = [
      ...proxyEnvironmentArgs(),
      ...secretArgsForLaunch({ anthropicEnabled, injectSecrets: injectKeys }),
      ...providerKeysEnvArgs({ inject: injectKeys }),
    ];

    if (existingContainerId) {
      warnIgnoredRunOnlyArgs(existingContainerId);
      if (injectKeys) spawnProviderKeyInjector(keysTarget);
      const args = containerExecArgs(existingContainerId, shellArgs, { envArgs });

      log(`attach: container exec ${existingContainerId} ${shellArgs.join(' ')}`);
      runChildProcess('container', args, { cleanup });
      return;
    }

    const args = containerRunArgs(shellArgs, { envArgs, injectKeys, containerName: keysTarget });

    log(`attach: starting shell in new container at ${workspaceTarget}`);
    if (injectKeys) spawnProviderKeyInjector(keysTarget);
    runChildProcess('container', args, { cleanup });
    return;
  }

  // Build the pi args (same for both run and exec)
  const piArgs = [
    '--session-dir', sessionDir,
    ...extraPiArgs,
  ];

  if (existingContainerId) {
    // Warn if extra volumes/publish were requested — they can't be applied via exec
    warnIgnoredRunOnlyArgs(existingContainerId);

    const commandArgs = containerExecPiCommand(piArgs);
    const args = containerExecArgs(existingContainerId, commandArgs, {
      envArgs: [
        ...proxyEnvironmentArgs(),
        ...secretArgsForLaunch({ anthropicEnabled, injectSecrets: injectKeys }),
        ...providerKeysEnvArgs({ inject: injectKeys }),
        ...herdrEnvironmentArgs(),
        ...herdrBridgeEnvironmentArgs(herdrBridge),
      ],
    });

    log(`exec: container ${args.slice(1, -piArgs.length - 1).join(' ')} ... pi --session-dir ...`);
    if (injectKeys) spawnProviderKeyInjector(keysTarget);
    runChildProcess('container', args, { cleanup });
  } else {
    const args = containerRunArgs(containerRunPiCommand(piArgs), {
      includeHerdrSocket: true,
      injectKeys,
      containerName: keysTarget,
      envArgs: [
        ...proxyEnvironmentArgs(),
        ...secretArgsForLaunch({ anthropicEnabled, injectSecrets: injectKeys }),
        ...providerKeysEnvArgs({ inject: injectKeys }),
        ...herdrEnvironmentArgs(),
        ...herdrBridgeEnvironmentArgs(herdrBridge),
      ],
    });

    if (injectKeys) spawnProviderKeyInjector(keysTarget);
    runChildProcess('container', args, { cleanup });
  }
}

main().catch((error) => {
  console.error(`[${commandName}] ${error.stack || error.message || error}`);
  process.exit(1);
});
