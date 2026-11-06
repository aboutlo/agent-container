const assert = require('node:assert/strict');
const { test } = require('node:test');
const {
  parseProvidersEnv,
  providerDockerArgs,
  referencedProviderVarNames,
  resolveProviderEnv,
} = require('./provider-env.cjs');

const modelsText = JSON.stringify({
  providers: {
    ollama: { apiKey: '${PI_OLLAMA_API_KEY}', models: [] },
    omlx: { apiKey: '${PI_OMLX_API_KEY}', models: [{ id: 'm' }] },
    literal: { apiKey: 'sk-literal', models: [] },
  },
});

test('only ${NAME} references are collected, once each', () => {
  assert.deepEqual(referencedProviderVarNames(modelsText), ['PI_OLLAMA_API_KEY', 'PI_OMLX_API_KEY']);
  assert.deepEqual(referencedProviderVarNames(''), []);
  assert.deepEqual(referencedProviderVarNames(undefined), []);
});

test('the same name twice in models.json still forwards once', () => {
  const twice = '{"a":{"apiKey":"${PI_A}"},"b":{"apiKey":"${PI_A}"}}';
  assert.deepEqual(providerDockerArgs({ modelsText: twice, processEnv: { PI_A: 'k' } }), ['-e', 'PI_A=k']);
});

test('providers.env lines parse with and without quotes', () => {
  assert.deepEqual(parseProvidersEnv([
    '# comment',
    'export PI_OMLX_API_KEY="secret_api"',
    "  export PI_DS4_API_KEY='dsv4-local'",
    'export PI_OLLAMA_API_KEY=ollama',
    'PI_NOT_EXPORTED=x',
  ].join('\n')), {
    PI_OMLX_API_KEY: 'secret_api',
    PI_DS4_API_KEY: 'dsv4-local',
    PI_OLLAMA_API_KEY: 'ollama',
  });
  assert.deepEqual(parseProvidersEnv(undefined), {});
});

test('host env wins over the file, and the file fills the gaps', () => {
  const file = 'export PI_OLLAMA_API_KEY="from_file"\nexport PI_OMLX_API_KEY="from_file"\nexport PI_DS4_API_KEY="from_file"';
  const { values, missing } = resolveProviderEnv({
    modelsText,
    processEnv: { PI_OMLX_API_KEY: 'from_env' },
    providersEnvText: file,
  });
  assert.deepEqual(values, { PI_OLLAMA_API_KEY: 'from_file', PI_OMLX_API_KEY: 'from_env' });
  assert.deepEqual(missing, []);   // PI_DS4_API_KEY is in the file but unreferenced: never forwarded
});

test('a name with no value anywhere is reported, never forwarded empty', () => {
  const args = providerDockerArgs({ modelsText, processEnv: {}, providersEnvText: '' });
  assert.deepEqual(args, []);
  assert.deepEqual(resolveProviderEnv({ modelsText }).missing, ['PI_OLLAMA_API_KEY', 'PI_OMLX_API_KEY']);
});

test('a literal apiKey in models.json is not treated as a variable', () => {
  assert.equal(JSON.stringify(providerDockerArgs({ modelsText, processEnv: { PI_OLLAMA_API_KEY: 'a', PI_OMLX_API_KEY: 'b' } }))
    .includes('sk-literal'), false);
});
