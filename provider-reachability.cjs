const net = require('node:net');
const { spawnSync } = require('node:child_process');

// Providers whose base URL the container can reach directly, versus those it cannot.
//
// A base URL living behind a host-only tunnel (WireGuard, Tailscale, any utun) is reachable
// from the host and unreachable from a container: the VM's packets keep the VM's source
// address, and macOS does not SNAT into a utun, so the peer drops them and the connect just
// times out 10 seconds into a Pi request. The host-side proxy (pic-proxy / --proxy) dials
// from the host, which owns the tunnel address, so the same request succeeds.
//
// Measured: host 200, container timeout, container through the host proxy 200.

const utunInterface = /^utun\d+$/;

function providerBaseUrls(modelsText) {
  let parsed;
  try {
    parsed = JSON.parse(modelsText);
  } catch {
    return [];
  }
  const providers = parsed && typeof parsed.providers === 'object' && parsed.providers ? parsed.providers : {};
  const urls = new Map();
  for (const [providerId, config] of Object.entries(providers)) {
    const baseUrl = config && typeof config.baseUrl === 'string' ? config.baseUrl : '';
    const match = /^(\w+):\/\/([^/:]+)(?::(\d+))?/.exec(baseUrl);
    if (!match) continue;
    if (!urls.has(match[2])) {
      urls.set(match[2], {
        scheme: match[1],
        host: match[2],
        port: Number(match[3]) || (match[1] === 'https' ? 443 : 80),
        providers: [],
      });
    }
    urls.get(match[2]).providers.push(providerId);
  }
  return [...urls.values()];
}

// Which interface the host would use for this address, or null when unknown/not routable.
function routeInterface(host, { spawn = spawnSync, platform = process.platform } = {}) {
  if (platform !== 'darwin') return null;
  const result = spawn('route', ['-n', 'get', host], { encoding: 'utf8' });
  if (result.status !== 0) return null;
  const match = /interface:\s*(\S+)/.exec(result.stdout || '');
  return match ? match[1] : null;
}

function isLocalHost(host) {
  return host === 'localhost' || host.endsWith('.local') || /^(127\.|::1|0\.0\.0\.0|192\.168\.64\.)/.test(host);
}

function tcpReachable({ host, port = 80, timeoutMs = 800, connect = (opts, cb) => net.connect(opts, cb) }) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (value) => {
      if (done) return;
      done = true;
      resolve(value);
    };
    const socket = connect({ host, port, timeout: timeoutMs }, () => {
      socket.destroy();
      finish(true);
    });
    socket.on('timeout', () => {
      socket.destroy();
      finish(false);
    });
    socket.on('error', () => finish(false));
  });
}

// Hosts that only the host can talk to: routed through a tunnel interface.
function tunnelOnlyHosts(modelsText, { spawn = spawnSync, platform = process.platform } = {}) {
  return providerBaseUrls(modelsText)
    .filter((entry) => !isLocalHost(entry.host))
    .map((entry) => ({ ...entry, iface: routeInterface(entry.host, { spawn, platform }) }))
    .filter((entry) => entry.iface && utunInterface.test(entry.iface));
}

function tunnelWarning(entry, commandName) {
  const proxyCommand = commandName === 'pic' ? 'pic --proxy   (or simply pic-proxy)' : `${commandName} --proxy`;
  // A tunneled provider is not an exception worth repeating on every launch, so say what to
  // change once.
  const alias = commandName === 'pic' ? '\n         if that is your only provider, make it the default: alias pic=\"pic --proxy\"' : '';
  return (
    `warning: ${entry.host} is reachable only through ${entry.iface} on this host, so a container ` +
    `cannot connect to it (the peer sees the VM's address and drops it). Providers affected: ${entry.providers.join(', ')}.`
  ) + `\n         run it through the host-side proxy instead: ${proxyCommand}${alias}`;
}

module.exports = {
  isLocalHost,
  providerBaseUrls,
  routeInterface,
  tcpReachable,
  tunnelOnlyHosts,
  tunnelWarning,
};
