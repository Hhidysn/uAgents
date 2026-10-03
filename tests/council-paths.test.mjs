import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { adoptCouncilWorktree, inspectCouncilWorktreeDiff } from '../plugins/uagents/src/runtime/council-candidates.mjs';

const base = path.resolve('.local', 'test-runs', `cp-${randomUUID().slice(0, 8)}`);
const secret = 'token=outside-secret-fixture';

test('ordinary untracked text can be inspected and adopted with nested directories', () => {
  fixture('ordinary', ({ member, repository, source }) => {
    fs.mkdirSync(path.join(source, 'nested', 'deeper'), { recursive: true });
    fs.writeFileSync(path.join(source, 'nested', 'deeper', 'candidate.txt'), 'candidate text\n');
    fs.writeFileSync(path.join(source, 'base.txt'), 'tracked candidate\n');
    const diff = inspectCouncilWorktreeDiff(member);
    assert.equal(diff.untracked_files[0].text, 'candidate text\n');
    const result = adoptCouncilWorktree(member, repository);
    assert.equal(result.applied.untracked_files.length, 1);
    assert.equal(fs.readFileSync(path.join(repository, 'nested', 'deeper', 'candidate.txt'), 'utf8'), 'candidate text\n');
    assert.equal(fs.readFileSync(path.join(repository, 'base.txt'), 'utf8'), 'tracked candidate\n');
  });
});

test('an untracked file symlink remains a descriptor and never reveals external contents', t => {
  fixture('diff-symlink', ({ member, source, outside }) => {
    const external = path.join(outside, 'secret.txt');
    fs.writeFileSync(external, secret);
    if (!fileSymlink(t, external, path.join(source, 'linked.txt'))) return;
    const diff = inspectCouncilWorktreeDiff(member);
    const link = diff.untracked_files.find(file => file.path === 'linked.txt');
    assert.ok(link);
    assert.equal(link.symlink, true);
    assert.equal(link.text, undefined);
    assert.equal(JSON.stringify(diff).includes(secret), false);
  });
});

test('untracked hardlinks do not reveal contents or get adopted', () => {
  fixture('hardlink', ({ member, repository, source, outside }) => {
    const external = path.join(outside, 'secret.txt');
    fs.writeFileSync(external, secret);
    fs.linkSync(external, path.join(source, 'linked.txt'));
    assert.ok(fs.lstatSync(path.join(source, 'linked.txt')).nlink > 1);
    const diff = inspectCouncilWorktreeDiff(member);
    assert.equal(diff.untracked_files.find(file => file.path === 'linked.txt').text, undefined);
    assert.equal(JSON.stringify(diff).includes(secret), false);
    assert.throws(() => adoptCouncilWorktree(member, repository), { code: 'unsupported_capability' });
    assert.equal(fs.existsSync(path.join(repository, 'linked.txt')), false);
    assert.equal(fs.readFileSync(external, 'utf8'), secret);
  });
});

test('an untracked directory junction cannot reveal external contents in diff', t => {
  fixture('diff-junction', ({ member, source, outside }) => {
    fs.writeFileSync(path.join(outside, 'secret.txt'), secret);
    if (!directoryLink(t, outside, path.join(source, 'redirect'))) return;
    const diff = inspectCouncilWorktreeDiff(member);
    assert.ok(diff.untracked_files.some(file => file.path.startsWith('redirect')));
    assert.equal(JSON.stringify(diff).includes(secret), false);
    assert.equal(diff.untracked_files.filter(file => file.path.startsWith('redirect')).every(file => file.text === undefined), true);
  });
});

test('adopt refuses a destination ancestor junction before creating outside directories or applying a patch', t => {
  fixture('destination-junction', ({ member, repository, source, outside }) => {
    fs.mkdirSync(path.join(source, 'nested', 'redirect', 'new'), { recursive: true });
    fs.writeFileSync(path.join(source, 'nested', 'redirect', 'new', 'candidate.txt'), 'candidate');
    fs.writeFileSync(path.join(source, 'base.txt'), 'tracked candidate\n');
    fs.mkdirSync(path.join(repository, 'nested'));
    const external = path.join(outside, 'must-not-change.txt');
    fs.writeFileSync(external, secret);
    const mode = fs.statSync(external).mode;
    if (!directoryLink(t, outside, path.join(repository, 'nested', 'redirect'))) return;
    assert.throws(() => adoptCouncilWorktree(member, repository), { code: 'request_conflict' });
    assert.equal(fs.existsSync(path.join(outside, 'new')), false);
    assert.equal(fs.readFileSync(external, 'utf8'), secret);
    assert.equal(fs.statSync(external).mode, mode);
    assert.equal(fs.readFileSync(path.join(repository, 'base.txt'), 'utf8'), 'base\n');
  });
});

