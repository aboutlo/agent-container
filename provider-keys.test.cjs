// Tests are table-first: the shapes here are what the launcher builds.

const test = require('node:test');
const assert = require('node:assert');
const {
  commandKeyProviderIds,
  containerNameFor,
  execMarkerArgs,
  execWriteArgs,
  keyCommandUri,
  keyReadTimeoutMs,
  keysEnvArgs,
  credentialAdvice,
  keysFailedFile,
  keysGateArgs,
  keysReadyFile,
  keysMarkerPath,
  keysOutcome,
  keysMountArgs,
  keyTargetPath,
  missingCommandKeys,
  providerKeyCommand,
  readyTargetPath,
  resolveKeyCommandValue,
  safeKeyFileName,
  tmpfsMountArgs,
} = require('./provider-keys.cjs');

const modelsText = JSON.stringify({
  providers: {
    'omlx-clanker': {
      apiKey:
        '!cat "${PI_KEY_DIR:-$HOME/.config/pi/keys}/omlx-clanker" 2>/dev/null || op read "op://Private/OMLX_API_KEY/credential"',
    },
    'remote-ds4': { apiKey: '!op read op://Personal/ds4/PI_DS4_API_KEY' },
    // Legacy form: resolved by the runner from the environment, not by a command.
    'keyed-by-env': { apiKey: '${PI_OLLAMA_API_KEY}' },
    'no-auth': { baseUrl: 'http://localhost:11434/v1' },
    literal: { apiKey: 'hunter2' },
  },
});

const existsWith = (present) => (file) => present.includes(file);
const statWith = (present) => (file) => ({ isFile: () => present.includes(file) });

test('only apiKey values starting with "!" count as command keys', () => {
  assert.deepStrictEqual(commandKeyProviderIds(modelsText), ['omlx-clanker', 'remote-ds4']);
});

test('broken or empty models.json reports no providers instead of throwing', () => {
  for (const text of ['', undefined, '{not json', '[]', '{"providers":null}']) {
    assert.deepStrictEqual(commandKeyProviderIds(text), []);
  }
});

test('a provider is missing when its key file is absent or is not a regular file', () => {
  // omlx-clanker is present and regular; remote-ds4 exists as a directory => missing.
  const present = ['/keys/omlx-clanker', '/keys/remote-ds4'];
  const missing = missingCommandKeys({
    modelsText,
    keysDir: '/keys',
    existsSync: existsWith(present),
    isFile: statWith(['/keys/omlx-clanker']),
  });
  assert.deepStrictEqual(missing.map((entry) => entry.providerId), ['remote-ds4']);
  assert.strictEqual(missing[0].target, '/keys/remote-ds4');
});

test('every provider is missing when the key directory does not exist', () => {
  const missing = missingCommandKeys({ modelsText, keysDir: '/keys', existsSync: () => false });
  assert.deepStrictEqual(missing.map((entry) => entry.providerId), ['omlx-clanker', 'remote-ds4']);
});

test('the legacy bind transport mounts read-only and names the container path', () => {
  const present = { keysDir: '/home/u/.config/pi/keys', containerDir: '/run/pi-keys', existsSync: () => true };
  assert.deepStrictEqual(keysMountArgs(present), ['--volume', '/home/u/.config/pi/keys:/run/pi-keys:ro']);
  assert.deepStrictEqual(keysEnvArgs({ ...present, transport: 'bind' }), ['-e', 'PI_KEY_DIR=/run/pi-keys']);
});

test('tmpfs transport sets PI_KEY_DIR unconditionally and asks for a gate', () => {
  assert.deepStrictEqual(tmpfsMountArgs({ containerDir: '/run/pi-keys' }), ['--tmpfs', '/run/pi-keys']);
  assert.deepStrictEqual(keysEnvArgs({ containerDir: '/run/pi-keys' }), ['-e', 'PI_KEY_DIR=/run/pi-keys']);
  assert.deepStrictEqual(keysGateArgs({ waitSeconds: 25 }), ['-e', 'PIC_KEYS_WAIT=25']);
});

