const assert = require('node:assert/strict');
const { test } = require('node:test');
const http = require('node:http');
const net = require('node:net');
const { isLoopbackAddress, proxyRequestPolicy } = require('./proxy-access-policy.cjs');
const { startProxy } = require('./runner-utils.cjs');
const { assertNoLegacyProxy } = require('./chrome-agent-browser.cjs');

test('loopback aliases and DNS results cannot use the proxy', async () => {
  for (const address of ['127.0.0.1', '127.12.34.56', '::1', '::ffff:7f00:1', '0.0.0.0']) {
    assert.equal(isLoopbackAddress(address), true, address);
  }
  for (const hostname of ['localhost', 'localhost.', 'sub.localhost', '127.0.0.1', '2130706433', '::ffff:7f00:1']) {
    await assert.rejects(proxyRequestPolicy({ hostname }), error => error.statusCode === 403);
  }
  await assert.rejects(proxyRequestPolicy({ hostname: 'public.test', port: 9222 }, {
    lookup: async () => [{ address: '8.8.8.8', family: 4 }],
  }), error => error.statusCode === 403);
  await assert.rejects(proxyRequestPolicy({ hostname: 'rebind.test' }, {
    lookup: async () => [{ address: '127.0.0.1', family: 4 }],
  }), error => error.statusCode === 403);
  assert.deepEqual(await proxyRequestPolicy({ hostname: 'remote.test' }, {
    lookup: async () => [{ address: '8.8.8.8', family: 4 }],
  }), {});
});

test('protected proxy refuses HTTP and CONNECT to Chrome CDP', async () => {
  const proxy = await startProxy({ host: '127.0.0.1', port: 0, log: () => {} });
  try {
    assert.ok(proxy.url.includes(`:${proxy.server.port}`));
    const response = await new Promise((resolve, reject) => {
      http.get({ hostname: '127.0.0.1', port: proxy.server.port,
        path: 'http://127.0.0.1:9222/json/version' }, res => {
        res.resume();
        resolve(res);
      }).on('error', reject);
    });
    assert.equal(response.statusCode, 403);
    const statusLine = await new Promise((resolve, reject) => {
      const socket = net.connect(proxy.server.port, '127.0.0.1');
      socket.on('connect', () => socket.write('CONNECT 127.0.0.1:9222 HTTP/1.1\r\nHost: 127.0.0.1:9222\r\n\r\n'));
      socket.once('data', data => { resolve(data.toString().split('\r\n')[0]); socket.destroy(); });
      socket.once('error', reject);
    });
    assert.match(statusLine, /403/);
  } finally {
    await proxy.server.close(true);
  }
});

test('proxy refuses an occupied port and Chrome Agent rejects an old shared proxy', async () => {
  const occupied = net.createServer();
  await new Promise(resolve => occupied.listen(0, '127.0.0.1', resolve));
  try {
    await assert.rejects(startProxy({ host: '127.0.0.1', port: occupied.address().port, log: () => {} }), /Refusing to reuse/);
  } finally {
    await new Promise(resolve => occupied.close(resolve));
  }
  assert.throws(() => assertNoLegacyProxy({ run: () => ({ status: 0, stdout: 'p12345\n' }) }), /Old shared proxy/);
  assert.doesNotThrow(() => assertNoLegacyProxy({ run: () => ({ status: 1, stdout: '' }) }));
});