test('adopt rechecks the source realpath when an ancestor becomes an external junction', t => {
  fixture('source-junction', ({ member, repository, source, outside }) => {
    const directory = path.join(source, 'nested');
    fs.mkdirSync(directory);
    fs.writeFileSync(path.join(directory, 'candidate.txt'), 'candidate');
    fs.writeFileSync(path.join(outside, 'candidate.txt'), secret);
    const probe = path.join(source, 'link-probe');
    if (!directoryLink(t, outside, probe)) return;
    fs.unlinkSync(probe);
    let replaced = false;
    assert.throws(() => adoptCouncilWorktree(member, repository, { beforeMutation: () => {
      if (!replaced) {
        replaced = true;
        fs.renameSync(directory, path.join(source, 'original-nested'));
        fs.symlinkSync(outside, directory, process.platform === 'win32' ? 'junction' : 'dir');
      }
    } }), { code: 'request_conflict' });
    assert.equal(replaced, true);
    assert.equal(fs.existsSync(path.join(repository, 'nested', 'candidate.txt')), false);
    assert.equal(fs.readFileSync(path.join(outside, 'candidate.txt'), 'utf8'), secret);
  });
});

test('adopt refuses a pre-existing dangling destination link', t => {
  fixture('dangling-destination', ({ member, repository, source, outside }) => {
    fs.writeFileSync(path.join(source, 'candidate.txt'), 'candidate');
    const external = path.join(outside, 'must-not-be-created.txt');
    const createLink = process.platform === 'win32' ? directoryLink : fileSymlink;
    if (!createLink(t, external, path.join(repository, 'candidate.txt'))) return;
    assert.equal(fs.existsSync(path.join(repository, 'candidate.txt')), false);
    assert.throws(() => adoptCouncilWorktree(member, repository), { code: 'request_conflict' });
    assert.equal(fs.existsSync(external), false);
  });
});

test('exclusive adoption copy refuses a destination hardlink created after preflight', () => {
  fixture('exclusive-copy', ({ member, repository, source, outside }) => {
    fs.writeFileSync(path.join(source, 'candidate.txt'), 'candidate');
    const external = path.join(outside, 'must-not-change.txt');
    fs.writeFileSync(external, secret);
    let linked = false;
    assert.throws(() => adoptCouncilWorktree(member, repository, { beforeMutation: () => {
      if (!linked) {
        linked = true;
        fs.linkSync(external, path.join(repository, 'candidate.txt'));
      }
    } }), { code: 'request_conflict' });
    assert.equal(fs.readFileSync(external, 'utf8'), secret);
  });
});

test('adopt refuses permission changes when the copied destination is replaced with an external hardlink', () => {
  fixture('chmod-hardlink', ({ member, repository, source, outside }) => {
    const candidate = path.join(source, 'candidate.txt');
    fs.writeFileSync(candidate, 'candidate');
    fs.chmodSync(candidate, 0o600);
    const external = path.join(outside, 'must-not-change.txt');
    fs.writeFileSync(external, secret);
    const originalMode = fs.statSync(external).mode;
    let mutations = 0;
    assert.throws(() => adoptCouncilWorktree(member, repository, { beforeMutation: () => {
      if (++mutations === 2) {
        const destination = path.join(repository, 'candidate.txt');
        fs.unlinkSync(destination);
        fs.linkSync(external, destination);
      }
    } }), { code: 'request_conflict' });
    assert.equal(fs.readFileSync(external, 'utf8'), secret);
    assert.equal(fs.statSync(external).mode, originalMode);
  });
});

function fixture(name, operation) {
  const root = path.join(base, name);
  const repository = path.join(root, 'repo');
  const source = path.join(root, 'candidate');
  const outside = path.join(root, 'outside');
  fs.mkdirSync(repository, { recursive: true });
  fs.mkdirSync(outside);
  git(repository, ['init']);
  git(repository, ['config', 'user.email', 'paths-fixture@example.invalid']);
  git(repository, ['config', 'user.name', 'Council Paths Fixture']);
  git(repository, ['config', 'core.autocrlf', 'false']);
  fs.writeFileSync(path.join(repository, 'base.txt'), 'base\n');
  git(repository, ['add', 'base.txt']);
  git(repository, ['commit', '-m', 'base']);
  const baseHead = git(repository, ['rev-parse', 'HEAD']).trim();
  const branch = `candidate-${randomUUID().slice(0, 8)}`;
  git(repository, ['worktree', 'add', '-b', branch, source, baseHead]);
  const member = { member_id: 'candidate', task_id: randomUUID(), worktree: {
    workspace: source, worktree_root: source, base_head: baseHead, branch,
  } };
  operation({ root, repository, source, outside, member });
}

function fileSymlink(t, target, link) {
  try { fs.symlinkSync(target, link, 'file'); return true; }
  catch (error) { t.skip(`file symlink unavailable: ${error.code}`); return false; }
}

function directoryLink(t, target, link) {
  try { fs.symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir'); return true; }
  catch (error) { t.skip(`directory junction unavailable: ${error.code}`); return false; }
}

function git(cwd, args) {
  const result = spawnSync('git', ['-C', cwd, ...args], { windowsHide: true, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}
