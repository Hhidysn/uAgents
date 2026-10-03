import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { canonicalHash } from '../protocol/canonical-json.mjs';
import { errorRecord, fail } from '../protocol/errors.mjs';
import { buildCouncilMemberRequests, parseCouncilRequest } from '../protocol/council-schema.mjs';
import { evaluateRequest } from '../policy/evaluate.mjs';
import { atomicWriteJson } from '../store/task-files.mjs';
import { ControlDatabase } from '../store/database.mjs';
import { uuidPattern } from '../protocol/schema.mjs';
import { executeCouncilWorktreeCleanup, inspectCouncilWorktree, prepareCouncilWorktreeCleanup, prepareCouncilWorktrees } from './council-worktrees.mjs';
import { adoptCouncilWorktree, inspectCouncilWorktreeDiff } from './council-candidates.mjs';
import { parseCouncilValidation } from '../protocol/council-validation-schema.mjs';
import { loadCouncilValidationProfile } from '../protocol/council-validation-profiles.mjs';
import { runCouncilValidation } from './council-validation.mjs';
import { blobAttachmentIdentity } from '../artifacts/attachments.mjs';
import { acquireLeaseRow, assertFencing, releaseLeases, renewLeases } from './leases.mjs';

const TERMINAL = new Set(['succeeded', 'failed', 'cancelled']);
const ATTENTION = new Set(['waiting_user', 'indeterminate']);
const COUNCIL_LEASE_TTL_MS = 5 * 60_000;
const VALIDATION_LEASE_MARGIN_MS = 30_000;

export class CouncilService {
  constructor({ stateRoot, control = null, registry, submitTask, statusTask, resultTask, clock = () => Date.now() }) {
    this.stateRoot = stateRoot;
    this.control = control;
    this.registry = registry;
    this.submitTask = submitTask;
    this.statusTask = statusTask;
    this.resultTask = resultTask;
    this.clock = clock;
  }

  submit(input) {
    const council = parseCouncilRequest(input);
    return this.#withCouncilLease(council.council_id, 'submit', lease => this.#submit(council, lease));
  }

  #submit(council, lease) {
    const provisionalRequests = buildCouncilMemberRequests(council);
    for (const request of provisionalRequests) evaluateRequest(request, { registry: this.registry });
    const hash = canonicalHash(council);
    const directory = councilDirectory(this.stateRoot, council.council_id);
    this.#guardLease(lease, { renew: true });
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
      this.#guardLease(lease, { renew: true });
      worktreePlan = prepareCouncilWorktrees({ stateRoot: this.stateRoot, council,
        beforeMutation: () => this.#guardLease(lease, { renew: true }) });
      this.#writeJson(lease, requestFile, storedCouncilRequest(council));
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
      this.#writeJson(lease, manifestFile, manifest);
    }

    const workspaces = Object.fromEntries(manifest.members
      .filter(member => member.worktree)
      .map(member => [member.member_id, member.worktree.workspace]));
    const memberRequests = buildCouncilMemberRequests(council, workspaces);
    for (const request of memberRequests) evaluateRequest(request, { registry: this.registry });

    for (const [index, request] of memberRequests.entries()) {
      if (manifest.members[index].cleanup?.removed) continue;
      this.#guardLease(lease, { renew: true });
      try {
        this.submitTask(request);
        manifest.members[index].registration_error = null;
      } catch (error) {
        manifest.members[index].registration_error = errorRecord(error);
      }
      this.#writeJson(lease, manifestFile, manifest);
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
    return this.#withCouncilLease(councilId, 'adopt', lease => this.#adopt(councilId, { memberId, workspace }, lease));
  }

  #adopt(councilId, { memberId, workspace }, lease) {
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
    this.#guardLease(lease, { renew: true });
    const adopted = adoptCouncilWorktree(member, workspace, {
      beforeMutation: () => this.#guardLease(lease, { renew: true }),
    });
    this.#guardLease(lease);
    return {
      schema_version: status.schema_version,
      council_id: status.council_id,
      member_id: member.member_id,
      target: member.target,
      model: member.model,
      ...adopted,
    };
  }

