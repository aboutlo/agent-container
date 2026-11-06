// Shared-provider API keys for Pi's models.json.
//
// The committed models.json carries "${PI_*_API_KEY}" instead of a literal key, so
// the dotfiles repo holds no credential. Pi resolves those names from the process
// env at request time. pic must forward them into the container, which starts with
// a clean env. Keep the logic here so it stays testable without a container.

const interpolationPattern = /\$\{([A-Z0-9_]+)\}/g;

// Names referenced as ${NAME} anywhere in models.json. Read from the file rather
// than a hardcoded list so a new provider needs no change here.
function referencedProviderVarNames(modelsText) {
  if (typeof modelsText !== 'string') return [];
  return [...new Set([...modelsText.matchAll(interpolationPattern)].map(match => match[1]))];
}

// Reads `export NAME=value` lines, with or without quotes. Ignores comments.
function parseProvidersEnv(text) {
  const vars = {};
  if (typeof text !== 'string') return vars;
  for (const line of text.split('\n')) {
    const match = /^\s*export\s+([A-Z0-9_]+)=(.*)$/.exec(line);
    if (match) vars[match[1]] = match[2].trim().replace(/^["']|["']$/g, '');
  }
  return vars;
}

// Host env wins over the file, so a shell override beats the stored value.
function resolveProviderEnv({ modelsText, processEnv = {}, providersEnvText } = {}) {
  const fileVars = parseProvidersEnv(providersEnvText);
  const values = {};
  const missing = [];
  for (const name of referencedProviderVarNames(modelsText)) {
    const value = processEnv[name] ?? fileVars[name];
    if (value) values[name] = value;
    else missing.push(name);
  }
  return { values, missing };
}

// docker/container -e arguments, ordered stably by the order names appear in models.json.
function providerDockerArgs({ modelsText, processEnv = {}, providersEnvText } = {}) {
  const { values } = resolveProviderEnv({ modelsText, processEnv, providersEnvText });
  return Object.entries(values).flatMap(([name, value]) => ['-e', `${name}=${value}`]);
}

module.exports = {
  parseProvidersEnv,
  providerDockerArgs,
  referencedProviderVarNames,
  resolveProviderEnv,
};
