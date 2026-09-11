import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fail } from '../protocol/errors.mjs';

export const COUNCIL_DIFF_LIMITS = Object.freeze({
  patch_bytes: 1024 * 1024,
  untracked_text_bytes: 256 * 1024,
});

export function inspectCouncilWorktreeDiff(member) {
  if (!member.worktree) return null;
  if (!fs.existsSync(member.worktree.worktree_root)) return removedWorktree(member);
  const root = member.worktree.worktree_root;
  const baseHead = member.worktree.base_head;
  const head = git(root, ['rev-parse', 'HEAD']).trim();
  const patch = boundedText(git(root, ['diff', '--no-ext-diff', '--no-color', baseHead, '--']), COUNCIL_DIFF_LIMITS.patch_bytes);
  const tracked = parseNameStatus(git(root, ['diff', '--name-status', '--no-renames', '-z', baseHead, '--']));
  const untracked = splitNul(git(root, ['ls-files', '--others', '--exclude-standard', '-z'])).map(relativePath => {
    const file = path.join(root, ...relativePath.split('/'));
    const stat = fs.statSync(file);
    const descriptor = { path: relativePath, status: 'untracked', bytes: stat.size };
    if (!stat.isFile() || stat.size > COUNCIL_DIFF_LIMITS.untracked_text_bytes) return descriptor;
    const body = fs.readFileSync(file);
    const text = decodeUtf8(body);
    return text === null ? { ...descriptor, binary: true } : { ...descriptor, binary: false, text };
  });
  const diffStat = git(root, ['diff', '--stat', baseHead, '--']).trim();
  return {
    ...member.worktree,
    cleanup: member.cleanup ?? null,
    head,
    dirty: tracked.length > 0 || untracked.length > 0,
    tracked_files: tracked,
    untracked_files: untracked,
    tracked_diff_stat: diffStat,
    tracked_patch: patch.text,
    tracked_patch_bytes: patch.bytes,
    tracked_patch_truncated: patch.truncated,
  };
}

export function adoptCouncilWorktree(member, destinationWorkspace) {
  if (!member.worktree) fail('unsupported_capability', 'Council candidate adoption requires a git worktree member.', { submission: 'not_sent' });
  if (!fs.existsSync(member.worktree.worktree_root)) {
    fail('request_conflict', 'Council candidate worktree has already been cleaned up.', {
      category: 'conflict', submission: 'not_sent', details: { member_id: member.member_id },
    });
  }
  if (!path.isAbsolute(destinationWorkspace ?? '')) fail('invalid_workspace', 'Candidate adoption requires an absolute destination workspace.');

  const sourceRoot = member.worktree.worktree_root;
  const destination = path.resolve(destinationWorkspace);
  const destinationRoot = git(destination, ['rev-parse', '--show-toplevel']).trim();
  const destinationHead = git(destination, ['rev-parse', 'HEAD']).trim();
  if (destinationHead !== member.worktree.base_head) {
    fail('request_conflict', 'Destination HEAD must match the Council base HEAD before adoption.', {
      category: 'conflict', submission: 'not_sent',
      details: { base_head: member.worktree.base_head, destination_head: destinationHead },
    });
  }

  const untrackedPaths = splitNul(git(sourceRoot, ['ls-files', '--others', '--exclude-standard', '-z']));
  const untracked = untrackedPaths.map(relativePath => {
    const source = path.join(sourceRoot, ...relativePath.split('/'));
    const destinationFile = path.join(destinationRoot, ...relativePath.split('/'));
    const stat = fs.lstatSync(source);
    if (!stat.isFile()) fail('unsupported_capability', `Cannot adopt non-file untracked path: ${relativePath}`, { submission: 'not_sent' });
    if (fs.existsSync(destinationFile)) {
      fail('request_conflict', `Destination already contains candidate untracked path: ${relativePath}`, {
        category: 'conflict', submission: 'not_sent', details: { path: relativePath },
      });
    }
    return { path: relativePath, source, destination: destinationFile, bytes: stat.size };
  });

  const patch = gitBuffer(sourceRoot, ['diff', '--binary', '--no-ext-diff', member.worktree.base_head, '--']);
  if (patch.length) gitApply(destinationRoot, patch, true);
  if (patch.length) gitApply(destinationRoot, patch, false);
  for (const file of untracked) {
    fs.mkdirSync(path.dirname(file.destination), { recursive: true });
    fs.copyFileSync(file.source, file.destination);
    fs.chmodSync(file.destination, fs.lstatSync(file.source).mode);
  }

  const status = git(destinationRoot, ['status', '--porcelain=v1', '--untracked-files=all']);
  return {
    source: {
      member_id: member.member_id,
      task_id: member.task_id,
      branch: member.worktree.branch,
      worktree_root: sourceRoot,
      base_head: member.worktree.base_head,
      head: git(sourceRoot, ['rev-parse', 'HEAD']).trim(),
    },
    destination: {
      workspace: destination,
      repository: destinationRoot,
      head: destinationHead,
      dirty: Boolean(status.trim()),
      changes: status.split(/\r?\n/).filter(Boolean),
    },
    applied: {
      tracked_patch_bytes: patch.length,
      untracked_files: untracked.map(file => ({ path: file.path, bytes: file.bytes })),
    },
  };
}

