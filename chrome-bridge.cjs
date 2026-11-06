const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');
const { ensureChromeAgent, port: agentPort } = require('./chrome-agent-browser.cjs');

// Never relay Chrome's raw debugging interface or arbitrary script/network/file tools.
const ALLOWED_TOOLS = new Set([
  'list_pages', 'new_page', 'navigate_page', 'take_screenshot', 'take_snapshot',
  'wait_for', 'click', 'fill', 'press_key', 'hover', 'select_option',
]);

function safeArguments(name, args) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('Invalid tool arguments');
  if (name === 'navigate_page' && args.initScript !== undefined) throw new Error('initScript is not allowed');
  if (name === 'new_page' || (name === 'navigate_page' && (!args.type || args.type === 'url'))) {
    const url = args.url;
    if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) throw new Error('Only HTTP(S) URLs are allowed');
  }
  if (name === 'take_screenshot' && args.filePath !== undefined) throw new Error('Writing host files is not allowed');
  return args;
}

function reserveChromeProfile({ profileName, profileRoot = path.join(os.homedir(), '.pic-chrome-profiles') } = {}) {
  if (profileName === undefined) {
    const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'pic-chrome-'));
    fs.chmodSync(profile, 0o700);
    return { profile, release: () => fs.rmSync(profile, { recursive: true, force: true }) };
  }
  if (typeof profileName !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}$/.test(profileName)) {
    throw new Error('Chrome profile name must be 1–64 letters, digits, dots, underscores, or hyphens, starting with a letter or digit');
  }
  function ensurePrivateDirectory(dir) {
    try { fs.mkdirSync(dir, { mode: 0o700 }); } catch (error) { if (error.code !== 'EEXIST') throw error; }
    const stat = fs.lstatSync(dir);
    if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) ||
        (process.getuid && stat.uid !== process.getuid())) {
      throw new Error(`Chrome profile directory must be private, owned by you, and not a symlink: ${dir}`);
    }
  }
  ensurePrivateDirectory(profileRoot);
  const profile = path.join(profileRoot, profileName);
  ensurePrivateDirectory(profile);
  const lockPath = `${profile}.lock`;
  let lock;
  try { lock = fs.openSync(lockPath, 'wx', 0o600); }
  catch (error) {
    if (error.code === 'EEXIST') throw new Error(`Chrome profile "${profileName}" is in use (${lockPath}); if a run crashed, check Chrome is closed before removing this lock`);
    throw error;
  }
  try { fs.writeSync(lock, `${process.pid}\n`); }
  catch (error) { fs.unlinkSync(lockPath); throw error; }
  finally { fs.closeSync(lock); }
  return { profile, release: () => fs.unlinkSync(lockPath) };
}

