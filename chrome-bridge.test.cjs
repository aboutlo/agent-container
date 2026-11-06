const assert = require('node:assert/strict');
const { test } = require('node:test');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');
const { ALLOWED_TOOLS, safeArguments, openChromeForLogin, reserveChromeProfile } = require('./chrome-bridge.cjs');
const { parseContainerRunnerArgs } = require('./runner-utils.cjs');
const { checkChromeAgentListener, profile: agentProfile } = require('./chrome-agent-browser.cjs');

test('bridge does not expose scripting or host file writes', () => {
  assert.equal(ALLOWED_TOOLS.has('evaluate_script'), false);
  assert.equal(ALLOWED_TOOLS.has('get_network_request'), false);
  assert.throws(() => safeArguments('navigate_page', { url: 'https://example.com', initScript: '1' }));
  assert.throws(() => safeArguments('new_page', { url: 'file:///etc/passwd' }));
  assert.throws(() => safeArguments('take_screenshot', { filePath: '/tmp/leak' }));
});

test('Chrome flag without a name stays temporary; a bare name selects a saved profile', () => {
  const options = { optionalValueFlags: ['--chrome-mcp'], valueFlags: ['--chrome-mcp-profile'] };
  for (const args of [['--chrome-mcp', 'mail'], ['--chrome-mcp=mail']]) {
    const parsed = parseContainerRunnerArgs([...args, '--print', 'hello'], options);
    assert.equal(parsed.flags['--chrome-mcp'], 'mail');
    assert.deepEqual(parsed.passthroughArgs, ['--print', 'hello']);
  }
  const temporary = parseContainerRunnerArgs(['--chrome-mcp', '--print', 'hello'], options);
  assert.equal(temporary.flags['--chrome-mcp'], true);
  assert.deepEqual(temporary.passthroughArgs, ['--print', 'hello']);
  assert.deepEqual(parseContainerRunnerArgs(['--chrome-mcp', '--', 'hello'], options).passthroughArgs, ['--', 'hello']);
  assert.deepEqual(parseContainerRunnerArgs(['--chrome-mcp', 'attach'], options).passthroughArgs, ['attach']);
  assert.throws(() => parseContainerRunnerArgs(['--chrome-mcp='], options), /requires a value/);
  for (const args of [['--chrome-mcp-profile', 'mail'], ['--chrome-mcp-profile=mail']]) {
    assert.equal(parseContainerRunnerArgs(args, options).flags['--chrome-mcp-profile'], 'mail');
  }
  assert.throws(() => parseContainerRunnerArgs(['--chrome-mcp-profile'], options), /requires a value/);
});

test('named profiles persist, reject unsafe names, and lock concurrent runs', () => {
  const root = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pic-profile-test-')), 'profiles');
  try {
    for (const name of ['', '..', '../other', 'a/b', '-bad']) {
      assert.throws(() => reserveChromeProfile({ profileName: name, profileRoot: root }), /name must be/);
    }
    const first = reserveChromeProfile({ profileName: 'my-mail', profileRoot: root });
    fs.writeFileSync(path.join(first.profile, 'test-cookie'), 'keep');
    assert.throws(() => reserveChromeProfile({ profileName: 'my-mail', profileRoot: root }), /is in use/);
    first.release();
    assert.ok(fs.existsSync(path.join(first.profile, 'test-cookie')));
    const second = reserveChromeProfile({ profileName: 'my-mail', profileRoot: root });
    assert.equal(first.profile, second.profile);
    second.release();
    fs.symlinkSync(first.profile, path.join(root, 'bad-link'));
    assert.throws(() => reserveChromeProfile({ profileName: 'bad-link', profileRoot: root }), /not a symlink/);
  } finally {
    fs.rmSync(path.dirname(root), { recursive: true, force: true });
  }
});

test('Chrome Agent attaches only to a loopback listener with the expected profile', () => {
  const run = command => command === 'lsof'
    ? { status: 0, stdout: 'p12345\nn127.0.0.1:9222\n' }
    : { status: 0, stdout: `Google Chrome --user-data-dir=${agentProfile} --remote-debugging-port=9222` };
  assert.equal(checkChromeAgentListener({ run }), true);
  assert.equal(checkChromeAgentListener({ run: () => ({ status: 1, stdout: '' }) }), false);
  assert.throws(() => checkChromeAgentListener({ run: command => command === 'lsof'
    ? { status: 0, stdout: 'p12345\nn*:9222\n' } : run(command) }), /loopback/);
  assert.throws(() => checkChromeAgentListener({ run: command => command === 'lsof'
    ? run(command) : { status: 0, stdout: 'Google Chrome --user-data-dir=/another/profile --remote-debugging-port=9222' } }), /another process/);
});

test('unnamed profile is deleted on release', () => {
  const temporary = reserveChromeProfile();
  assert.ok(fs.existsSync(temporary.profile));
  temporary.release();
  assert.equal(fs.existsSync(temporary.profile), false);
});

test('login opens normal Chrome with the supplied profile and waits for it to close', async () => {
  let child;
  let command;
  let args;
  const logs = [];
  const login = openChromeForLogin({ profile: '/tmp/fresh-profile', chromeCommand: '/Applications/Google Chrome',
    log: message => logs.push(message),
    spawnChrome: (bin, argv) => {
      command = bin;
      args = argv;
      child = new EventEmitter();
      child.kill = () => child.emit('close', null, 'SIGTERM');
      return child;
    },
  });
  assert.equal(command, '/Applications/Google Chrome');
  assert.ok(args.includes('--user-data-dir=/tmp/fresh-profile'));
  assert.ok(args.includes('--disable-sync'));
  assert.ok(!args.some(arg => arg.startsWith('--remote-debugging')));
  child.emit('close', 0, null);
  await login;
  assert.match(logs.at(-1), /starting MCP/);
});

test('Ctrl-C cancels login even if Chrome exits with status zero', async () => {
  const signals = new EventEmitter();
  const logs = [];
  let child;
  const login = openChromeForLogin({ profile: '/tmp/fresh-profile', chromeCommand: 'chrome',
    log: message => logs.push(message), signalEmitter: signals,
    spawnChrome: () => {
      child = new EventEmitter();
      child.kill = () => child.emit('close', 0, null);
      return child;
    },
  });
  signals.emit('SIGINT');
  await assert.rejects(login, /Chrome login cancelled/);
  assert.equal(logs.some(message => message.includes('starting MCP')), false);
  assert.equal(signals.listenerCount('SIGINT'), 0);
});

test('container MCP adapter forwards only broker tools with its token', async () => {
  const server = http.createServer(async (req, res) => {
    assert.equal(req.headers.authorization, 'Bearer test-token');
    const result = req.url === '/tools'
      ? { tools: [{ name: 'list_pages', description: 'Lists pages', inputSchema: { type: 'object' } }] }
      : { result: { content: [{ type: 'text', text: 'empty' }] } };
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(result));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [require.resolve('./chrome-mcp-adapter.cjs')],
    env: { ...process.env, PIC_CHROME_BRIDGE_HOST: '127.0.0.1',
      PIC_CHROME_BRIDGE_PORT: String(server.address().port), PIC_CHROME_BRIDGE_TOKEN: 'test-token' },
  });
  const client = new Client({ name: 'test', version: '1' });
  try {
    await client.connect(transport);
    assert.deepEqual((await client.listTools()).tools.map(tool => tool.name), ['list_pages']);
    assert.equal((await client.callTool({ name: 'list_pages', arguments: {} })).content[0].text, 'empty');
  } finally {
    await client.close();
    await new Promise(resolve => server.close(resolve));
  }
});
