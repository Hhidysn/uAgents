import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fail } from '../protocol/errors.mjs';
import { uuidPattern } from '../protocol/schema.mjs';
import { pathIsWithin } from '../path-containment.mjs';
import { canonicalWorkspace } from '../runtime/workspace-key.mjs';

// Dispatcher admission limits. Native Agent permissions remain a separate boundary.
export class ServicePolicy {
  constructor(config, runtime) { this.config = config; this.runtime = runtime; }

  target(target) {
    if (!this.config.targets.includes(target)) deny('Target is outside the service scope.');
  }

  workspace(workspace, { history = false } = {}) {
    const canonical = history ? historyPath(workspace) : canonicalWorkspace(workspace);
    if (!this.config.workspace_roots.some(root => pathIsWithin(root, canonical))) deny('Workspace is outside the service scope.');
    return canonical;
  }

  source(source) {
    if (typeof source !== 'string' || !path.isAbsolute(source)) deny('Attachment source must be an absolute path.');
    let real;
    try { real = fs.realpathSync.native(source); } catch { deny('Attachment source could not be resolved.'); }
    const canonical = process.platform === 'win32' ? real.normalize('NFC').toLocaleLowerCase('en-US') : real.normalize('NFC');
    for (const protectedPath of this.config.protected_paths ?? []) {
      let protectedReal;
      try { protectedReal = fs.realpathSync.native(protectedPath); } catch { continue; }
      if ((process.platform === 'win32' ? protectedReal.normalize('NFC').toLocaleLowerCase('en-US') : protectedReal.normalize('NFC')) === canonical) deny('Service credential cannot be used as an attachment.');
    }
    if (!this.config.workspace_roots.some(root => pathIsWithin(root, canonical))) deny('Attachment source is outside the service scope.');
    return canonical;
  }

  repository(workspace) {
    this.workspace(workspace);
    const result = spawnSync('git', ['-C', workspace, 'rev-parse', '--show-toplevel'], {
      encoding: 'utf8', windowsHide: true, shell: false, timeout: 10000, maxBuffer: 8192,
    });
    if (result.error || result.status !== 0) deny('Council repository could not be resolved within the service scope.');
    return this.workspace(result.stdout.trim());
  }

  inputs(input) {
    const workspace = this.workspace(input.workspace);
    for (const attachment of input.attachments ?? []) this.source(attachment.local_path);
    for (const item of input.inputs ?? []) {
      if (item.source !== undefined) this.source(item.source);
      if (item.path !== undefined) {
        if (typeof item.path !== 'string' || path.isAbsolute(item.path)) deny('Input path must be workspace-relative.');
        const file = this.source(path.resolve(workspace, item.path));
        if (!pathIsWithin(workspace, file)) deny('Input path escapes its workspace.');
      }
    }
  }

  session(session) {
    if (session?.continue_from_task_id) this.task(session.continue_from_task_id);
    if (session?.fork_from_task_id) this.task(session.fork_from_task_id);
  }

  task(taskId) {
    const status = this.runtime.status(taskId);
    this.target(status.target);
    const request = this.runtime.service.payload(taskId).request;
    try { this.workspace(request.workspace, { history: true }); }
    catch (error) {
      if (error.code !== 'service_scope_denied' || !this.derivedCouncilTask(taskId, request.workspace)) throw error;
    }
    return status;
  }

  acceptsTask(status) {
    try { this.task(status.task_id); return true; } catch { return false; }
  }

  derivedCouncilTask(taskId, workspace) {
    if (typeof workspace !== 'string') return false;
    const relative = path.relative(path.join(this.runtime.stateRoot, 'councils'), path.resolve(workspace)).split(path.sep);
    if (!uuidPattern.test(relative[0] ?? '') || relative[1] !== 'worktrees' || relative[2] !== taskId) return false;
    const council = this.council(relative[0]);
    const member = council.manifest.members.find(item => item.task_id === taskId);
    if (!member?.worktree) return false;
    return historyPath(member.worktree.workspace) === historyPath(workspace);
  }

  council(councilId) {
    if (!uuidPattern.test(councilId ?? '')) deny('Council ID is invalid.');
    const directory = path.join(this.runtime.stateRoot, 'councils', councilId.toLowerCase());
    const request = JSON.parse(fs.readFileSync(path.join(directory, 'request.json'), 'utf8'));
    const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'manifest.json'), 'utf8'));
    this.workspace(request.workspace, { history: true });
    if (request.workspace_strategy === 'git-worktree' && fs.existsSync(request.workspace)) this.repository(request.workspace);
    for (const member of request.members) this.target(member.target);
    // Worktree paths are Core-generated and authorized through the source Council.
    const state = historyPath(this.runtime.stateRoot);
    const worktrees = path.join(state, 'councils', councilId.toLowerCase(), 'worktrees');
    if (historyPath(path.join(directory, 'worktrees')) !== worktrees) deny('Council worktree directory redirects outside its managed location.');
    for (const member of manifest.members) {
      if (member.worktree) {
        const memberRoot = historyPath(member.worktree.worktree_root);
        if (!pathIsWithin(worktrees, memberRoot) || !pathIsWithin(memberRoot, historyPath(member.worktree.workspace))) deny('Council worktree is outside its managed directory.');
      }
    }
    return { request, manifest };
  }

  authorize(name, input) {
    if (!this.config.tools.includes(name)) deny('Tool is disabled by the service configuration.');
    if (name === 'uagents_submit') {
      this.target(input.target); this.inputs(input); this.session(input.session);
    } else if (name === 'uagents_council_submit') {
      this.inputs(input);
      if (input.workspace_strategy === 'git-worktree') this.repository(input.workspace);
      for (const member of input.members ?? []) { this.target(member.target); this.session(member.session); }
    } else if (name.startsWith('uagents_council_')) {
      this.council(input.council_id);
      if (name === 'uagents_council_adopt') this.repository(input.workspace);
    } else if (input.task_id) this.task(input.task_id);
    else if (input.target) this.target(input.target);
  }

  listTasks(input) {
    // Preserve Core cursors; advance across inaccessible records without exposing them.
    const limit = input.limit ?? 50;
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) fail('invalid_request', 'Task list limit must be 1-200.');
    let cursor = input.cursor ?? null;
    const tasks = [];
    for (let page = 0; page < 20; page++) {
      const result = this.runtime.listTasks({ cursor, limit: Math.max(1, limit - tasks.length) });
      for (const status of result.tasks) if (this.acceptsTask(status)) tasks.push(status);
      cursor = result.next_cursor;
      if (!cursor || tasks.length === limit) break;
    }
    return { tasks, next_cursor: cursor };
  }
}

function deny(message) { fail('service_scope_denied', message, { category: 'policy', submission: 'not_sent' }); }

// Resolve the nearest surviving ancestor for historical records. Existing
// junctions are still resolved, while deleting a workspace does not revoke its
// persisted task history. Execution admission separately requires a directory.
function historyPath(value) {
  if (typeof value !== 'string' || !path.isAbsolute(value)) deny('Historical workspace must be absolute.');
  let ancestor = path.resolve(value); const missing = [];
  while (!fs.existsSync(ancestor)) {
    const parent = path.dirname(ancestor);
    if (parent === ancestor) deny('Historical workspace could not be resolved.');
    missing.unshift(path.basename(ancestor)); ancestor = parent;
  }
  const real = path.join(fs.realpathSync.native(ancestor), ...missing).normalize('NFC');
  return process.platform === 'win32' ? real.toLocaleLowerCase('en-US') : real;
}
