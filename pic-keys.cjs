#!/usr/bin/env node

// pic-keys — inspect and refresh the provider keys that a container gets at launch.
//
//   pic-keys                         status for every provider whose apiKey is a "!command"
//   pic-keys <provider>              write from the 1Password URI already in models.json
//   pic-keys <provider> "<URI>"      write from an explicit URI
//   pic-keys --all                   write every command-key provider that names a URI
//   pic-keys --verify                read live and compare hashes; writes nothing, prints
//                                    no values — proves the URI and the authorization work
//
// Default transport (PIC_KEYS_TRANSPORT=tmpfs): pic reads each key live at launch and pipes
// it into the container's tmpfs, so no key file is needed at all and `pic-keys` is mainly
// `--verify`. Writing a file is for the legacy read-only bind transport
// (PIC_KEYS_TRANSPORT=bind) or for a host that cannot reach the secret manager.
//
// The directory sits outside ~/.pi because ~/.pi is bind-mounted whole into the container at
// /host-pi. A written key is 0600 via a umask-077 temp file and rename; it is never printed,
// never a command-line argument, and never a container environment value. models.json stays
// the only place a URI is declared.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { commandKeyProviderIds, keyCommandUri } = require('./provider-keys.cjs');

const agentDir = process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), '.pi', 'agent');
const modelsFile = path.join(agentDir, 'models.json');
const keysDir = process.env.PIC_KEYS_HOST_DIR || path.join(os.homedir(), '.config', 'pi', 'keys');
const opBin = process.env.OP_BIN || 'op';
const transport = (process.env.PIC_KEYS_TRANSPORT || 'tmpfs').toLowerCase();
const argv = process.argv.slice(2);

function readModels() {
  try {
    return JSON.parse(fs.readFileSync(modelsFile, 'utf8'));
  } catch (error) {
    console.error(`pic-keys: cannot read ${modelsFile}: ${error.message}`);
    process.exit(1);
  }
}

function providersOf(doc) {
  return doc && typeof doc.providers === 'object' && doc.providers ? doc.providers : {};
}

function uriFor(providers, id) {
  const uri = keyCommandUri(providers[id]?.apiKey);
  if (uri) return uri;
  console.error(`pic-keys: ${id}: its apiKey command names no op:// URI; pass one explicitly:`);
  console.error(`          pic-keys ${id} "op://<vault>/<item>/<field>"`);
  return null;
}

function writeKey(id, value) {
  fs.mkdirSync(keysDir, { recursive: true, mode: 0o700 });
  const target = path.join(keysDir, id);
  const temp = `${target}.tmp.${process.pid}`;
  const previous = process.umask(0o077);
  try {
    fs.writeFileSync(temp, `${value}\n`, { mode: 0o600 });
  } finally {
    process.umask(previous);
  }
  fs.chmodSync(temp, 0o600);
  fs.renameSync(temp, target);
  return target;
}

function fetch(uri) {
  // Argument vector, not a shell string: the URI never needs quoting and cannot be split.
  const result = spawnSync(opBin, ['read', uri], { encoding: 'utf8' });
  if (result.error) return { error: `${opBin} is not runnable: ${result.error.message}` };
  if (result.status !== 0) {
    const detail = (result.stderr || '').trim().split('\n')[0] || `exit ${result.status}`;
    return { error: `${opBin} read failed: ${detail}` };
  }
  const value = (result.stdout || '').trim();
  return value ? { value } : { error: `${opBin} read returned nothing` };
}

function statusLine(providers, id) {
  const file = path.join(keysDir, id);
  const has = fs.existsSync(file);
  const mode = has ? `0${(fs.statSync(file).mode & 0o777).toString(8)}` : '—';
  const uri = keyCommandUri(providers[id]?.apiKey);
  // tmpfs mode reads live at launch, so an absent file is the intended state, not a failure.
  const state = has ? 'file' : transport === 'tmpfs' ? 'live ' : 'MISS';
  console.log(`${state} ${id.padEnd(18)} ${has ? `${file} (${mode})` : 'no key file'}`);
  console.log(`     ${uri ? `URI in models.json: ${uri}` : 'no op:// URI in models.json; the fallback command runs as written'}`);
  return has || transport === 'tmpfs';
}

