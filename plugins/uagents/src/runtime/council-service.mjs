import fs from 'node:fs';
import path from 'node:path';
import { canonicalHash } from '../protocol/canonical-json.mjs';
import { errorRecord, fail } from '../protocol/errors.mjs';
import { buildCouncilMemberRequests, parseCouncilRequest } from '../protocol/council-schema.mjs';
import { evaluateRequest } from '../policy/evaluate.mjs';
import { atomicWriteJson } from '../store/task-files.mjs';
import { uuidPattern } from '../protocol/schema.mjs';
import { adoptCouncilWorktree, inspectCouncilWorktree, inspectCouncilWorktreeDiff, prepareCouncilWorktrees } from './council-worktrees.mjs';

const TERMINAL = new Set(['succeeded', 'failed', 'cancelled']);
const ATTENTION = new Set(['waiting_user', 'indeterminate']);

export class CouncilService {
  constructor({ stateRoot, registry, submitTask, statusTask, resultTask, clock = () => Date.now() }) {
    this.stateRoot = stateRoot;
    this.registry = registry;
    this.submitTask = submitTask;
    this.statusTask = statusTask;
    this.resultTask = resultTask;
    this.clock = clock;
  }

  submit(input) {
    const council = parseCouncilRequest(input);
    const provisionalRequests = buildCouncilMemberRequests(council);
    for (const request of provisionalRequests) evaluateRequest(request, { registry: this.registry });
    const hash = canonicalHash(council);
    const directory = councilDirectory(this.stateRoot, council.council_id);
    fs.mkdirSync(directory, { recursive: true });
    const requestFile = path.join(directory, 'request.json');
    const manifestFile = path.join(directory, 'manifest.json');
    let manifest = readJsonIfExists(manifestFile);
    const duplicate = Boolean(manifest);
    let worktreePlan = null;
    if (manifest) {
      if (manifest.request_hash !== hash && !legacyCouncilHashMatches(manifest, council)) {
        fail('request_conflict', 'council_id is already registered with different content.', { category: 'conflict', submission: 'not_sent' });
      }
    } else {
      worktreePlan = prepareCouncilWorktrees({ stateRoot: this.stateRoot, council });
      atomicWriteJson(requestFile, council);
      manifest = {
        schema_version: council.schema_version,
        council_id: council.council_id,
        request_hash: hash,
        strategy: council.strategy,
        mode: council.mode,
        workspace_strategy: council.workspace_strategy,
        base_head: worktreePlan?.base_head ?? null,
        created_at_ms: this.clock(),
        members: council.members.map(member => ({
          member_id: member.member_id,
          target: member.target,
          model: member.model,
          task_id: member.task_id,
          worktree: worktreePlan?.members.find(item => item.member_id === member.member_id) ?? null,
          registration_error: null,
        })),
      };
      atomicWriteJson(manifestFile, manifest);
    }

    const workspaces = Object.fromEntries(manifest.members
      .filter(member => member.worktree)
      .map(member => [member.member_id, member.worktree.workspace]));
    const memberRequests = buildCouncilMemberRequests(council, workspaces);
    for (const request of memberRequests) evaluateRequest(request, { registry: this.registry });

    for (const [index, request] of memberRequests.entries()) {
      try {
        this.submitTask(request);
        manifest.members[index].registration_error = null;
      } catch (error) {
        manifest.members[index].registration_error = errorRecord(error);
      }
      atomicWriteJson(manifestFile, manifest);
    }
    return { ...this.status(council.council_id), duplicate };
  }

  status(councilId) {
    const manifest = this.#manifest(councilId);
    const members = manifest.members.map(member => {
      let task = null;
      if (!member.registration_error) {
        try { task = this.statusTask(member.task_id); }
        catch (error) { if (error.code !== 'task_not_found') throw error; }
      }
      return { ...member, task };
    });
    return {
      schema_version: manifest.schema_version,
      council_id: manifest.council_id,
      strategy: manifest.strategy,
      mode: manifest.mode ?? 'analysis',
      workspace_strategy: manifest.workspace_strategy ?? 'shared',
      base_head: manifest.base_head ?? null,
      status: councilState(members),
      members,
      created_at_ms: manifest.created_at_ms,
    };
  }

  result(councilId) {
    const status = this.status(councilId);
    return {
      ...status,
      members: status.members.map(member => ({
        ...member,
        worktree: inspectCouncilWorktree(member),
        result: member.task ? this.resultTask(member.task_id) : null,
      })),
    };
  }

  diff(councilId) {
    const status = this.status(councilId);
    if (status.workspace_strategy !== 'git-worktree') {
      fail('unsupported_capability', 'council-diff requires a git-worktree Council.', { submission: 'not_sent' });
    }
    return {
      schema_version: status.schema_version,
      council_id: status.council_id,
      strategy: status.strategy,
      mode: status.mode,
      workspace_strategy: status.workspace_strategy,
      base_head: status.base_head,
      status: status.status,
      members: status.members.map(member => {
        const result = member.task ? this.resultTask(member.task_id) : null;
        return {
          member_id: member.member_id,
          target: member.target,
          model: member.model,
          task_id: member.task_id,
          registration_error: member.registration_error,
          task: member.task ? {
            status: member.task.status,
            native_outcome: member.task.native_outcome,
            objective_verdict: member.task.objective_verdict,
          } : null,
          result: result ? {
            response: result.response,
            usage: result.usage,
            artifacts: result.artifacts,
          } : null,
          worktree: inspectCouncilWorktreeDiff(member),
        };
      }),
      created_at_ms: status.created_at_ms,
    };
  }

  adopt(councilId, { memberId, workspace }) {
    const status = this.status(councilId);
    if (status.workspace_strategy !== 'git-worktree') {
      fail('unsupported_capability', 'council-adopt requires a git-worktree Council.', { submission: 'not_sent' });
    }
    const member = status.members.find(item => item.member_id === memberId);
    if (!member) fail('invalid_request', `Unknown Council member: ${memberId}`);
    if (member.task?.status !== 'succeeded') {
      fail('request_conflict', 'Only a succeeded Council member can be adopted.', {
        category: 'conflict', submission: 'not_sent', details: { member_id: memberId, status: member.task?.status ?? null },
      });
    }
    return {
      schema_version: status.schema_version,
      council_id: status.council_id,
      member_id: member.member_id,
      target: member.target,
      model: member.model,
      ...adoptCouncilWorktree(member, workspace),
    };
  }

  #manifest(councilId) {
    const manifest = readJsonIfExists(path.join(councilDirectory(this.stateRoot, councilId), 'manifest.json'));
    if (!manifest) fail('task_not_found', `Unknown council: ${councilId}`);
    return manifest;
  }
}

function councilState(members) {
  if (members.some(member => member.registration_error || member.task === null)) return 'partial';
  if (members.every(member => TERMINAL.has(member.task.status))) return 'complete';
  if (members.some(member => ATTENTION.has(member.task.status))) return 'attention';
  return 'running';
}

function councilDirectory(root, councilId) {
  if (!uuidPattern.test(councilId ?? '')) fail('invalid_request_id', 'council_id must be a canonical UUID.');
  return path.join(root, 'councils', councilId.toLowerCase());
}

function readJsonIfExists(file) {
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function legacyCouncilHashMatches(manifest, council) {
  if (manifest.mode !== undefined || manifest.workspace_strategy !== undefined) return false;
  const legacy = { ...council };
  delete legacy.mode;
  delete legacy.workspace_strategy;
  return canonicalHash(legacy) === manifest.request_hash;
}
