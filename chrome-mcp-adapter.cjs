#!/usr/bin/env node
// A small stdio MCP server. Only the host broker has access to Chrome.
const readline = require('node:readline');
const http = require('node:http');
const host = process.env.PIC_CHROME_BRIDGE_HOST;
const port = process.env.PIC_CHROME_BRIDGE_PORT;
const token = process.env.PIC_CHROME_BRIDGE_TOKEN;
if (!host || !port || !token) process.exit(1);

function bridge(route, payload = {}) {
  // Use node:http directly so the runner's optional HTTP_PROXY cannot intercept this bridge.
  return new Promise((resolve, reject) => {
    const req = http.request({ host, port, path: route, method: 'POST', timeout: 120000,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    }, res => {
      let body = '';
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => {
        try {
          const data = JSON.parse(body);
          if (res.statusCode !== 200) reject(new Error(data.error || `Bridge returned ${res.statusCode}`));
          else resolve(data);
        } catch (error) { reject(error); }
      });
    });
    req.on('timeout', () => req.destroy(new Error('Chrome bridge timed out')));
    req.on('error', reject);
    req.end(JSON.stringify(payload));
  });
}

const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on('line', async line => {
  let request;
  try { request = JSON.parse(line); } catch { return; }
  if (request.id === undefined) return;
  const respond = response => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, ...response })}\n`);
  try {
    let result;
    switch (request.method) {
      case 'initialize':
        result = {
          protocolVersion: request.params?.protocolVersion || '2025-03-26',
          capabilities: { tools: {} },
          serverInfo: { name: 'pic_chrome', version: '1.0.0' },
        };
        break;
      case 'ping': result = {}; break;
      case 'tools/list': result = await bridge('/tools'); break;
      case 'tools/call':
        result = (await bridge('/call', {
          name: request.params?.name,
          arguments: request.params?.arguments || {},
        })).result;
        break;
      default:
        return respond({ error: { code: -32601, message: 'Method not found' } });
    }
    respond({ result });
  } catch (error) {
    respond({ error: { code: -32603, message: error.message } });
  }
});