// Compare the live secret with the stored file by hash only. Because Pi caches a "!cmd"
// result for the lifetime of its process, and a running pic-proxy answers from the key file,
// this is the way to prove the URI and the 1Password authorization actually work.
function verify(providers, id) {
  const uri = uriFor(providers, id);
  if (!uri) return false;
  const file = path.join(keysDir, id);
  const stored = fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim() : null;
  const { value, error } = fetch(uri);
  if (error) {
    console.error(`FAIL ${id}: ${error}`);
    return false;
  }
  if (stored === null) {
    console.log(`ok   ${id}: live read works (${value.length} chars); no key file yet — run: pic-keys ${id}`);
    return true;
  }
  const hash = s => require('node:crypto').createHash('sha256').update(s).digest('hex').slice(0, 12);
  if (value === stored) {
    console.log(`ok   ${id}: live read matches the key file (sha256 ${hash(value)})`);
    return true;
  }
  console.log(`DIFF ${id}: live read differs from the key file (${hash(value)} vs ${hash(stored)}) — rotate? run: pic-keys ${id}`);
  return false;
}

function refresh(providers, id, explicitUri) {
  const uri = explicitUri || uriFor(providers, id);
  if (!uri) return false;
  const { value, error } = fetch(uri);
  if (error) {
    console.error(`FAIL ${id}: ${error}`);
    return false;
  }
  const target = writeKey(id, value);
  console.log(`ok   ${id}: wrote ${target} (0600, ${value.length} chars, not shown)`);
  return true;
}

const providers = providersOf(readModels());
const commandIds = commandKeyProviderIds(JSON.stringify({ providers }));

if (argv.length === 0) {
  if (commandIds.length === 0) {
    console.log(`no provider in ${modelsFile} uses a "!command" apiKey`);
    console.log('     nothing to do; a "${NAME}" apiKey is forwarded by pic from the environment');
    process.exit(0);
  }
  let allOk = true;
  for (const id of commandIds) allOk = statusLine(providers, id) && allOk;
  console.log(
    transport === 'tmpfs'
      ? `\ntransport: tmpfs (default) — pic reads these live at launch and pipes them into the\n` +
        '             container, so nothing is stored. Verify the live reads with: pic-keys --verify'
      : `\ntransport: ${transport} — pic uses ${keysDir} (mounted at /run/pi-keys, PI_KEY_DIR set)`,
  );
  if (!allOk) console.log('write the files with: pic-keys <provider>    # URI comes from models.json');
  process.exit(allOk ? 0 : 1);
}

if (argv[0] === '--all') {
  let ok = true;
  for (const id of commandIds) ok = refresh(providers, id) && ok;
  process.exit(ok ? 0 : 1);
}

if (argv[0] === '--verify') {
  const targets = argv[1] ? [argv[1]] : commandIds;
  if (targets.length === 0) {
    console.log(`no provider in ${modelsFile} uses a "!command" apiKey; nothing to verify`);
    process.exit(0);
  }
  let ok = true;
  for (const id of targets) ok = verify(providers, id) && ok;
  process.exit(ok ? 0 : 1);
}

if (argv[0].startsWith('-')) {
  console.error(`pic-keys: unknown argument ${argv[0]} (usage: pic-keys [provider [URI]|--all])`);
  process.exit(2);
}

const [id, explicitUri] = argv;
if (!Object.hasOwn(providers, id)) {
  console.error(`pic-keys: ${id} is not a provider in ${modelsFile}`);
  console.error(`          providers: ${Object.keys(providers).join(', ') || 'none'}`);
  process.exit(1);
}
process.exit(refresh(providers, id, explicitUri) ? 0 : 1);
