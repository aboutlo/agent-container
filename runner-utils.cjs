const { spawn } = require('node:child_process');
const ProxyChain = require('proxy-chain');
const { proxyRequestPolicy } = require('./proxy-access-policy.cjs');

const proxyEnvironmentNames = ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy'];

const piPackageJsonPath = '/usr/local/lib/node_modules/@earendil-works/pi-coding-agent/package.json';
const nodeProxyPreloadSource = [
  'import { createRequire } from "node:module";',
  `const require = createRequire(${JSON.stringify(piPackageJsonPath)});`,
  'const { setGlobalDispatcher, EnvHttpProxyAgent } = require("undici");',
  'setGlobalDispatcher(new EnvHttpProxyAgent());',
].join('');
const nodeProxyPreloadImport = `--import=data:text/javascript,${encodeURIComponent(nodeProxyPreloadSource)}`;

function parseContainerRunnerArgs(cliArgs, { booleanFlags = [], valueFlags = [], optionalValueFlags = [] } = {}) {
  const flags = Object.fromEntries([...booleanFlags, ...optionalValueFlags].map(flag => [flag, false]));
  const extraVolumes = [];
  const extraPublish = [];
  const passthroughArgs = [];

  for (let i = 0; i < cliArgs.length; i += 1) {
    const arg = cliArgs[i];
    if (optionalValueFlags.includes(arg)) {
      // One bare word is a profile name. Use `--` before a one-word Pi prompt.
      const next = cliArgs[i + 1];
      flags[arg] = next && next !== 'attach' && !next.startsWith('-') && !/\s/.test(next)
        ? cliArgs[++i] : true;
    } else if (optionalValueFlags.some(flag => arg.startsWith(`${flag}=`))) {
      const flag = optionalValueFlags.find(name => arg.startsWith(`${name}=`));
      flags[flag] = arg.slice(flag.length + 1);
      if (!flags[flag]) throw new Error(`${flag} requires a value after =`);
    } else if (booleanFlags.includes(arg)) {
      flags[arg] = true;
    } else if (valueFlags.includes(arg)) {
      if (!cliArgs[i + 1] || cliArgs[i + 1].startsWith('-')) throw new Error(`${arg} requires a value`);
      flags[arg] = cliArgs[++i];
    } else if (valueFlags.some(flag => arg.startsWith(`${flag}=`))) {
      const flag = valueFlags.find(name => arg.startsWith(`${name}=`));
      flags[flag] = arg.slice(flag.length + 1);
      if (!flags[flag]) throw new Error(`${flag} requires a value`);
    } else if ((arg === '--volume' || arg === '-v') && i + 1 < cliArgs.length) {
      extraVolumes.push(cliArgs[i + 1]);
      i += 1;
    } else if (arg.startsWith('--volume=')) {
      extraVolumes.push(arg.slice(9));
    } else if ((arg === '--publish' || arg === '-p') && i + 1 < cliArgs.length) {
      extraPublish.push(cliArgs[i + 1]);
      i += 1;
    } else if (arg.startsWith('--publish=')) {
      extraPublish.push(arg.slice(10));
    } else if (arg.startsWith('-p') && arg.length > 2) {
      extraPublish.push(arg.slice(2));
    } else {
      passthroughArgs.push(arg);
    }
  }

  return { flags, extraVolumes, extraPublish, passthroughArgs };
}

function proxyEnvironmentArgs(proxyUrl, { enabled = true } = {}) {
  const value = enabled ? proxyUrl : '';
  const args = proxyEnvironmentNames.flatMap(name => ['-e', `${name}=${value}`]);
  if (enabled) {
    // The OpenAI Node SDK/undici fetch stack does not automatically honor
    // HTTP_PROXY/http_proxy. Preload an undici EnvHttpProxyAgent so Pi's
    // custom OpenAI-compatible providers can reach host/VPN-only endpoints.
    args.push('-e', `NODE_OPTIONS=${nodeProxyPreloadImport}`);
  }
  return args;
}

async function startProxy({ host, port = 0, verbose = false, log, logPrefix = 'proxy' }) {
  const attachRequestFailedLogger = (server) => {
    server.on('requestFailed', ({ request, error }) => {
      console.error(`[${logPrefix}] request failed ${request?.url || ''}: ${error?.message || error}`);
    });
  };

  const server = new ProxyChain.Server({ host, port, verbose, prepareRequestFunction: proxyRequestPolicy });
  attachRequestFailedLogger(server);
  try {
    await server.listen();
  } catch (error) {
    throw new Error(`Refusing to reuse an unknown proxy on ${host}:${port}: ${error.message}`);
  }
  const url = `http://${host}:${server.port}`;
  log(`protected proxy-chain listening on ${url}`);
  return { server, started: true, url };
}

function runChildProcess(command, args, { cleanup } = {}) {
  const child = spawn(command, args, { stdio: 'inherit' });

  const forwardSignal = (signal) => {
    if (!child.killed) child.kill(signal);
  };
  process.once('SIGINT', () => forwardSignal('SIGINT'));
  process.once('SIGTERM', () => forwardSignal('SIGTERM'));

  child.on('error', async (error) => {
    console.error(`[runner] failed to start ${command}: ${error.message}`);
    if (cleanup) await cleanup();
    process.exit(1);
  });
  child.on('exit', async (code, signal) => {
    if (cleanup) await cleanup();
    if (signal) process.kill(process.pid, signal);
    process.exit(code ?? 0);
  });

  return child;
}

module.exports = {
  nodeProxyPreloadImport,
  parseContainerRunnerArgs,
  proxyEnvironmentArgs,
  proxyEnvironmentNames,
  runChildProcess,
  startProxy,
};