test('without injection the gate stays off and bind mode needs the directory', () => {
  assert.deepStrictEqual(keysEnvArgs({ keysDir: '/keys', containerDir: '/run/pi-keys', transport: 'bind' }), []);
  const absent = { keysDir: '/keys', containerDir: '/run/pi-keys', existsSync: () => false };
  assert.deepStrictEqual(keysMountArgs(absent), []);
  for (const partial of [
    { containerDir: '' },
    { keysDir: '', containerDir: '/run/pi-keys', existsSync: () => true },
  ]) {
    assert.deepStrictEqual(keysMountArgs(partial), []);
  }
  assert.deepStrictEqual(tmpfsMountArgs({ containerDir: '' }), []);
  assert.deepStrictEqual(keysEnvArgs({ containerDir: '' }), []);
});

test('injection writes over stdin to safe file names, then releases the gate', () => {
  assert.strictEqual(safeKeyFileName('omlx-clanker'), 'omlx-clanker');
  assert.strictEqual(safeKeyFileName('openai.gpt'), 'openai.gpt', 'dots inside an id are kept');
  for (const bad of ['../../etc/passwd', '.ready', '..', 'a/b', '', '.hidden']) {
    assert.strictEqual(safeKeyFileName(bad), null, `refuses ${JSON.stringify(bad)}`);
    assert.strictEqual(keyTargetPath({ containerDir: '/run/pi-keys', providerId: bad }), null);
  }
  assert.strictEqual(keyTargetPath({ containerDir: '/run/pi-keys', providerId: 'omlx-clanker' }), '/run/pi-keys/omlx-clanker');
  assert.strictEqual(readyTargetPath({ containerDir: '/run/pi-keys' }), '/run/pi-keys/.ready');
  // The secret is stdin, so it appears nowhere in these arguments.
  assert.deepStrictEqual(execWriteArgs({ container: 'pic-a1b2c3', target: '/run/pi-keys/omlx-clanker' }), [
    'exec',
    '-i',
    'pic-a1b2c3',
    'sh',
    '-c',
    "umask 0177; cat > '/run/pi-keys/omlx-clanker'",
  ]);
  // A marker removes its opposite: a reused container must not see last launch's verdict.
  assert.deepStrictEqual(
    execMarkerArgs({
      container: 'pic-a1b2c3',
      markerPath: keysMarkerPath({ containerDir: '/run/pi-keys', marker: keysReadyFile }),
      otherPath: keysMarkerPath({ containerDir: '/run/pi-keys', marker: keysFailedFile }),
    }),
    [
      'exec',
      '-i',
      'pic-a1b2c3',
      'sh',
      '-c',
      "umask 0177; rm -f '/run/pi-keys/.failed'; cat > '/run/pi-keys/.ready'",
    ],
  );
  assert.deepStrictEqual(execWriteArgs({ container: '', target: '/run/pi-keys/x' }), []);
});

test('the container name is stable per workdir volume suffix', () => {
  assert.strictEqual(containerNameFor({ volumeSuffix: 'a1b2c3' }), 'pic-a1b2c3');
  assert.strictEqual(containerNameFor({ prefix: 'pic-proxy', volumeSuffix: 'a1b2c3' }), 'pic-proxy-a1b2c3');
  assert.strictEqual(containerNameFor({ volumeSuffix: '' }), null);
});

test('the secret manager URI is read back from the apiKey command, quoted preferred', () => {
  assert.strictEqual(
    keyCommandUri(
      '!cat "${PI_KEY_DIR:-$HOME/.config/pi/keys}/x" 2>/dev/null || op read "op://Private/OMLX_API_KEY/credential"',
    ),
    'op://Private/OMLX_API_KEY/credential',
  );
  assert.strictEqual(keyCommandUri('!op read op://Personal/ds4/PI_DS4_API_KEY'), 'op://Personal/ds4/PI_DS4_API_KEY');
  assert.strictEqual(keyCommandUri('${PI_OMLX_API_KEY}'), null);
  assert.strictEqual(keyCommandUri('!echo literal'), null);
  // models.json lookup by provider id.
  assert.strictEqual(keyCommandUri(modelsText, 'omlx-clanker'), 'op://Private/OMLX_API_KEY/credential');
  assert.strictEqual(keyCommandUri(modelsText, 'no-auth'), null);
  assert.strictEqual(providerKeyCommand(modelsText, 'remote-ds4'), '!op read op://Personal/ds4/PI_DS4_API_KEY');
  assert.strictEqual(providerKeyCommand(modelsText, 'literal'), null);
});