  validate(councilId, { memberId = null, all = false, validation = null, profile = null }) {
    return this.#withCouncilLease(councilId, 'validate', lease =>
      this.#validate(councilId, { memberId, all, validation, profile }, lease));
  }

  #validate(councilId, { memberId, all, validation, profile }, lease) {
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
    const checks = parsedValidation.checks ?? [parsedValidation];
    const commandCount = selected.length * checks.length;
    const timeoutBudget = selected.length * checks.reduce((sum, check) => sum + check.timeout_ms, 0);
    // spawnSync blocks the event loop: reserve the entire worst-case sequence
    // before running any command, including all members even on_failure=stop.
    lease.ttlMs = Math.max(COUNCIL_LEASE_TTL_MS,
      timeoutBudget + commandCount * 1000 + VALIDATION_LEASE_MARGIN_MS);
    this.#guardLease(lease, { renew: true });
    for (const member of selected) {
      this.#guardLease(lease);
      const evidence = runCouncilValidation(member, parsedValidation, {
        clock: this.clock, beforeCheck: () => this.#guardLease(lease),
      });
      this.#guardLease(lease);
      if (source.profile_name) evidence.profile = { name: source.profile_name, file: source.profile_file };
      const stored = manifest.members.find(item => item.member_id === member.member_id);
      stored.validation = evidence;
      this.#writeJson(lease, path.join(councilDirectory(this.stateRoot, councilId), 'manifest.json'), manifest);
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
    return this.#withCouncilLease(councilId, 'cleanup', lease =>
      this.#cleanup(councilId, { memberId, all, force }, lease));
  }

  #cleanup(councilId, { memberId, all, force }, lease) {
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
    const plans = selected.map(member => {
      this.#guardLease(lease, { renew: true });
      return prepareCouncilWorktreeCleanup(member, { force });
    });
    const manifest = this.#manifest(councilId);
    const results = [];
    for (const plan of plans) {
      this.#guardLease(lease, { renew: true });
      const result = { member_id: plan.member_id, cleanup: executeCouncilWorktreeCleanup(plan, {
        beforeMutation: () => this.#guardLease(lease, { renew: true }),
      }) };
      this.#guardLease(lease);
      const member = manifest.members.find(item => item.member_id === result.member_id);
      if (!result.cleanup.already_removed) {
        member.cleanup = { ...result.cleanup, cleaned_at_ms: this.clock() };
        this.#writeJson(lease, path.join(councilDirectory(this.stateRoot, councilId), 'manifest.json'), manifest);
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

  #withCouncilLease(councilId, operation, callback) {
    councilDirectory(this.stateRoot, councilId);
    const control = this.control ?? new ControlDatabase(this.stateRoot);
    let context;
    try {
      const lease = control.transaction(database => acquireLeaseRow(database,
        `council:${councilId.toLowerCase()}`, 'council', randomUUID(),
        COUNCIL_LEASE_TTL_MS, this.clock(), { operation }));
      context = { control, lease, ttlMs: COUNCIL_LEASE_TTL_MS };
      return callback(context);
    } finally {
      // Expired leases can only be taken over by an explicit later mutation.
      // A crash retains its full budget; callers inspect persisted results
      // and confirm old processes ended before explicitly retrying validation.
      try { if (context) releaseLeases(control, [context.lease]); }
      finally { if (!this.control) control.close(); }
    }
  }

  #guardLease(context, { renew = false } = {}) {
    const now = this.clock();
    return context.control.transaction(database => {
      assertFencing(database, context.lease, now);
      if (renew) context.lease = renewLeases(context.control, [context.lease], {
        ttlMs: context.ttlMs, now,
      })[0];
    });
  }

  #writeJson(context, file, value) {
    this.#guardLease(context);
    atomicWriteJson(file, value);
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
