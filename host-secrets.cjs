// Secrets that Pi wants as environment variables, delivered without ever being declared.
//
// Two kinds exist: Anthropic credentials (`pic --anthropic`) and the legacy `"${NAME}"`
// providers in models.json. Both used to cross into the container as `-e NAME=<value>`, which
// Apple container records verbatim in `container inspect`, in `container list --format json`,
// and in instances/<id>/config.json with mode 0644 for the life of the container.
//
// Now the launcher declares only the *names* (`-e PIC_ENV_EXPORT=A,B`), the injector pipes the
// values into the key tmpfs over exec stdin after start, and entrypoint.sh exports them inside
// the VM right before exec'ing pi. UX is identical; the recorded configuration is clean.
//
// Only names models.json actually references, plus the Anthropic trio when --anthropic was
// asked for, are resolvable: a name outside that allowlist cannot be requested, so a tampered
// PIC_ENV_EXPORT cannot be used to siphon unrelated variables into a container.

const { referencedProviderVarNames, resolveProviderEnv } = require('./provider-env.cjs');

const anthropicEnvironmentNames = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_OAUTH_TOKEN'];

const envNamePattern = /^[A-Za-z_][A-Za-z0-9_]*$/;

// Names the launcher owns, or that would hijack the process if a stray file exported them.
const refusedNamePrefixes = ['PIC_', 'PI_CONTAINER_', 'HERDR_'];
const refusedNames = new Set([
  'PATH', 'HOME', 'IFS', 'ENV', 'BASH_ENV', 'PROMPT_COMMAND', 'SHELL', 'CDPATH', 'GLOBIGNORE',
  'NODE_OPTIONS', 'NODE_REPL_ENABLE', 'LD_PRELOAD', 'LD_LIBRARY_PATH', 'DYLD_INSERT_LIBRARIES',
  'DYLD_LIBRARY_PATH', 'DYLD_FRAMEWORK_PATH',
]);

function isExportableName(name) {
  if (typeof name !== 'string' || !envNamePattern.test(name)) return false;
  if (refusedNames.has(name)) return false;
  return !refusedNamePrefixes.some((prefix) => name.startsWith(prefix));
}

function exportableNames(names) {
  const seen = new Set();
  const out = [];
  for (const name of names) {
    if (!isExportableName(name) || seen.has(name)) continue;
    seen.add(name);
    out.push(name);
  }
  return out;
}

// Which variables this launch needs inside the container. Names only: no value is read here,
// so the parent process never holds a secret it could accidentally log.
function envSecretNames({ modelsText = '', env = process.env, anthropicEnabled = false } = {}) {
  const names = [];
  if (anthropicEnabled) {
    const fromEnv = anthropicEnvironmentNames.filter((name) => env[name]);
    if (fromEnv.length) names.push(...fromEnv);
    else if (env.PI_ANTHROPIC_KEY_CMD) names.push('ANTHROPIC_API_KEY');
  }
  names.push(...referencedProviderVarNames(modelsText));
  return exportableNames(names);
}

function envExportArgs(names) {
  const allowed = exportableNames(names);
  return allowed.length > 0 ? ['-e', `PIC_ENV_EXPORT=${allowed.join(',')}`] : [];
}

// The allowlist a container may ask for: referenced names, plus Anthropic when requested.
function allowedSecretNames({ modelsText = '', anthropicEnabled = false }) {
  const allowed = new Set(exportableNames(referencedProviderVarNames(modelsText)));
  if (anthropicEnabled) for (const name of anthropicEnvironmentNames) allowed.add(name);
  return allowed;
}

// Resolve values for the requested names, host-side. `runCommand` executes PI_ANTHROPIC_KEY_CMD
// (injected so tests never touch a shell or a secret manager).
function resolveEnvSecretValues({
  names = [],
  modelsText = '',
  env = process.env,
  providersEnvText,
  anthropicEnabled = false,
  runCommand,
} = {}) {
  const allowed = allowedSecretNames({ modelsText, anthropicEnabled });
  const provider = resolveProviderEnv({ modelsText, processEnv: env, providersEnvText });
  const values = {};
  const missing = [];

  for (const name of names) {
    if (!allowed.has(name) || !isExportableName(name)) continue; // not requestable
    if (anthropicEnvironmentNames.includes(name)) {
      if (env[name]) {
        values[name] = env[name];
        continue;
      }
      if (name === 'ANTHROPIC_API_KEY' && env.PI_ANTHROPIC_KEY_CMD && typeof runCommand === 'function') {
        const key = String(runCommand(env.PI_ANTHROPIC_KEY_CMD) || '').trim();
        if (key) {
          values[name] = key;
          continue;
        }
      }
      missing.push(name);
      continue;
    }
    const value = provider.values[name];
    if (value) values[name] = value;
    else missing.push(name);
  }

  return { values, missing };
}

// Legacy transport (PIC_KEYS_TRANSPORT=bind|off): the old `-e NAME=<value>` arguments, kept so
// a host that cannot inject still works, with the exposure the caller is expected to warn about.
function legacySecretEnvArgs(values) {
  return Object.entries(values).flatMap(([name, value]) => ['-e', `${name}=${value}`]);
}

module.exports = {
  allowedSecretNames,
  anthropicEnvironmentNames,
  envExportArgs,
  envSecretNames,
  isExportableName,
  exportableNames,
  legacySecretEnvArgs,
  refusedNames: [...refusedNames],
  resolveEnvSecretValues,
};
