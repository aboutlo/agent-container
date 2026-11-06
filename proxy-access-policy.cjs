const dns = require('node:dns').promises;
const net = require('node:net');
const ProxyChain = require('proxy-chain');

const loopback = new net.BlockList();
loopback.addSubnet('127.0.0.0', 8, 'ipv4');
loopback.addAddress('0.0.0.0', 'ipv4');
loopback.addAddress('::', 'ipv6');
loopback.addAddress('::1', 'ipv6');

function isLoopbackAddress(address) {
  const value = address.toLowerCase().replace(/^\[|\]$/g, '').split('%')[0];
  const family = net.isIP(value);
  return family !== 0 && loopback.check(value, family === 6 ? 'ipv6' : 'ipv4');
}

async function proxyRequestPolicy({ hostname, port }, { lookup = dns.lookup } = {}) {
  const target = String(hostname || '').replace(/\.$/, '').replace(/^\[|\]$/g, '').toLowerCase();
  if (Number(port) === 9222 || !target || target === 'localhost' || target.endsWith('.localhost') || isLoopbackAddress(target)) {
    throw new ProxyChain.RequestError('Proxy access to Chrome debugging or host loopback is denied', 403);
  }
  const addresses = net.isIP(target) ? [{ address: target }] : await lookup(target, { all: true });
  if (addresses.some(({ address }) => isLoopbackAddress(address))) {
    throw new ProxyChain.RequestError('Proxy access to host loopback is denied', 403);
  }
  return {};
}

module.exports = { isLoopbackAddress, proxyRequestPolicy };
