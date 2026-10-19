#!/usr/bin/env node

// Pi reads packages from settings.json. A container cannot see host paths, so copy
// what each enabled package declares in its package.json "pi" block.

const fs = require('node:fs');
const path = require('node:path');

const RESOURCE_KINDS = ['extensions', 'skills'];

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

// Mirror how Pi installs a package source: npm:<name>, git URL, or a local path
// relative to the agent directory that holds settings.json.
function resolvePackageDir(agentDir, source) {
  const entry = String(source).trim();
  if (!entry) return null;
  if (entry.startsWith('npm:')) {
    const spec = entry.slice(4).trim();
    const versionAt = spec.lastIndexOf('@');
    const name = versionAt > 0 ? spec.slice(0, versionAt) : spec;
    return path.join(agentDir, 'npm', 'node_modules', name);
  }
  const ssh = entry.match(/^[^@/]+@([^:]+):(.+?)(?:#.*)?$/);
  if (ssh) return path.join(agentDir, 'git', ssh[1], ssh[2].replace(/\.git$/, ''));
  const url = entry.match(/^(?:git\+)?(?:https?|ssh|git):\/\/([^/]+)\/(.+?)(?:#.*)?$/);
  if (url) return path.join(agentDir, 'git', url[1], url[2].replace(/\.git$/, ''));
  return path.resolve(agentDir, entry);
}

function packageLabel(manifest, packageDir) {
  const name = String(manifest.name || path.basename(packageDir));
  return name.replace(/^@/, '').replace(/[\\/]/g, '-').replace(/[^A-Za-z0-9._-]/g, '-');
}

// Two packages may expose the same file name, for example index.ts. Qualify the
// staged name so one package never overwrites another.
function stagedName(label, resourcePath) {
  return `${label}--${path.basename(resourcePath)}`;
}

function usableResource(kind, stats, resourcePath) {
  if (kind === 'skills') return stats.isDirectory();
  return stats.isDirectory() || /\.(ts|js|mjs)$/.test(resourcePath);
}

function packageResources(agentDir) {
  const settings = readJson(path.join(agentDir, 'settings.json')) || {};
  const packages = Array.isArray(settings.packages) ? settings.packages : [];
  const resources = { extensions: [], skills: [] };
  for (const source of packages) {
    const packageDir = resolvePackageDir(agentDir, source);
    if (!packageDir || !needsStaging(agentDir, packageDir)) continue;
    const manifest = readJson(path.join(packageDir, 'package.json')) || {};
    const pi = manifest.pi || {};
    const label = packageLabel(manifest, packageDir);
    for (const kind of RESOURCE_KINDS) {
      const entries = Array.isArray(pi[kind]) ? pi[kind] : [];
      for (const entry of entries) {
        const resourcePath = path.resolve(packageDir, String(entry));
        if (!fs.existsSync(resourcePath)) continue;
        if (!usableResource(kind, fs.statSync(resourcePath), resourcePath)) continue;
        resources[kind].push({ name: stagedName(label, resourcePath), path: resourcePath });
      }
    }
  }
  return resources;
}

// The container mounts the host agent dir, so npm and git packages already load there.
// Only a package outside that dir, such as a local path install, needs staging.
function needsStaging(agentDir, packageDir) {
  const rel = path.relative(agentDir, packageDir);
  return rel.startsWith('..') || path.isAbsolute(rel);
}

// Copy the resource as is, but leave tests and any dependency tree behind.
function stageContent(source, root) {
  const rel = path.relative(root, source);
  if (rel.split(path.sep).includes('node_modules')) return false;
  return !/\.test\.tsx?$/.test(source);
}

function stagePackageResources(agentDir, destDir, kind, log) {
  fs.mkdirSync(destDir, { recursive: true });
  for (const resource of packageResources(agentDir)[kind]) {
    const target = path.join(destDir, resource.name);
    try {
      fs.cpSync(resource.path, target, {
        recursive: true,
        dereference: true,
        force: true,
        filter: (source) => stageContent(source, resource.path),
      });
    } catch (error) {
      log(`warning: failed to stage package ${kind} "${resource.name}": ${error.message}`);
    }
  }
}

module.exports = { packageResources, resolvePackageDir, stagePackageResources };
