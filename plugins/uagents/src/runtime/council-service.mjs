import fs from 'node:fs';
import path from 'node:path';
import { canonicalHash } from '../protocol/canonical-json.mjs';
import { errorRecord, fail } from '../protocol/errors.mjs';
import { buildCouncilMemberRequests, parseCouncilRequest } from '../protocol/council-schema.mjs';
import { evaluateRequest } from '../policy/evaluate.mjs';
import { atomicWriteJson } from '../store/task-files.mjs';
import { uuidPattern } from '../protocol/schema.mjs';
import { executeCouncilWorktreeCleanup, inspectCouncilWorktree, prepareCouncilWorktreeCleanup, prepareCouncilWorktrees } from './council-worktrees.mjs';
import { adoptCouncilWorktree, inspectCouncilWorktreeDiff } from './council-candidates.mjs';
import { parseCouncilValidation } from '../protocol/council-validation-schema.mjs';
import { loadCouncilValidationProfile } from '../protocol/council-validation-profiles.mjs';
import { runCouncilValidation } from './council-validation.mjs';
import { blobAttachmentIdentity } from '../artifacts/attachments.mjs';

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
      atomicWriteJson(requestFile, storedCouncilRequest(council));
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
      if (manifest.members[index].cleanup?.removed) continue;
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
          validation: member.validation ?? null,
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

  validate(councilId, { memberId = null, all = false, validation = null, profile = null }) {
    if (Boolean(memberId) === Boolean(all)) fail('invalid_request', 'Council validation requires exactly one of memberId or all=true.');
    if (Boolean(validation) === Boolean(profile)) fail('invalid_request', 'Council validation requires exactly one of validation or profile.');
    const status = this.status(councilId);
    if (status.workspace_strategy !== 'git-worktree') {
      fail('unsupported_capability', 'council-validate requires a git-worktree Council.', { submission: 'not_sent' });
    }
    const source = profile
      ? loadCouncilValidationProfile(this.#request(councilId)?.workspace, profile)
      : { profile_name: null, profile_file: null, validation: parseCouncilValidation(validation) };
    const parsedValidation = source.validation;
    const selected = all ? status.members : status.members.filter(member => member.member_id === memberId);
    if (!selected.length) fail('invalid_request', `Unknown Council member: ${memberId}`);
    for (const member of selected) {
      if (!member.worktree || member.cleanup?.removed || !fs.existsSync(member.worktree.worktree_root)) {
        fail('request_conflict', 'Cannot validate a Council candidate after its worktree has been cleaned up.', {
          category: 'conflict', submission: 'not_sent', details: { member_id: member.member_id },
        });
      }
      if (!member.task || !TERMINAL.has(member.task.status)) {
        fail('request_conflict', 'Council candidate validation requires a terminal member Task.', {
          category: 'conflict', submission: 'not_sent', details: { member_id: member.member_id, status: member.task?.status ?? null },
        });
      }
    }

    const manifest = this.#manifest(councilId);
    const results = [];
    for (const member of selected) {
      const evidence = runCouncilValidation(member, parsedValidation, { clock: this.clock });
      if (source.profile_name) evidence.profile = { name: source.profile_name, file: source.profile_file };
      const stored = manifest.members.find(item => item.member_id === member.member_id);
      stored.validation = evidence;
      atomicWriteJson(path.join(councilDirectory(this.stateRoot, councilId), 'manifest.json'), manifest);
      results.push({ member_id: member.member_id, target: member.target, model: member.model, validation: evidence });
    }
    return {
      schema_version: status.schema_version,
      council_id: status.council_id,
      workspace_strategy: status.workspace_strategy,
      members: results,
    };
  }

  cleanup(councilId, { memberId = null, all = false, force = false } = {}) {
    if (Boolean(memberId) === Boolean(all)) fail('invalid_request', 'Council cleanup requires exactly one of memberId or all=true.');
    const status = this.status(councilId);
    if (status.workspace_strategy !== 'git-worktree') {
      fail('unsupported_capability', 'council-cleanup requires a git-worktree Council.', { submission: 'not_sent' });
    }
    const selected = all ? status.members : status.members.filter(member => member.member_id === memberId);
    if (!selected.length) fail('invalid_request', `Unknown Council member: ${memberId}`);
    for (const member of selected) {
      if (member.task && !TERMINAL.has(member.task.status)) {
        fail('request_conflict', 'Cannot clean up a Council member while its Task is nonterminal.', {
          category: 'conflict', submission: 'not_sent', details: { member_id: member.member_id, status: member.task.status },
        });
      }
    }
    const plans = selected.map(member => prepareCouncilWorktreeCleanup(member, { force }));
    const manifest = this.#manifest(councilId);
    const results = [];
    for (const plan of plans) {
      const result = { member_id: plan.member_id, cleanup: executeCouncilWorktreeCleanup(plan) };
      const member = manifest.members.find(item => item.member_id === result.member_id);
      if (!result.cleanup.already_removed) {
        member.cleanup = { ...result.cleanup, cleaned_at_ms: this.clock() };
        atomicWriteJson(path.join(councilDirectory(this.stateRoot, councilId), 'manifest.json'), manifest);
      }
      results.push(result);
    }
    return {
      schema_version: status.schema_version,
      council_id: status.council_id,
      workspace_strategy: status.workspace_strategy,
      members: results.map(result => ({
        member_id: result.member_id,
        cleanup: result.cleanup.already_removed
          ? result.cleanup
          : manifest.members.find(item => item.member_id === result.member_id).cleanup,
      })),
    };
  }

  #manifest(councilId) {
    const manifest = readJsonIfExists(path.join(councilDirectory(this.stateRoot, councilId), 'manifest.json'));
    if (!manifest) fail('task_not_found', `Unknown council: ${councilId}`);
    return manifest;
  }

  #request(councilId) {
    const request = readJsonIfExists(path.join(councilDirectory(this.stateRoot, councilId), 'request.json'));
    if (!request) fail('task_not_found', `Unknown council: ${councilId}`);
    return request;
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

function storedCouncilRequest(council) {
  return {
    ...council,
    inputs: council.inputs.map(input => {
      if (!input.blob) return input;
      const identity = blobAttachmentIdentity(input);
      return {
        type: input.type,
        blob: {
          name: input.blob.name,
          data_base64: null,
          media_type: identity.media_type,
          size_bytes: identity.size_bytes,
          sha256: identity.sha256,
          ...(identity.width_px ? { width_px: identity.width_px, height_px: identity.height_px } : {}),
        },
      };
    }),
  };
}
