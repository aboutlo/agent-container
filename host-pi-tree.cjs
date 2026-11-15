// The container mounts a filtered *snapshot* of ~/.pi, never ~/.pi itself.
//
// ~/.pi/agent/sessions holds every transcript pi has ever recorded - including anything ever
// printed in a session, which is where credentials leak - and ~/.pi/agent/auth.json holds
// stored provider credentials. Mounting the whole directory read-only still put both in front
// of every process in every container: measurable from inside as 25 transcripts and an
// auth.json. The entrypoint has always copied a filtered tree into the container at start;
// this applies the same filtering on the host, once per launch, so the mount itself is the
// safe subset and there is nothing to read back.
//
// agent/npm and agent/git are NOT snapshotted (they are node_modules and git checkouts; a
// copy would be slow and pointless) - they get their own read-only bind instead, which the
// entrypoint symlinks into place.

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

// Relative to ~/.pi. Everything here stays out of every container.
const hostPiExcludes = [
  'agent/sessions', // transcripts: the largest credential sink pi produces
  'agent/auth.json', // stored provider credentials: use pic --anthropic or a model key
  'agent/bin',
  'agent/npm', // bound directly instead
  'agent/git', // bound directly instead
  'agent/skills', // pic stages these into the workspace, dereferenced
  'agent/extensions', // same: staged from settings.json packages
];

// Unanchored: matched anywhere in the tree.
const hostPiWildcards = ['*.lock', '*.tmp.*', '.DS_Store'];

const npmContainerDir = '/host-pi-npm';
const gitContainerDir = '/host-pi-git';

function snapshotDirFor({ home, dir = process.env.PIC_HOST_PI_SNAPSHOT_DIR }) {
  if (dir) return dir;
  return path.join(home || '', '.cache', 'pi-container', 'host-pi');
}

function excludePatterns(extraExcludes = []) {
  const anchored = [...hostPiExcludes, ...extraExcludes.filter(Boolean)];
  return [...anchored.map((pattern) => `/${pattern}`), ...hostPiWildcards];
}

function rsyncArgs({ source, target, extraExcludes = [] }) {
  const args = ['-a', '--delete', '--quiet'];
  for (const pattern of excludePatterns(extraExcludes)) args.push(`--exclude=${pattern}`);
  args.push(`${source.replace(/\/+$/, '')}/`, `${target.replace(/\/+$/, '')}/`);
  return args;
}

function tarCommand({ source, target, extraExcludes = [] }) {
  const excludes = excludePatterns(extraExcludes)
    .map((pattern) => `--exclude=${pattern.replace(/^\//, './')}`)
    .join(' ');
  return `tar -C ${JSON.stringify(source)} ${excludes} -cf - . | tar -C ${JSON.stringify(target)} -xf -`;
}

// Refresh the snapshot in place: a running container already shares this directory, and
// replacing the directory itself would leave that share pointing elsewhere.
function buildHostPiSnapshot({
  source,
  target,
  extraExcludes = [],
  spawn = spawnSync,
  existsSync = fs.existsSync,
  mkdirSync = fs.mkdirSync,
}) {
  if (!source || !target) return { ok: false, reason: 'source and target are required' };
  if (!existsSync(source)) return { ok: false, reason: `no ${source} to snapshot` };
  try {
    mkdirSync(target, { recursive: true, mode: 0o700 });
  } catch (error) {
    return { ok: false, reason: `cannot create ${target}: ${error.message}` };
  }

  const rsync = spawn('rsync', rsyncArgs({ source, target, extraExcludes }), { encoding: 'utf8' });
  if (!rsync.error && rsync.status === 0) return { ok: true, via: 'rsync', target };

  // No rsync (or it failed): copy with tar. Older files are not deleted, so a file removed
  // from ~/.pi can survive in the snapshot - reported rather than silently wrong.
  const tar = spawn('/bin/sh', ['-c', tarCommand({ source, target, extraExcludes })], { encoding: 'utf8' });
  if (!tar.error && tar.status === 0) {
    return { ok: true, via: 'tar', target, warning: 'snapshotted with tar; deleted files are not removed from the snapshot' };
  }
  return { ok: false, reason: `rsync failed (${rsync.stderr || rsync.error || rsync.status}); tar fallback failed (${tar.stderr || tar.error || tar.status})` };
}

function hostPiMountArgs({
  snapshotDir,
  source,
  npmSource,
  gitSource,
  containerDir = '/host-pi',
  existsSync = fs.existsSync,
}) {
  const args = [];
  const bind = (from, to) => ['--mount', `type=bind,source=${from},target=${to},readonly`];
  // Legacy behaviour, opt out of the snapshot with PIC_HOST_PI_SNAPSHOT=0.
  const root = snapshotDir || source;
  if (root) args.push(...bind(root, containerDir));
  if (npmSource && existsSync(npmSource)) args.push(...bind(npmSource, npmContainerDir));
  if (gitSource && existsSync(gitSource)) args.push(...bind(gitSource, gitContainerDir));
  return args;
}

module.exports = {
  buildHostPiSnapshot,
  excludePatterns,
  gitContainerDir,
  hostPiExcludes,
  hostPiMountArgs,
  hostPiWildcards,
  npmContainerDir,
  rsyncArgs,
  snapshotDirFor,
  tarCommand,
};
