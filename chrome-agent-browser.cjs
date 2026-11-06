const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const port = 9222;
const profile = path.join(os.homedir(), '.local', 'share', 'chrome-agent');

function checkChromeAgentListener({ run = spawnSync } = {}) {
  const result = run('lsof', ['-nP', '-iTCP:9222', '-sTCP:LISTEN', '-Fpn'], { encoding: 'utf8' });
  if (result.error) throw result.error;
  if (result.status === 1 && !result.stdout) return false;
  if (result.status !== 0) throw new Error(`Cannot inspect Chrome agent port: ${result.stderr || result.status}`);
  const pids = [...result.stdout.matchAll(/^p(\d+)$/gm)].map(match => match[1]);
  if (pids.length !== 1 || !result.stdout.includes('n127.0.0.1:9222')) {
    throw new Error('Port 9222 is in use, but not by one loopback-only Chrome agent');
  }
  const ps = run('ps', ['-p', pids[0], '-o', 'command='], { encoding: 'utf8' });
  if (ps.error) throw ps.error;
  const command = ps.stdout || '';
  if (ps.status !== 0 || !command.includes(`--user-data-dir=${profile}`) ||
      !command.includes('--remote-debugging-port=9222')) {
    throw new Error('Port 9222 belongs to another process; refusing to attach');
  }
  return true;
}

function assertNoLegacyProxy({ run = spawnSync } = {}) {
  const result = run('lsof', ['-nP', '-iTCP:8888', '-sTCP:LISTEN', '-Fp'], { encoding: 'utf8' });
  if (result.error) throw result.error;
  if (result.status === 0 && result.stdout) {
    throw new Error('Old shared proxy on port 8888 can reach Chrome debugging. Stop old pic-proxy/clc-proxy sessions before using Chrome Agent');
  }
  if (result.status !== 1 && result.status !== 0) throw new Error(`Cannot inspect old proxy: ${result.stderr || result.status}`);
}

function ensurePrivateProfile() {
  fs.mkdirSync(profile, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(profile);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) ||
      (process.getuid && stat.uid !== process.getuid())) {
    throw new Error(`Chrome agent profile must be private and owned by you: ${profile}`);
  }
  const lock = path.join(profile, 'SingletonLock');
  let target;
  try { target = fs.readlinkSync(lock); }
  catch (error) {
    if (error.code === 'ENOENT') return;
    throw new Error(`Cannot verify Chrome agent profile lock: ${error.message}`);
  }
  const prefix = `${os.hostname()}-`;
  const pid = target.startsWith(prefix) ? Number(target.slice(prefix.length)) : NaN;
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('Chrome agent profile is locked by an unknown process');
  try {
    process.kill(pid, 0);
    throw new Error(`Chrome agent profile is already open without debugging (PID ${pid}); close only that window first`);
  } catch (error) {
    if (error.code !== 'ESRCH') throw error;
  }
}

async function ensureChromeAgent({ log = () => {}, chromeCommand = process.env.PIC_CHROME_BIN ||
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', inspect = checkChromeAgentListener } = {}) {
  assertNoLegacyProxy();
  if (inspect()) {
    log(`reusing Chrome Agent at 127.0.0.1:${port} (${profile})`);
    return;
  }
  ensurePrivateProfile();
  const child = spawn(chromeCommand, [
    `--user-data-dir=${profile}`, '--profile-directory=Default',
    '--remote-debugging-address=127.0.0.1', `--remote-debugging-port=${port}`,
    '--no-first-run', '--no-default-browser-check', '--disable-sync',
    '--new-window', 'about:blank',
  ], { detached: true, stdio: 'ignore' });
  await new Promise((resolve, reject) => {
    child.once('spawn', resolve);
    child.once('error', reject);
  });
  child.unref();
  for (let attempt = 0; attempt < 40; attempt++) {
    if (inspect()) {
      log(`started Chrome Agent at 127.0.0.1:${port} (${profile}); leave this window open for Pi`);
      return;
    }
    if (child.exitCode !== null || child.signalCode !== null) break;
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw new Error('Chrome Agent did not open port 9222; check its profile and Chrome logs');
}

module.exports = { port, profile, checkChromeAgentListener, assertNoLegacyProxy, ensureChromeAgent };
