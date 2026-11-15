// Tests are table-first: these arguments and excludes are the security boundary.

const test = require('node:test');
const assert = require('node:assert');
const {
  buildHostPiSnapshot,
  excludePatterns,
  hostPiMountArgs,
  hostPiExcludes,
  npmContainerDir,
  gitContainerDir,
  rsyncArgs,
  snapshotDirFor,
  tarCommand,
} = require('./host-pi-tree.cjs');

test('transcripts and stored credentials never reach the snapshot', () => {
  assert.ok(hostPiExcludes.includes('agent/sessions'));
  assert.ok(hostPiExcludes.includes('agent/auth.json'));
  const patterns = excludePatterns([]);
  assert.ok(patterns.includes('/agent/sessions'), patterns.join(' '));
  assert.ok(patterns.includes('/agent/auth.json'));
  assert.ok(patterns.includes('*.lock'), 'lock files are matched anywhere');
  assert.ok(excludePatterns(['agent/prompts']).includes('/agent/prompts'), 'extra excludes are anchored');
});

test('rsync refreshes in place and deletes what disappeared', () => {
  const args = rsyncArgs({ source: '/Users/u/.pi/', target: '/Users/u/.cache/pi-container/host-pi/' });
  assert.deepStrictEqual(args.slice(0, 3), ['-a', '--delete', '--quiet']);
  assert.ok(args.includes('--exclude=/agent/sessions'));
  assert.deepStrictEqual(args.slice(-2), ['/Users/u/.pi/', '/Users/u/.cache/pi-container/host-pi/']);
});

test('the tar fallback anchors excludes at the transfer root and survives spaces', () => {
  const cmd = tarCommand({ source: '/Users/u/My Pi', target: '/tmp/host pi', extraExcludes: [] });
  assert.ok(cmd.includes('--exclude=./agent/sessions'), cmd);
  assert.ok(cmd.includes('"/Users/u/My Pi"'), cmd);
  assert.ok(cmd.includes('"/tmp/host pi"'), cmd);
});

const fakeFs = { existsSync: () => true, mkdirSync: () => {} };

test('a snapshot prefers rsync, falls back to tar, and reports both failing', () => {
  const calls = [];
  const okRsync = (command, args) => { calls.push(command); return { status: 0 }; };
  assert.deepStrictEqual(buildHostPiSnapshot({ source: '/a', target: '/b', spawn: okRsync, ...fakeFs }), { ok: true, via: 'rsync', target: '/b' });

  const rsyncBroken = (command, args) =>
    command === 'rsync' ? { status: 1, stderr: 'rsync: bad' } : (calls.push('tar'), { status: 0 });
  calls.length = 0;
  const fell = buildHostPiSnapshot({ source: '/a', target: '/b', spawn: rsyncBroken, ...fakeFs });
  assert.strictEqual(fell.ok, true);
  assert.strictEqual(fell.via, 'tar');
  assert.match(fell.warning, /deleted files are not removed/);

  const bothBroken = (command) => ({ status: 1, stderr: `${command} exploded` });
  const failed = buildHostPiSnapshot({ source: '/a', target: '/b', spawn: bothBroken, ...fakeFs });
  assert.strictEqual(failed.ok, false);
  assert.match(failed.reason, /rsync failed/);
  assert.match(failed.reason, /tar fallback failed/);
});

test('no source, no target: nothing is attempted', () => {
  let touched = 0;
  const spawn = () => { touched += 1; return { status: 0 }; };
  assert.strictEqual(buildHostPiSnapshot({ source: '', target: '/b', spawn, ...fakeFs }).ok, false);
  assert.strictEqual(buildHostPiSnapshot({ source: '/a', target: '', spawn, ...fakeFs }).ok, false);
  assert.strictEqual(buildHostPiSnapshot({ source: '/missing', target: '/b', spawn, existsSync: () => false, mkdirSync: () => {} }).ok, false);
  assert.strictEqual(touched, 0);
});

test('the snapshot is mounted read-only, npm and git only when they exist', () => {
  const snapshot = '/Users/u/.cache/pi-container/host-pi';
  const mounts = hostPiMountArgs({
    snapshotDir: snapshot,
    npmSource: '/Users/u/.pi/agent/npm',
    gitSource: '/Users/u/.pi/agent/git',
    existsSync: () => true,
  });
  assert.deepStrictEqual(mounts, [
    '--mount', `type=bind,source=${snapshot},target=/host-pi,readonly`,
    '--mount', 'type=bind,source=/Users/u/.pi/agent/npm,target=/host-pi-npm,readonly',
    '--mount', 'type=bind,source=/Users/u/.pi/agent/git,target=/host-pi-git,readonly',
  ]);
  assert.strictEqual(npmContainerDir, '/host-pi-npm');
  assert.strictEqual(gitContainerDir, '/host-pi-git');

  // Absent npm/git are simply not mounted; with no snapshot the legacy whole-tree mount is used.
  const sparse = hostPiMountArgs({ snapshotDir: snapshot, npmSource: '/u/.pi/agent/npm', existsSync: () => false });
  assert.deepStrictEqual(sparse, ['--mount', `type=bind,source=${snapshot},target=/host-pi,readonly`]);
  assert.deepStrictEqual(hostPiMountArgs({ source: '/Users/u/.pi' })[1], 'type=bind,source=/Users/u/.pi,target=/host-pi,readonly');
  assert.deepStrictEqual(hostPiMountArgs({}), []);
});

test('the snapshot lives under the user cache and can be overridden', () => {
  assert.strictEqual(snapshotDirFor({ home: '/Users/u' }), '/Users/u/.cache/pi-container/host-pi');
  const previous = process.env.PIC_HOST_PI_SNAPSHOT_DIR;
  process.env.PIC_HOST_PI_SNAPSHOT_DIR = '/tmp/custom-snapshot';
  assert.strictEqual(snapshotDirFor({ home: '/Users/u' }), '/tmp/custom-snapshot');
  if (previous === undefined) delete process.env.PIC_HOST_PI_SNAPSHOT_DIR;
  else process.env.PIC_HOST_PI_SNAPSHOT_DIR = previous;
});
