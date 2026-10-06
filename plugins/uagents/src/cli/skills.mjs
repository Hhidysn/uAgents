import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fail } from '../protocol/errors.mjs';

export const SKILL_NAME = 'agent-dispatch';
const SKILL_SOURCE = fileURLToPath(new URL('../../skills/agent-dispatch/', import.meta.url));

export function skillSourceRoot() {
  if (!fs.existsSync(SKILL_SOURCE)) {
    fail('unsupported_capability', 'This installation does not include the bundled agent-dispatch skill.', { submission: 'not_sent' });
  }
  return SKILL_SOURCE;
}

function canonicalPath(target) {
  try { return fs.realpathSync.native(target); } catch { return path.resolve(target); }
}

function samePath(left, right) {
  return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;
}

function contains(parent, child) {
  const relative = path.relative(parent, child);
  return Boolean(relative) && !relative.startsWith('..') && !path.isAbsolute(relative);
}

function assertDisjoint(source, destination) {
  const from = canonicalPath(source);
  const to = canonicalPath(destination);
  if (samePath(from, to) || contains(from, to) || contains(to, from)) {
    fail('invalid_request', 'The --dir target overlaps the packaged skill source; nothing was written.', { submission: 'not_sent' });
  }
}

function listFiles(root, prefix = '') {
  const files = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) files.push(...listFiles(path.join(root, entry.name), relative));
    else if (entry.isFile()) files.push(relative);
  }
  return files;
}

// Copies the bundled skill into a host's skills directory. Nothing outside the
// given directory is touched, and an existing installation is only replaced
// when the caller asks for it.
export function installSkill({ targetDir, force = false, dryRun = false, source = null } = {}) {
  const root = source ?? skillSourceRoot();
  if (!targetDir || !path.isAbsolute(targetDir)) {
    fail('invalid_request', 'skills install requires --dir with an absolute skills directory.', { submission: 'not_sent' });
  }
  const skillsDirectory = path.resolve(targetDir);
  if (fs.existsSync(skillsDirectory) && !fs.statSync(skillsDirectory).isDirectory()) {
    fail('invalid_request', 'The --dir target must be a directory.', { submission: 'not_sent' });
  }
  const destination = path.join(skillsDirectory, SKILL_NAME);
  // `--dir` may point at this package's own skills directory. Replacing the
  // destination would then delete the source before it is copied, so the
  // overlap is refused before anything is written or removed.
  assertDisjoint(root, destination);
  const existing = fs.existsSync(destination);
  if (existing && !force) {
    fail('request_conflict', `Skill already exists at ${destination}; pass --force to replace it.`, { submission: 'not_sent' });
  }
  const files = listFiles(root).map(file => `${SKILL_NAME}/${file}`);
  if (dryRun) return { skill: SKILL_NAME, source: root, target: destination, files, dry_run: true, replaced: existing };

  fs.mkdirSync(skillsDirectory, { recursive: true });
  // Replace instead of merge so a removed reference file cannot survive an upgrade.
  if (existing) fs.rmSync(destination, { recursive: true, force: true });
  fs.cpSync(root, destination, { recursive: true });
  return { skill: SKILL_NAME, source: root, target: destination, files, dry_run: false, replaced: existing };
}
