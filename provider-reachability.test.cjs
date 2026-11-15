// Tests are table-first: the shapes here decide what the launcher warns about.

const test = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('node:events');
const {
  isLocalHost,
  providerBaseUrls,
  routeInterface,
  tcpReachable,
  tunnelOnlyHosts,
  tunnelWarning,
} = require('./provider-reachability.cjs');

const modelsText = JSON.stringify({
  providers: {
    'omlx-clanker': { baseUrl: 'http://172.31.221.1:8080/v1' },
    'omlx-other': { baseUrl: 'http://172.31.221.1:8080/v1/extra' },
    cloud: { baseUrl: 'https://api.example.com/v1' },
    local: { baseUrl: 'http://localhost:11434/v1' },
    lan: { baseUrl: 'http://192.168.64.1:8080/v1' },
    noauth: {},
  },
});

const spawnRoute = (table) => (command, args) => {
  const host = args[args.length - 1];
  return table[host] === undefined
    ? { status: 1, stdout: '' }
    : { status: 0, stdout: `route: writing to routing socket: not in table\n   route to host: ${host}\n   interface: ${table[host]}\n` };
};

test('base URLs are parsed once per host, with the port the provider actually uses', () => {
  assert.deepStrictEqual(providerBaseUrls(modelsText), [
    { scheme: 'http', host: '172.31.221.1', port: 8080, providers: ['omlx-clanker', 'omlx-other'] },
    { scheme: 'https', host: 'api.example.com', port: 443, providers: ['cloud'] },
    { scheme: 'http', host: 'localhost', port: 11434, providers: ['local'] },
    { scheme: 'http', host: '192.168.64.1', port: 8080, providers: ['lan'] },
  ]);
  for (const broken of ['', undefined, '{not json', '{"providers":null}']) {
    assert.deepStrictEqual(providerBaseUrls(broken), []);
  }
});

test('localhost and the VM gateway are never treated as remote', () => {
  for (const host of ['localhost', 'pi.local', '127.0.0.1', '::1', '0.0.0.0', '192.168.64.1']) {
    assert.strictEqual(isLocalHost(host), true, host);
  }
  for (const host of ['172.31.221.1', 'api.example.com']) {
    assert.strictEqual(isLocalHost(host), false, host);
  }
});

test('only a tunnel interface makes a host unreachable from the container', () => {
  const table = { '172.31.221.1': 'utun1', 'api.example.com': 'en0' };
  const found = tunnelOnlyHosts(modelsText, { spawn: spawnRoute(table), platform: 'darwin' });
  assert.deepStrictEqual(found, [{ ...providerBaseUrls(modelsText)[0], iface: 'utun1' }]);

  // No route, a physical interface, or a non-macOS host: nothing to warn about.
  assert.deepStrictEqual(tunnelOnlyHosts(modelsText, { spawn: spawnRoute({}), platform: 'darwin' }), []);
  assert.deepStrictEqual(
    tunnelOnlyHosts(modelsText, { spawn: spawnRoute({ '172.31.221.1': 'en0' }), platform: 'darwin' }),
    [],
  );
  assert.deepStrictEqual(tunnelOnlyHosts(modelsText, { spawn: spawnRoute(table), platform: 'linux' }), []);
  assert.strictEqual(routeInterface('172.31.221.1', { spawn: spawnRoute(table), platform: 'darwin' }), 'utun1');
  assert.strictEqual(routeInterface('nowhere', { spawn: spawnRoute(table), platform: 'darwin' }), null);
});

test('the warning names the cause, the providers, and the fix', () => {
  const entry = { ...providerBaseUrls(modelsText)[0], iface: 'utun1' };
  const text = tunnelWarning(entry, 'pic');
  assert.match(text, /utun1/);
  assert.match(text, /172\.31\.221\.1/);
  assert.match(text, /omlx-clanker, omlx-other/);
  assert.match(text, /pic --proxy/);
  // An already-proxying command should still be told the mechanism, not left guessing.
  assert.match(tunnelWarning(entry, 'pic-proxy'), /--proxy/);
});

test('tcpReachable resolves rather than rejecting, on success, timeout and error', async () => {
  const connectOk = (options, onConnect) => {
    const socket = new EventEmitter();
    socket.destroy = () => {};
    setImmediate(onConnect);
    return socket;
  };
  const connectTimeout = (options, onConnect) => {
    const socket = new EventEmitter();
    socket.destroy = () => {};
    setImmediate(() => socket.emit('timeout'));
    return socket;
  };
  const connectError = (options, onConnect) => {
    const socket = new EventEmitter();
    socket.destroy = () => {};
    setImmediate(() => socket.emit('error', new Error('econnrefused')));
    return socket;
  };
  assert.strictEqual(await tcpReachable({ host: 'h', port: 1, connect: connectOk }), true);
  assert.strictEqual(await tcpReachable({ host: 'h', port: 1, connect: connectTimeout }), false);
  assert.strictEqual(await tcpReachable({ host: 'h', port: 1, connect: connectError }), false);
});
