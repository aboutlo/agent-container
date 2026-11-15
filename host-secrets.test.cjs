// Tests are table-first: the allowlist here decides what a container can be handed.

const test = require('node:test');
const assert = require('node:assert');
const {
  allowedSecretNames,
  anthropicEnvironmentNames,
  envExportArgs,
  envSecretNames,
  exportableNames,
  isExportableName,
  legacySecretEnvArgs,
  resolveEnvSecretValues,
} = require('./host-secrets.cjs');

const modelsText = JSON.stringify({
  providers: {
    'keyed-one': { apiKey: '${PI_OLLAMA_API_KEY}' },
    'keyed-two': { apiKey: '${PI_DARKBLOOM_KEY}', baseUrl: 'http://h/${PI_DARKBLOOM_KEY}/v1' },
    'command-key': { apiKey: '!cat "/run/pi-keys/command-key"' },
  },
});

test('only names are declared, and only the ones actually needed', () => {
  assert.deepStrictEqual(envSecretNames({ modelsText, env: {}, anthropicEnabled: false }), [
    'PI_OLLAMA_API_KEY',
    'PI_DARKBLOOM_KEY',
  ]);
  assert.deepStrictEqual(envExportArgs(['PI_OLLAMA_API_KEY', 'PI_DARKBLOOM_KEY']), [
    '-e',
    'PIC_ENV_EXPORT=PI_OLLAMA_API_KEY,PI_DARKBLOOM_KEY',
  ]);
  assert.deepStrictEqual(envExportArgs([]), []);
  assert.deepStrictEqual(envSecretNames({ modelsText: '{}', env: {} }), []);
});

test('--anthropic asks for what exists, or for the command to supply', () => {
  const names = envSecretNames({ modelsText: '{}', env: { ANTHROPIC_AUTH_TOKEN: 'x' }, anthropicEnabled: true });
  assert.deepStrictEqual(names, ['ANTHROPIC_AUTH_TOKEN']);
  assert.deepStrictEqual(
    envSecretNames({ modelsText: '{}', env: { PI_ANTHROPIC_KEY_CMD: 'op read op://x' }, anthropicEnabled: true }),
    ['ANTHROPIC_API_KEY'],
  );
  // Nothing available: nothing to declare, and the caller warns.
  assert.deepStrictEqual(envSecretNames({ modelsText: '{}', env: {}, anthropicEnabled: true }), []);
  assert.deepStrictEqual(anthropicEnvironmentNames.length, 3);
});

test('process-hijacking names can never be exported', () => {
  for (const bad of ['PATH', 'HOME', 'IFS', 'BASH_ENV', 'ENV', 'NODE_OPTIONS', 'DYLD_INSERT_LIBRARIES', 'LD_PRELOAD', 'PROMPT_COMMAND', 'PIC_ENV_EXPORT', 'PIC_KEYS_WAIT', 'HERDR_AGENT', 'PI_CONTAINER_X', 'bad-name', '1NSANE', '', 'SPACED OUT']) {
    assert.strictEqual(isExportableName(bad), false, bad);
  }
  for (const good of ['PI_OLLAMA_API_KEY', 'ANTHROPIC_API_KEY', 'OMLX_KEY', '_PRIVATE', 'KEY2']) {
    assert.strictEqual(isExportableName(good), true, good);
  }
  assert.deepStrictEqual(
    exportableNames(['PI_A', 'PATH', 'PI_A', 'PIC_B', 'ANTHROPIC_API_KEY']),
    ['PI_A', 'ANTHROPIC_API_KEY'],
  );
});

test('values resolve from env, then providers.env, then the key command', () => {
  const fromEnv = resolveEnvSecretValues({
    names: ['PI_OLLAMA_API_KEY'],
    modelsText,
    env: { PI_OLLAMA_API_KEY: 'a' },
  });
  assert.deepStrictEqual(fromEnv, { values: { PI_OLLAMA_API_KEY: 'a' }, missing: [] });

  const fromFile = resolveEnvSecretValues({
    names: ['PI_OLLAMA_API_KEY', 'PI_DARKBLOOM_KEY'],
    modelsText,
    env: {},
    providersEnvText: 'export PI_OLLAMA_API_KEY="a"\nexport PI_DARKBLOOM_KEY=b\n',
  });
  assert.deepStrictEqual(fromFile, { values: { PI_OLLAMA_API_KEY: 'a', PI_DARKBLOOM_KEY: 'b' }, missing: [] });

  const partial = resolveEnvSecretValues({ names: ['PI_OLLAMA_API_KEY', 'PI_DARKBLOOM_KEY'], modelsText, env: { PI_OLLAMA_API_KEY: 'a' } });
  assert.deepStrictEqual(partial, { values: { PI_OLLAMA_API_KEY: 'a' }, missing: ['PI_DARKBLOOM_KEY'] });

  const viaCommand = resolveEnvSecretValues({
    names: ['ANTHROPIC_API_KEY'],
    modelsText: '{}',
    env: { PI_ANTHROPIC_KEY_CMD: 'op read op://Private/Anthropic/credential' },
    anthropicEnabled: true,
    runCommand: () => '  sk-ant-1  \n',
  });
  assert.deepStrictEqual(viaCommand, { values: { ANTHROPIC_API_KEY: 'sk-ant-1' }, missing: [] });

  const noCommand = resolveEnvSecretValues({ names: ['ANTHROPIC_API_KEY'], modelsText: '{}', env: {}, anthropicEnabled: true, runCommand: () => '' });
  assert.deepStrictEqual(noCommand, { values: {}, missing: ['ANTHROPIC_API_KEY'] });
});

test('a tampered PIC_ENV_EXPORT cannot siphon unrelated variables', () => {
  const env = { PI_OLLAMA_API_KEY: 'a', AWS_SECRET_ACCESS_KEY: 'leak', ANTHROPIC_API_KEY: 'sk' };
  const result = resolveEnvSecretValues({
    names: ['AWS_SECRET_ACCESS_KEY', 'ANTHROPIC_API_KEY', 'PI_OLLAMA_API_KEY'],
    modelsText,
    env,
  });
  assert.deepStrictEqual(result, { values: { PI_OLLAMA_API_KEY: 'a' }, missing: [] });
  assert.deepStrictEqual([...allowedSecretNames({ modelsText }).keys()], ['PI_OLLAMA_API_KEY', 'PI_DARKBLOOM_KEY']);
  // Anthropic names only become requestable when --anthropic was asked for.
  assert.deepStrictEqual(allowedSecretNames({ modelsText: '{}', anthropicEnabled: true }).has('ANTHROPIC_API_KEY'), true);
  assert.deepStrictEqual(allowedSecretNames({ modelsText: '{}' }).has('ANTHROPIC_API_KEY'), false);
});

test('the legacy transport still produces -e arguments', () => {
  assert.deepStrictEqual(legacySecretEnvArgs({ PI_OLLAMA_API_KEY: 'a', ANTHROPIC_API_KEY: 'b' }), [
    '-e',
    'PI_OLLAMA_API_KEY=a',
    '-e',
    'ANTHROPIC_API_KEY=b',
  ]);
  assert.deepStrictEqual(legacySecretEnvArgs({}), []);
});
