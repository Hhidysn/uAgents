import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fail } from '../protocol/errors.mjs';

export function prepareCouncilWorktrees({ stateRoot, council }) {
  if (council.workspace_strategy !== 'git-worktree') return null;
  if (!council.workspace) fail('invalid_workspace', 'git-worktree Council requires workspace.');

  const sourceWorkspace = path.resolve(council.workspace);
  const repository = git(sourceWorkspace, ['rev-parse', '--show-toplevel']).trim();
  const baseHead = git(sourceWorkspace, ['rev-parse', 'HEAD']).trim();
  const relativeWorkspace = path.relative(repository, sourceWorkspace);
  const worktreesRoot = path.join(stateRoot, 'councils', council.council_id, 'worktrees');
  fs.mkdirSync(worktreesRoot, { recursive: true });

  return {
    strategy: 'git-worktree',
    repository,
    source_workspace: sourceWorkspace,
    base_head: baseHead,
    members: council.members.map(member => {
      const branch = councilBranch(council.council_id, member.task_id);
      const worktreeRoot = path.join(worktreesRoot, member.task_id);
      ensureWorktree(repository, worktreeRoot, branch, baseHead);
      const workspace = relativeWorkspace ? path.join(worktreeRoot, relativeWorkspace) : worktreeRoot;
      fs.mkdirSync(workspace, { recursive: true });
      return {
        member_id: member.member_id,
        branch,
        worktree_root: worktreeRoot,
        workspace,
        base_head: baseHead,
      };
    }),
  };
}

export function inspectCouncilWorktree(member) {
  if (!member.worktree) return null;
  if (!fs.existsSync(member.worktree.worktree_root)) {
    return { ...member.worktree, cleanup: member.cleanup ?? null, removed: true, head: member.cleanup?.head ?? null, dirty: null, changes: [], diff_stat: '' };
  }
  const root = member.worktree.worktree_root;
  const head = git(root, ['rev-parse', 'HEAD']).trim();
  const status = git(root, ['status', '--porcelain=v1', '--untracked-files=all']);
  const diffStat = git(root, ['diff', '--stat', member.worktree.base_head]);
  return {
    ...member.worktree,
    cleanup: member.cleanup ?? null,
    head,
    dirty: Boolean(status.trim()),
    changes: status.split(/\r?\n/).filter(Boolean),
    diff_stat: diffStat.trim(),
  };
}

export function prepareCouncilWorktreeCleanup(member, { force = false } = {}) {
  if (!member.worktree) fail('unsupported_capability', 'Council cleanup requires a git worktree member.', { submission: 'not_sent' });
  if (member.cleanup?.removed) return { member_id: member.member_id, already_removed: true, cleanup: member.cleanup };
  const root = member.worktree.worktree_root;
  if (!fs.existsSync(root)) {
    fail('request_conflict', 'Council member worktree is missing without persisted cleanup evidence.', {
      category: 'conflict', submission: 'not_sent', details: { member_id: member.member_id },
    });
  }
  const head = git(root, ['rev-parse', 'HEAD']).trim();
  const status = git(root, ['status', '--porcelain=v1', '--untracked-files=all']);
  const dirty = Boolean(status.trim());
  const diverged = head !== member.worktree.base_head;
  if ((dirty || diverged) && !force) {
    fail('request_conflict', 'Council candidate has changes; use --force to discard it during cleanup.', {
      category: 'conflict', submission: 'not_sent',
      details: { member_id: member.member_id, dirty, diverged, head, base_head: member.worktree.base_head },
    });
  }
  const commonGitDir = git(root, ['rev-parse', '--path-format=absolute', '--git-common-dir']).trim();
  return {
    member_id: member.member_id,
    root,
    branch: member.worktree.branch,
    common_git_dir: commonGitDir,
    head,
    dirty,
    diverged,
    force: Boolean(force),
    already_removed: false,
  };
}

export function executeCouncilWorktreeCleanup(plan) {
  if (plan.already_removed) return { ...plan.cleanup, already_removed: true };
  gitWithDir(plan.common_git_dir, ['worktree', 'remove', ...(plan.force ? ['--force'] : []), plan.root]);
  const branchRef = `refs/heads/${plan.branch}`;
  const branchExists = gitDirStatus(plan.common_git_dir, ['show-ref', '--verify', '--quiet', branchRef]) === 0;
  if (branchExists) gitWithDir(plan.common_git_dir, ['branch', '-D', plan.branch]);
  return {
    removed: true,
    already_removed: false,
    forced: plan.force,
    head: plan.head,
    dirty: plan.dirty,
    diverged: plan.diverged,
    worktree_removed: !fs.existsSync(plan.root),
    branch_removed: gitDirStatus(plan.common_git_dir, ['show-ref', '--verify', '--quiet', branchRef]) !== 0,
  };
}

function ensureWorktree(repository, destination, branch, baseHead) {
  if (fs.existsSync(path.join(destination, '.git'))) return;
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  const branchExists = gitStatus(repository, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`]) === 0;
  const args = branchExists
    ? ['worktree', 'add', destination, branch]
    : ['worktree', 'add', '-b', branch, destination, baseHead];
  git(repository, args);
}

function councilBranch(councilId, taskId) {
  return `uagents/council/${councilId}/${taskId}`;
}

function git(cwd, args) {
  const result = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8', windowsHide: true });
  if (result.error || result.status !== 0) {
    fail('invalid_workspace', 'Git worktree operation failed.', {
      category: 'user', submission: 'not_sent',
      details: { operation: args.slice(0, 2).join(' ') },
    });
  }
  return result.stdout ?? '';
}

function gitStatus(cwd, args) {
  const result = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8', windowsHide: true });
  if (result.error) return 1;
  return result.status ?? 1;
}

function gitWithDir(gitDir, args) {
  const result = spawnSync('git', ['--git-dir', gitDir, ...args], { encoding: 'utf8', windowsHide: true });
  if (result.error || result.status !== 0) {
    fail('invalid_workspace', 'Git worktree cleanup failed.', {
      category: 'user', submission: 'not_sent', details: { operation: args.slice(0, 2).join(' ') },
    });
  }
  return result.stdout ?? '';
}

function gitDirStatus(gitDir, args) {
  const result = spawnSync('git', ['--git-dir', gitDir, ...args], { encoding: 'utf8', windowsHide: true });
  if (result.error) return 1;
  return result.status ?? 1;
}
