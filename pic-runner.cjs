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
  keysGateArgs,
  keysMountArgs,
  keysTransportDefault,
  missingCommandKeys,
  tmpfsMountArgs,
} = require('./provider-keys.cjs');
const { tcpReachable, tunnelOnlyHosts, tunnelWarning } = require('./provider-reachability.cjs');

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
// Upper bound for the entrypoint's wait for the keys, in seconds. Bounded on purpose: a
// locked vault or a dead injector must not hang the session.
const providerKeysWaitSeconds = Number(process.env.PIC_KEYS_WAIT ?? 25);
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

// Anthropic env keys to forward into the container. The container does not
// inherit the host env, so without this the key never reaches Pi inside.
const anthropicEnvironmentNames = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_OAUTH_TOKEN'];

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

function anthropicEnvironmentArgs({ useAnthropic } = {}) {
  if (!useAnthropic) return [];
  const args = [];
  let any = false;
  for (const name of anthropicEnvironmentNames) {
    const value = process.env[name];
    if (value) {
      args.push('-e', `${name}=${value}`);
      any = true;
    }
  }
  if (!any) {
    const cmd = process.env.PI_ANTHROPIC_KEY_CMD;
    if (cmd) {
      const key = runAnthropicKeyCommand(cmd);
      if (key) {
        args.push('-e', `ANTHROPIC_API_KEY=${key}`);
        any = true;
      } else {
        log('warning: --anthropic requested but PI_ANTHROPIC_KEY_CMD produced no key; using local auth');
      }
    } else {
      log('warning: --anthropic requested but no ANTHROPIC_* key in env and PI_ANTHROPIC_KEY_CMD unset; using local auth');
    }
  }
  // When an Anthropic key is in play, ignore the host's stored auth.json:
  // Pi resolves stored credentials before env keys, so a copied auth.json would
  // shadow ANTHROPIC_API_KEY. entrypoint.sh honors PIC_EXCLUDE_AUTH=1 to skip it.
  if (any) args.push('-e', 'PIC_EXCLUDE_AUTH=1');
  return args;
}

// Support, not the default: a models.json that interpolates "${PI_*_API_KEY}" names is
// resolved (host env, then ~/.config/pi/providers.env) and forwarded as `-e NAME=<value>`.
// Those values are recorded by Apple container in `container inspect` and in a
// world-readable config.json under ~/Library/Application Support, so prefer the file form:
// ~/.config/pi/keys/<provider> plus a "!cat" apiKey command (see pic-keys), which keeps the
// secret off the command line entirely.
// Resolution rules live in provider-env.cjs, which has its own tests.
function providerEnvironmentArgs() {
  const modelsPath = path.join(home, '.pi', 'agent', 'models.json');
  const envPath = process.env.PI_PROVIDERS_ENV || path.join(home, '.config', 'pi', 'providers.env');
  const modelsText = readTextIfExists(modelsPath);
  if (modelsText === null) return [];
  const { values, missing } = resolveProviderEnv({
    modelsText,
    processEnv: process.env,
    providersEnvText: readTextIfExists(envPath),
  });
  if (missing.length > 0) {
    log(`warning: ${missing.join(', ')} unset and absent from ${envPath}; those providers send an empty key`);
  }
  const forwarded = Object.keys(values);
  if (forwarded.length > 0) {
    log(`note: forwarding ${forwarded.join(', ')} with -e; prefer ~/.config/pi/keys/<provider> plus a "!cat" apiKey (see pic-keys) so no key reaches the container command line`);
  }
  return Object.entries(values).flatMap(([name, value]) => ['-e', `${name}=${value}`]);
}

// Providers whose apiKey is `!command` are the only ones needing a key at all.
function providerKeyProviders() {
  const modelsText = readTextIfExists(path.join(home || '', '.pi', 'agent', 'models.json'));
  return commandKeyProviderIds(modelsText || '');
}

// True when this launcher is responsible for putting the keys inside the container itself
// (tmpfs transport). Read-only bind or off means the container reads host files instead.
function shouldInjectProviderKeys() {
  return providerKeysTransport === 'tmpfs' && providerKeyProviders().length > 0;
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
    // unpacking and VM boot as well; the entrypoint's gate only has to cover the write.
    '--wait',
    String(providerKeysWaitSeconds + 180),
  ];
  let stdio = 'inherit';
  if (verbose !== true && process.env.PIC_KEYS_VERBOSE !== '1') {
    // Pi owns the terminal from here on: a message printed over its TUI corrupts the screen,
    // so the injector writes to a log that is reported after Pi exits.
    providerKeyInjectorLog = path.join(os.tmpdir(), `${commandName}-keys-${target}.log`);
    const fd = fs.openSync(providerKeyInjectorLog, 'w');
    stdio = ['ignore', fd, fd];
  }
  const child = spawn(process.execPath, args, { detached: true, stdio });
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

function providerKeysWarningTarget() {
  return shouldInjectProviderKeys() ? 'live read at launch' : providerKeysHostDir;
}

// A `!…` apiKey needs either the host key file or a host that can run its command. In tmpfs
// mode pic reads it live at launch, so a missing file is normal; in bind mode the provider
// would silently vanish from /model, so warn before launching.
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
    '--mount', `type=bind,source=${path.join(home, '.pi')},target=/host-pi,readonly`,
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
            if (mountSourcePath === path.resolve(home, '.pi') && mountTarget === '/host-pi') {
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

  const injectKeys = shouldInjectProviderKeys();
  const keysTarget = existingContainerId || containerNameFor({ prefix: commandName, volumeSuffix });

  if (attachMode) {
    const shellArgs = extraPiArgs.length > 0 ? extraPiArgs : ['/bin/bash'];
    const envArgs = [
      ...proxyEnvironmentArgs(),
      ...anthropicEnvironmentArgs({ useAnthropic: anthropicEnabled }),
      ...providerEnvironmentArgs(),
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
        ...anthropicEnvironmentArgs({ useAnthropic: anthropicEnabled }),
        ...providerEnvironmentArgs(),
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
        ...anthropicEnvironmentArgs({ useAnthropic: anthropicEnabled }),
        ...providerEnvironmentArgs(),
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