test('host resolution drops PI_KEY_DIR so native pi behaviour is reproduced', () => {
  const calls = [];
  const fakeSpawn = (command, args, options) => {
    calls.push({ command, args, env: options.env });
    return { status: 0, stdout: '  live-value\n', stderr: '' };
  };
  const result = resolveKeyCommandValue({
    apiKey: '!op read "op://Private/OMLX_API_KEY/credential"',
    env: { PI_KEY_DIR: '/run/pi-keys', HOME: '/home/u' },
    spawn: fakeSpawn,
  });
  assert.strictEqual(result.value, 'live-value');
  assert.strictEqual(result.reason, null);
  assert.strictEqual(calls[0].command, '/bin/bash');
  assert.strictEqual(calls[0].args[0], '-c');
  assert.strictEqual(calls[0].args[1], 'op read "op://Private/OMLX_API_KEY/credential"');
  assert.strictEqual('PI_KEY_DIR' in calls[0].env, false, 'PI_KEY_DIR must not leak to the host command');
  assert.strictEqual(calls[0].env.HOME, '/home/u');
});

test('resolution failures report a reason and never a value', () => {
  const failing = resolveKeyCommandValue({
    apiKey: '!op read x',
    spawn: () => ({ status: 1, stdout: 'hunter2', stderr: 'authorization timeout\n(keychain is locked, unlock it to proceed)\n' }),
  });
  assert.strictEqual(failing.value, null);
  assert.strictEqual(failing.reason, 'authorization timeout');

  const empty = resolveKeyCommandValue({ apiKey: '!true', spawn: () => ({ status: 0, stdout: '\n', stderr: '' }) });
  assert.strictEqual(empty.value, null);
  assert.match(empty.reason, /exited with 0/);

  const thrown = resolveKeyCommandValue({ apiKey: '!true', spawn: () => ({ error: new Error('enoent bash') }) });
  assert.strictEqual(thrown.value, null);
  assert.strictEqual(thrown.reason, 'enoent bash');

  for (const apiKey of [undefined, '', 'hunter2', '${PI_VAR}']) {
    const result = resolveKeyCommandValue({ apiKey, spawn: () => ({ status: 0, stdout: 'x' }) });
    assert.strictEqual(result.value, null, `refuses non-command apiKey ${apiKey}`);
  }
});

test('a session only starts when at least one provider key is usable', () => {
  assert.deepStrictEqual(keysOutcome({ expected: [], failed: [] }), { usable: [], failed: [], ok: true },
    'a container with no command-key providers is not blocked');
  assert.strictEqual(keysOutcome({ expected: ['omlx-clanker'], failed: ['omlx-clanker'] }).ok, false);
  assert.strictEqual(keysOutcome({ expected: ['a', 'b'], failed: ['a'] }).ok, true, 'one working provider is a session');
  assert.deepStrictEqual(keysOutcome({ expected: ['a', 'b'], failed: ['a'] }).usable, ['b']);
  assert.deepStrictEqual(keysOutcome({ expected: ['a'], failed: ['unrelated'] }).failed, [],
    'a failure for a provider that was not expected is not reported');
});

test('one read gets enough time for a human to unlock a secret manager', () => {
  delete process.env.PIC_KEY_READ_TIMEOUT;
  assert.strictEqual(keyReadTimeoutMs(), 30_000);
  process.env.PIC_KEY_READ_TIMEOUT = '5';
  assert.strictEqual(keyReadTimeoutMs(), 5_000);
  delete process.env.PIC_KEY_READ_TIMEOUT;
});

test('the advice names the actual cause, not generic vault advice', () => {
  assert.match(
    credentialAdvice("[ERROR] could not read secret: error initializing client: You are not currently signed in."),
    /no session in this shell/,
    'the common case on a machine with no app integration is a missing session, not a locked app',
  );
  assert.match(credentialAdvice("it's not owned by the current user. Change the owner or logged in user"), /GUI login session/);
  assert.match(credentialAdvice('no accounts found matching filter "nope"'), /op account list/);
  assert.match(credentialAdvice('read timed out after 30s waiting for a prompt'), /PIC_KEYS_WAIT/);
  assert.match(credentialAdvice('cat: no such file'), /pic-keys/);
});