function removedWorktree(member) {
  return {
    ...member.worktree,
    cleanup: member.cleanup ?? null,
    removed: true,
    head: member.cleanup?.head ?? null,
    dirty: null,
    tracked_files: [],
    untracked_files: [],
    tracked_diff_stat: '',
    tracked_patch: '',
    tracked_patch_bytes: 0,
    tracked_patch_truncated: false,
  };
}

function parseNameStatus(value) {
  const fields = splitNul(value);
  const rows = [];
  for (let index = 0; index + 1 < fields.length; index += 2) rows.push({ status: fields[index], path: fields[index + 1] });
  return rows;
}

function splitNul(value) {
  return value.split('\0').filter(Boolean);
}

function boundedText(value, maxBytes) {
  const body = Buffer.from(value, 'utf8');
  if (body.length <= maxBytes) return { text: value, bytes: body.length, truncated: false };
  return { text: body.subarray(0, maxBytes).toString('utf8'), bytes: body.length, truncated: true };
}

function decodeUtf8(value) {
  if (value.includes(0)) return null;
  try { return new TextDecoder('utf-8', { fatal: true }).decode(value); }
  catch { return null; }
}

function git(cwd, args) {
  const result = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8', windowsHide: true });
  if (result.error || result.status !== 0) failGit(args);
  return result.stdout ?? '';
}

function gitBuffer(cwd, args) {
  const result = spawnSync('git', ['-C', cwd, ...args], { encoding: null, windowsHide: true });
  if (result.error || result.status !== 0) failGit(args);
  return result.stdout ?? Buffer.alloc(0);
}

function gitApply(cwd, patch, checkOnly) {
  const args = ['-C', cwd, 'apply', '--whitespace=nowarn', ...(checkOnly ? ['--check'] : []), '-'];
  const result = spawnSync('git', args, { input: patch, encoding: 'utf8', windowsHide: true });
  if (result.error || result.status !== 0) {
    fail('request_conflict', checkOnly
      ? 'Candidate tracked changes do not apply cleanly to the destination workspace.'
      : 'Candidate tracked changes could not be applied to the destination workspace.', {
      category: 'conflict', submission: 'not_sent', details: { operation: checkOnly ? 'git apply --check' : 'git apply' },
    });
  }
}

function failGit(args) {
  fail('invalid_workspace', 'Git candidate operation failed.', {
    category: 'user', submission: 'not_sent', details: { operation: args.slice(0, 2).join(' ') },
  });
}