async function openChromeForLogin({ profile, log, chromeCommand, spawnChrome = spawn, signalEmitter = process }) {
  log('Opening normal Chrome with this profile. Log in if needed, then close that Chrome window to continue. Other Chrome windows can stay open.');
  const child = spawnChrome(chromeCommand, [
    `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check',
    '--disable-background-mode', '--disable-sync', '--new-window', 'about:blank',
  ], { stdio: 'ignore' });
  let interrupted = false;
  const interrupt = () => {
    interrupted = true;
    child.kill('SIGTERM');
  };
  signalEmitter.once('SIGINT', interrupt);
  signalEmitter.once('SIGTERM', interrupt);
  try {
    const { code, signal } = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code, signal) => resolve({ code, signal }));
    });
    if (interrupted) throw new Error('Chrome login cancelled');
    if (code !== 0 || signal) throw new Error(`Login Chrome closed unexpectedly (${signal || code})`);
    log('Login Chrome closed; starting MCP with the same profile');
  } finally {
    signalEmitter.removeListener('SIGINT', interrupt);
    signalEmitter.removeListener('SIGTERM', interrupt);
  }
}

async function startChromeBridge({ host, log = () => {}, command = 'chrome-devtools-mcp',
  chromeCommand = process.env.PIC_CHROME_BIN || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  loginFirst = true, spawnChrome = spawn, profileName, profileRoot,
}) {
  // "clanker" is the dedicated host Chrome Agent, not a copied Chrome menu profile.
  const attachAgent = profileName === 'clanker';
  const reservation = attachAgent ? null : reserveChromeProfile({ profileName, profileRoot });
  const profile = reservation?.profile;
  if (profileName && !attachAgent) log(`using named Chrome profile "${profileName}" at ${profile}`);
  const token = crypto.randomBytes(32).toString('hex');
  const transport = new StdioClientTransport({
    command,
    args: [
      ...(attachAgent ? [`--browserUrl=http://127.0.0.1:${agentPort}`] : [
        '--channel=stable', `--userDataDir=${profile}`, '--viewport=1440x900',
        '--chromeArg=--disable-sync',
      ]),
      '--no-usage-statistics', '--no-performance-crux', '--no-javascript-evaluation',
      '--no-category-performance', '--no-category-network',
    ],
    stderr: 'pipe',
  });
  const client = new Client({ name: 'pic-chrome-bridge', version: '1.0.0' });
  let server;
  const sockets = new Set();
  let closed = false;
  async function close() {
    if (closed) return;
    closed = true;
    for (const socket of sockets) socket.destroy();
    if (server?.listening) await new Promise(resolve => server.close(resolve));
    await client.close().catch(() => {});
    reservation?.release();
  }
  try {
    if (attachAgent) await ensureChromeAgent({ log, chromeCommand });
    else if (loginFirst) await openChromeForLogin({ profile, log, chromeCommand, spawnChrome });
    await client.connect(transport);
    const available = await client.listTools();
    const tools = available.tools.filter(tool => ALLOWED_TOOLS.has(tool.name));
    if (!tools.some(tool => tool.name === 'list_pages')) throw new Error('Chrome MCP has no list_pages tool');
    // The first call verifies that MCP can control the intended browser.
    const pages = await client.callTool({ name: 'list_pages', arguments: {} });
    if (pages.isError) throw new Error(`Chrome MCP could not list pages: ${pages.content?.[0]?.text || 'unknown error'}`);
    server = http.createServer(async (req, res) => {
      const reply = (status, data) => {
        res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify(data));
      };
      if (req.method !== 'POST' || !['/tools', '/call'].includes(req.url)) return reply(404, { error: 'Not found' });
      const auth = req.headers.authorization || '';
      const supplied = auth.startsWith('Bearer ') ? auth.slice(7) : '';
      if (supplied.length !== token.length || !crypto.timingSafeEqual(Buffer.from(supplied), Buffer.from(token))) {
        return reply(401, { error: 'Unauthorized' });
      }
      let body = '';
      try {
        for await (const chunk of req) {
          body += chunk;
          if (body.length > 1024 * 1024) throw new Error('Request too large');
        }
        if (req.url === '/tools') return reply(200, { tools });
        const { name, arguments: args = {} } = JSON.parse(body);
        if (!tools.some(tool => tool.name === name)) return reply(403, { error: 'Tool not allowed' });
        const result = await client.callTool({ name, arguments: safeArguments(name, args) });
        return reply(200, { result });
      } catch (error) {
        return reply(400, { error: error.message });
      }
    });
    server.on('connection', socket => {
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));
    });
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, host, resolve);
    });
    const port = server.address().port;
    log(`${attachAgent ? 'Chrome Agent attached' : profileName ? 'named Chrome started' : 'temporary Chrome started'}; bridge listening on ${host}:${port}`);
    return { port, token, close };
  } catch (error) {
    await close();
    throw error;
  }
}

module.exports = { ALLOWED_TOOLS, safeArguments, reserveChromeProfile, openChromeForLogin, startChromeBridge };
