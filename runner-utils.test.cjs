// Tests are table-first: these arrays are exactly what `container run` receives.

const test = require('node:test');
const assert = require('node:assert');
const { proxyEnvironmentArgs, proxyEnvironmentNames } = require('./runner-utils.cjs');

test('enabled exports every spelling plus the undici preload', () => {
  const args = proxyEnvironmentArgs('http://192.168.64.1:8888', { enabled: true, env: {} });
  for (const name of proxyEnvironmentNames) {
    assert.ok(args.includes('-e'), name);
    assert.ok(args.includes(`${name}=http://192.168.64.1:8888`), name);
  }
  assert.ok(args.some((arg) => arg.startsWith('NODE_OPTIONS=--import=')), 'undici proxy preload');
});

test('disabled clears only what the caller exported', () => {
  assert.deepStrictEqual(proxyEnvironmentArgs('http://h:1', { enabled: false, env: {} }), []);
  const args = proxyEnvironmentArgs('http://h:1', { enabled: false, env: { HTTPS_PROXY: 'http://old:1', http_proxy: 'http://old:2' } });
  assert.deepStrictEqual(args, ['-e', 'HTTPS_PROXY=', '-e', 'http_proxy=']);
});
