import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { evaluateRequest } from '../policy/evaluate.mjs';
import { errorRecord, fail, redactText, UAgentsError } from '../protocol/errors.mjs';
import { appendEvent } from '../store/database.mjs';
import { atomicWriteJson, atomicWriteText, readTaskJson, taskDirectory } from '../store/task-files.mjs';
import { STORE_SCHEMA_VERSION } from '../store/schema.mjs';
import { materializeEffectiveRequest } from './effective-request.mjs';
import { assertFencing } from './leases.mjs';
import { transitionState } from './state-machine.mjs';

export class TaskService {
  constructor(control, { registry, health = null, coreVersion = '0.2.0-alpha.1', clock = () => Date.now() } = {}) {
    this.control = control;
    this.registry = registry;
    this.health = health;
    this.coreVersion = coreVersion;
    this.clock = clock;
  }

  submit(input, { adapterVersion = null } = {}) {
    const evaluated = evaluateRequest(input, { registry: this.registry, health: this.health });
    const materialized = materializeEffectiveRequest(input, evaluated, { adapter_version: adapterVersion });
    const now = this.clock();
    return this.control.transaction(database => {
      const existing = database.prepare('SELECT * FROM idempotency WHERE request_id = ?').get(evaluated.request.request_id);
      if (existing) {
        if (existing.raw_hash !== materialized.raw_request_hash || existing.effective_hash !== materialized.effective_request_hash) {
          fail('request_conflict', 'request_id is already registered with different effective content.', { category: 'conflict', submission: 'not_sent' });
        }
        const resumed = this.#resumePreflightInTransaction(database, existing.task_id, { now });
        return { ...this.#statusWith(database, existing.task_id), duplicate: true, ...(resumed ? { resumed: true } : {}) };
      }

      const taskId = evaluated.request.request_id;
      const attemptId = randomUUID();
      let directory;
      try {
        directory = taskDirectory(this.control.root, taskId, { create: true });
        const runtimeWorkspace = evaluated.request.workspace ?? path.join(directory, 'workspace');
        fs.mkdirSync(runtimeWorkspace, { recursive: true });
        atomicWriteJson(path.join(directory, 'request.json'), { ...evaluated.request, workspace: runtimeWorkspace, prompt: null });
        atomicWriteJson(path.join(directory, 'payload.json'), { prompt: evaluated.request.prompt, input_snapshots: materialized.input_snapshots });
        atomicWriteJson(path.join(directory, 'decision.json'), evaluated.decision);

        database.prepare(`INSERT INTO tasks(
          task_id, request_id, raw_hash, effective_hash, target, status, model_requested, model_resolved,
          model_reported, model_verified, provider, route_id, resolution_json, verification_json,
          decision_json, store_schema_version, core_version, created_at_ms, updated_at_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(taskId, taskId, materialized.raw_request_hash, materialized.effective_request_hash, evaluated.request.target, 'registered',
            evaluated.request.model_requested, evaluated.request.model_resolved, evaluated.request.model_reported, evaluated.request.model_verified ? 1 : 0,
            evaluated.request.provider, evaluated.request.route_id, JSON.stringify(evaluated.request.model_resolution), JSON.stringify(evaluated.request.model_verification),
            JSON.stringify(evaluated.decision), STORE_SCHEMA_VERSION, this.coreVersion, now, now);
        database.prepare(`INSERT INTO attempts(attempt_id, task_id, ordinal, status, submission, adapter_version, created_at_ms)
          VALUES (?, ?, 1, 'registered', 'not_sent', ?, ?)`)
          .run(attemptId, taskId, adapterVersion, now);
        database.prepare('INSERT INTO idempotency(request_id, raw_hash, effective_hash, task_id) VALUES (?, ?, ?, ?)')
          .run(taskId, materialized.raw_request_hash, materialized.effective_request_hash, taskId);
        appendEvent(database, { taskId, attemptId, type: 'task.registered', payload: { route_id: evaluated.request.route_id }, now });
        return { ...this.#statusWith(database, taskId), duplicate: false };
      } catch (error) {
        if (directory) try { fs.rmSync(directory, { recursive: true, force: true }); } catch {}
        throw error;
      }
    });
  }

  status(taskId) { return this.#statusWith(this.control.raw, taskId); }

  // Claim the original attempt only after the worker has acquired the task
  // leases.  The claim is the second, task-local half of dispatch ownership:
  // two workers for the same request can never both pass this update while
  // the attempt is still unsent.  A claim whose lease is no longer present is
  // stale and may be replaced by a recovery worker, but a live claim is
  // returned to the caller as busy.
  claimAttempt(taskId, attemptId, lease, { now = this.clock() } = {}) {
    return this.control.transaction(database => {
      if (!lease) fail('lease_conflict', 'A dispatch lease is required to claim an attempt.', { category: 'conflict', submission: 'not_sent' });
      assertFencing(database, lease, now);
      const task = database.prepare('SELECT status, cancel_requested FROM tasks WHERE task_id = ?').get(taskId);
      if (!task) fail('task_not_found', `Unknown task: ${taskId}`);
      const attempt = database.prepare('SELECT * FROM attempts WHERE attempt_id = ? AND task_id = ?').get(attemptId, taskId);
      if (!attempt) fail('task_not_found', 'Attempt does not belong to the task.');
      const native = database.prepare('SELECT 1 FROM native_sessions WHERE attempt_id = ? LIMIT 1').get(attemptId);
      const nativeProcess = hasNativeProcess(database, attemptId);
      if (native || nativeProcess || attempt.submission !== 'not_sent' || !['registered', 'queued'].includes(task.status) || Number(task.cancel_requested) === 1) {
        return { claimed: false, reason: native ? 'native_identity' : nativeProcess ? 'native_process' : attempt.submission !== 'not_sent' ? 'submission_started' : Number(task.cancel_requested) === 1 ? 'cancel_requested' : 'state_changed', status: this.#statusWith(database, taskId) };
      }

      const ownerActive = hasActiveLease(database, attempt.owner_nonce, attempt.fencing_token, now);
      const sameOwner = attempt.owner_nonce === lease.owner_nonce && attempt.fencing_token === lease.fencing_token;
      if (ownerActive && !sameOwner) {
        return { claimed: false, reason: 'attempt_owned', status: this.#statusWith(database, taskId) };
      }

      // The WHERE clause repeats the safety predicates so the ownership
      // decision remains atomic even if this method is changed to use a
      // deferred transaction in a future store implementation.
      const result = database.prepare(`UPDATE attempts
        SET owner_nonce = ?, fencing_token = ?, status = 'dispatching',
            heartbeat_at_ms = ?, started_at_ms = coalesce(started_at_ms, ?)
        WHERE attempt_id = ? AND task_id = ? AND submission = 'not_sent'
          AND NOT EXISTS (SELECT 1 FROM native_sessions WHERE attempt_id = ?)
          AND NOT EXISTS (SELECT 1 FROM native_processes WHERE attempt_id = ?)
          AND EXISTS (SELECT 1 FROM tasks WHERE task_id = ? AND status IN ('registered', 'queued') AND cancel_requested = 0)`)
        .run(lease.owner_nonce, lease.fencing_token, now, now, attemptId, taskId, attemptId, attemptId, taskId);
      if (Number(result.changes) !== 1) return { claimed: false, reason: 'claim_lost', status: this.#statusWith(database, taskId) };
      return { claimed: true, attempt_id: attemptId, status: this.#statusWith(database, taskId) };
    });
  }

  // Return whether a registered/queued task can be dispatched on its existing
  // attempt. Duplicate queued submits and explicit resume share this check;
  // preflight login remains the only unsent waiting_user resume path.
  // It clears only a stale
  // unsent claim; any native identity or possibly-sent marker is permanent.
  recoverUnsent(taskId, { now = this.clock() } = {}) {
    return this.control.transaction(database => {
      const task = database.prepare('SELECT status FROM tasks WHERE task_id = ?').get(taskId);
      if (!task) fail('task_not_found', `Unknown task: ${taskId}`);
      const attempt = database.prepare('SELECT * FROM attempts WHERE task_id = ? ORDER BY ordinal DESC LIMIT 1').get(taskId);
      const native = attempt ? database.prepare('SELECT 1 FROM native_sessions WHERE attempt_id = ? LIMIT 1').get(attempt.attempt_id) : null;
      const nativeProcess = attempt ? hasNativeProcess(database, attempt.attempt_id) : null;
      if (!attempt || !['registered', 'queued'].includes(task.status) || attempt.submission !== 'not_sent' || native || nativeProcess) {
        return { recoverable: false, reason: native ? 'native_identity' : nativeProcess ? 'native_process' : attempt?.submission !== 'not_sent' ? 'submission_started' : 'state_changed', status: this.#statusWith(database, taskId) };
      }
      // A task lease is held from worker start through the resource wait.  It
      // covers the period before the attempt owner fields are populated and
      // prevents duplicate submit/restart callers from treating a live
      // queued worker as abandoned.
      const taskLease = database.prepare('SELECT 1 FROM leases WHERE resource_key = ? AND expires_at_ms > ?').get(`task:${taskId}`, now);
      if (taskLease || hasActiveLease(database, attempt.owner_nonce, attempt.fencing_token, now)) {
        return { recoverable: false, reason: 'attempt_owned', status: this.#statusWith(database, taskId) };
      }

      const staleClaim = Boolean(attempt.owner_nonce || attempt.fencing_token);
      if (staleClaim) {
        database.prepare(`UPDATE attempts SET owner_nonce = NULL, fencing_token = NULL,
          heartbeat_at_ms = NULL, status = CASE WHEN ? = 'registered' THEN 'registered' ELSE 'queued' END
          WHERE attempt_id = ? AND task_id = ? AND submission = 'not_sent'`)
          .run(task.status, attempt.attempt_id, taskId);
        appendEvent(database, {
          taskId,
          attemptId: attempt.attempt_id,
          type: 'task.recovered',
          payload: { reason: 'stale_unsent_worker', submission: 'not_sent' },
          now,
        });
      }
      return { recoverable: true, recovered: staleClaim, task_id: taskId, attempt_id: attempt.attempt_id, status: this.#statusWith(database, taskId) };
    });
  }

  // Convert a queued/registered cancellation intent into a confirmed
  // cancellation without requiring a lease.  No external send can happen
  // while submission is not_sent and no native session exists.
  cancelUnsent(taskId, attemptId = null, { now = this.clock() } = {}) {
    return this.control.transaction(database => {
      const task = database.prepare('SELECT * FROM tasks WHERE task_id = ?').get(taskId);
      if (!task) fail('task_not_found', `Unknown task: ${taskId}`);
      const attempt = database.prepare('SELECT * FROM attempts WHERE task_id = ? AND (? IS NULL OR attempt_id = ?) ORDER BY ordinal DESC LIMIT 1')
        .get(taskId, attemptId, attemptId);
      const native = attempt ? database.prepare('SELECT 1 FROM native_sessions WHERE attempt_id = ? LIMIT 1').get(attempt.attempt_id) : null;
      const nativeProcess = attempt ? hasNativeProcess(database, attempt.attempt_id) : null;
      if (!attempt || !task.cancel_requested || !['registered', 'queued', 'starting'].includes(task.status) || attempt.submission !== 'not_sent' || native || nativeProcess) {
        return { cancelled: false, status: this.#statusWith(database, taskId) };
      }
      const currentEvidence = Number(database.prepare("SELECT coalesce(max(json_extract(payload_json, '$.evidence_strength')), 0) AS strength FROM events WHERE task_id = ?").get(taskId).strength);
      const state = transitionState({ status: task.status, evidence_strength: currentEvidence }, 'cancelled', {});
      database.prepare('UPDATE tasks SET status = ?, updated_at_ms = ? WHERE task_id = ?').run(state.status, now, taskId);
      database.prepare('UPDATE attempts SET status = ?, finished_at_ms = ? WHERE attempt_id = ?').run('cancelled', now, attempt.attempt_id);
      appendEvent(database, {
        taskId,
        attemptId: attempt.attempt_id,
        type: 'task.cancelled',
        payload: { reason: 'cancelled_before_send', submission: 'not_sent', evidence_strength: state.evidence_strength },
        now,
      });
      return { cancelled: true, status: this.#statusWith(database, taskId) };
    });
  }

  // Persist a bounded lease wait as another queued event.  Keeping the task
  // queued and the attempt unsent makes duplicate submit/restart recovery
  // possible without inventing a second attempt.
  recordLeaseWait(taskId, attemptId, { waitMs = 0, error = null, reason = 'lease_conflict', now = this.clock() } = {}) {
    return this.control.transaction(database => {
      const task = database.prepare('SELECT status FROM tasks WHERE task_id = ?').get(taskId);
      if (!task) fail('task_not_found', `Unknown task: ${taskId}`);
      const attempt = database.prepare('SELECT submission FROM attempts WHERE task_id = ? AND attempt_id = ?').get(taskId, attemptId);
      if (!attempt) fail('task_not_found', 'Attempt does not belong to the task.');
      if (!['registered', 'queued'].includes(task.status) || attempt.submission !== 'not_sent') return this.#statusWith(database, taskId);
      const persistedError = error ? {
        code: error.code ?? 'lease_conflict',
        category: error.category ?? 'conflict',
        message: error.message ?? 'The task is waiting for an execution lease.',
        retryable: true,
        submission: 'not_sent',
      } : null;
      appendEvent(database, {
        taskId,
        attemptId,
        type: 'task.queued',
        payload: {
          ...(persistedError ? { error: persistedError } : {}),
          queue: { reason, wait_ms: Math.max(0, Number(waitMs) || 0), recoverable: true },
        },
        now,
      });
      database.prepare('UPDATE tasks SET status = ?, updated_at_ms = ? WHERE task_id = ?').run('queued', now, taskId);
      database.prepare("UPDATE attempts SET status = 'queued' WHERE attempt_id = ? AND submission = 'not_sent'").run(attemptId);
      return this.#statusWith(database, taskId);
    });
  }

  payload(taskId) {
    const directory = taskDirectory(this.control.root, taskId);
    return { request: readTaskJson(directory, 'request.json'), payload: readTaskJson(directory, 'payload.json'), decision: readTaskJson(directory, 'decision.json') };
  }

  events(taskId, { after = 0, limit = 100 } = {}) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000) fail('invalid_request', 'Event limit must be 1–1000.');
    return this.control.raw.prepare('SELECT sequence, type, payload_json, created_at_ms FROM events WHERE task_id = ? AND sequence > ? ORDER BY sequence LIMIT ?')
      .all(taskId, after, limit).map(row => ({ sequence: Number(row.sequence), type: row.type, payload: JSON.parse(row.payload_json), created_at_ms: Number(row.created_at_ms) }));
  }

  result(taskId) {
    const status = this.status(taskId);
    const directory = taskDirectory(this.control.root, taskId);
    const responseFile = path.join(directory, 'response.txt');
    const usageFile = path.join(directory, 'usage.json');
    const artifactsFile = path.join(directory, 'artifacts.json');
    return {
      ...status,
      response: { text: fs.existsSync(responseFile) ? fs.readFileSync(responseFile, 'utf8') : '' },
      usage: fs.existsSync(usageFile) ? JSON.parse(fs.readFileSync(usageFile, 'utf8')) : null,
      artifacts: fs.existsSync(artifactsFile) ? JSON.parse(fs.readFileSync(artifactsFile, 'utf8')).artifacts : [],
    };
  }

  list({ cursor = null, limit = 50 } = {}) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) fail('invalid_request', 'Task list limit must be 1–200.');
    let beforeCreated = Number.MAX_SAFE_INTEGER;
    let beforeTask = '\uffff';
    if (cursor) {
      try {
        const decoded = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
        beforeCreated = Number(decoded.created_at_ms);
        beforeTask = String(decoded.task_id);
        if (!Number.isSafeInteger(beforeCreated) || !beforeTask) throw new Error('invalid');
      } catch { fail('invalid_request', 'Task list cursor is invalid.'); }
    }
    const rows = this.control.raw.prepare(`SELECT task_id, created_at_ms FROM tasks
      WHERE created_at_ms < ? OR (created_at_ms = ? AND task_id < ?)
      ORDER BY created_at_ms DESC, task_id DESC LIMIT ?`).all(beforeCreated, beforeCreated, beforeTask, limit + 1);
    const page = rows.slice(0, limit).map(row => this.status(row.task_id));
    const last = page.at(-1);
    return {
      tasks: page,
      next_cursor: rows.length > limit && last ? Buffer.from(JSON.stringify({ created_at_ms: last.created_at_ms, task_id: last.task_id })).toString('base64url') : null,
    };
  }

  recordResponse(taskId, text, usage = null, lease = null) {
    return this.control.transaction(database => {
      if (lease) assertFencing(database, lease, this.clock());
      const directory = taskDirectory(this.control.root, taskId);
      atomicWriteText(path.join(directory, 'response.txt'), text);
      atomicWriteJson(path.join(directory, 'usage.json'), usage);
    });
  }

  heartbeat(attemptId, lease, now = this.clock()) {
    return this.control.transaction(database => {
      assertFencing(database, lease, now);
      const result = database.prepare('UPDATE attempts SET heartbeat_at_ms = ? WHERE attempt_id = ? AND owner_nonce = ? AND fencing_token = ?')
        .run(now, attemptId, lease.owner_nonce, lease.fencing_token);
      if (Number(result.changes) !== 1) fail('lease_conflict', 'Attempt heartbeat ownership changed.', { category: 'conflict', submission: 'may_have_been_sent' });
    });
  }

  transition(taskId, next, { attemptId, lease = null, evidenceStrength = 0, sameNativeIdentity = false, event = {}, now = this.clock() } = {}) {
    return this.control.transaction(database => {
      if (lease) assertFencing(database, lease, now);
      const row = database.prepare('SELECT status FROM tasks WHERE task_id = ?').get(taskId);
      if (!row) fail('task_not_found', `Unknown task: ${taskId}`);
      const currentEvidence = Number(database.prepare("SELECT coalesce(max(json_extract(payload_json, '$.evidence_strength')), 0) AS strength FROM events WHERE task_id = ?").get(taskId).strength);
      const state = transitionState({ status: row.status, evidence_strength: currentEvidence }, next, { same_native_identity: sameNativeIdentity, evidence_strength: evidenceStrength });
      database.prepare('UPDATE tasks SET status = ?, updated_at_ms = ? WHERE task_id = ?').run(state.status, now, taskId);
      if (attemptId && state.status === 'queued') {
        database.prepare("UPDATE attempts SET status = 'queued' WHERE attempt_id = ? AND submission = 'not_sent'").run(attemptId);
      }
      const payload = state.status === 'waiting_user' ? sanitizeWaitingEvent(event) : event;
      appendEvent(database, { taskId, attemptId, type: `task.${state.status}`, payload: { ...payload, evidence_strength: state.evidence_strength }, now });
      const nativeStatus = typeof event.native_status === 'string' && event.native_status
        ? event.native_status : ['waiting_user', 'succeeded', 'failed', 'cancelled'].includes(state.status) ? state.status : null;
      if (attemptId && nativeStatus) database.prepare(`UPDATE native_sessions SET native_status = ? WHERE id = (
        SELECT id FROM native_sessions WHERE attempt_id = ? ORDER BY id DESC LIMIT 1
      )`).run(nativeStatus, attemptId);
      if (['succeeded', 'failed', 'cancelled'].includes(state.status) && attemptId) database.prepare('UPDATE attempts SET status = ?, finished_at_ms = ? WHERE attempt_id = ?').run(state.status, now, attemptId);
      return this.#statusWith(database, taskId);
    });
  }

  requestCancel(taskId) {
    const now = this.clock();
    return this.control.transaction(database => {
      const task = database.prepare('SELECT status FROM tasks WHERE task_id = ?').get(taskId);
      if (!task) fail('task_not_found', `Unknown task: ${taskId}`);
      if (['succeeded', 'failed', 'cancelled'].includes(task.status)) return { ...this.#statusWith(database, taskId), cancel_accepted: false };
      database.prepare('UPDATE tasks SET cancel_requested = 1, updated_at_ms = ? WHERE task_id = ?').run(now, taskId);
      atomicWriteJson(path.join(taskDirectory(this.control.root, taskId), 'cancel.json'), { requested_at_ms: now });
      const attempt = database.prepare('SELECT attempt_id FROM attempts WHERE task_id = ? ORDER BY ordinal DESC LIMIT 1').get(taskId);
      appendEvent(database, { taskId, attemptId: attempt?.attempt_id ?? null, type: 'control.cancel_requested', now });
      return { ...this.#statusWith(database, taskId), cancel_accepted: true };
    });
  }

  resume(taskId, { now = this.clock() } = {}) {
    return this.control.transaction(database => {
      const status = this.#statusWith(database, taskId);
      const attempt = status.attempt;
      const nativeProcess = attempt ? hasNativeProcess(database, attempt.attempt_id) : null;
      if (nativeProcess && ['starting', 'running', 'waiting_user', 'indeterminate'].includes(status.status)) {
        return {
          ...status,
          mode: 'reconcile',
          durable_process: true,
          native_identity: status.native?.session_id ?? status.native?.task_id ?? null,
        };
      }
      if (status.status === 'waiting_user' && attempt?.submission === 'not_sent' && !status.native && !nativeProcess && this.#waitingPhase(database, taskId) === 'preflight_login') {
        this.#requeueWaitingAttempt(database, taskId, attempt.attempt_id, now);
        return { ...this.#statusWith(database, taskId), mode: 'preflight' };
      }
      if (status.status === 'waiting_user' && status.native) {
        return { ...status, mode: 'reconcile', native_identity: status.native.session_id ?? status.native.task_id };
      }
      if (['registered', 'queued'].includes(status.status) && attempt?.submission === 'not_sent' && !status.native && !nativeProcess) {
        const recovered = this.recoverUnsent(taskId, { now });
        if (recovered.recoverable) return { ...recovered.status, mode: 'dispatch', resumed: true };
      }
      fail('resume_not_allowed', `Task cannot be resumed from ${status.status}.`, { category: 'conflict', submission: 'not_sent' });
    });
  }

  recordOutcome(taskId, { nativeOutcome = null, objectiveVerdict = null, modelReported, modelVerified, modelVerification, lease = null, now = this.clock() } = {}) {
    return this.control.transaction(database => {
      if (lease) assertFencing(database, lease, now);
      const task = database.prepare('SELECT 1 FROM tasks WHERE task_id = ?').get(taskId);
      if (!task) fail('task_not_found', `Unknown task: ${taskId}`);
      database.prepare(`UPDATE tasks SET native_outcome = ?, objective_verdict = ?,
        model_reported = coalesce(?, model_reported), model_verified = coalesce(?, model_verified),
        verification_json = coalesce(?, verification_json), updated_at_ms = ? WHERE task_id = ?`)
        .run(nativeOutcome, objectiveVerdict, modelReported ?? null, modelVerified === undefined ? null : modelVerified ? 1 : 0,
          modelVerification === undefined ? null : JSON.stringify(modelVerification), now, taskId);
    });
  }

  #statusWith(database, taskId) {
    const task = database.prepare('SELECT * FROM tasks WHERE task_id = ?').get(taskId);
    if (!task) fail('task_not_found', `Unknown task: ${taskId}`);
    const attempt = database.prepare('SELECT * FROM attempts WHERE task_id = ? ORDER BY ordinal DESC LIMIT 1').get(taskId);
    const native = attempt ? database.prepare('SELECT * FROM native_sessions WHERE attempt_id = ? ORDER BY id DESC LIMIT 1').get(attempt.attempt_id) : null;
    const statusEvent = database.prepare('SELECT payload_json FROM events WHERE task_id = ? AND type = ? ORDER BY sequence DESC LIMIT 1')
      .get(taskId, `task.${task.status}`);
    const persistedError = statusEvent ? JSON.parse(statusEvent.payload_json).error : null;
    return {
      schema_version: '1.0', task_id: task.task_id, request_id: task.request_id, target: task.target, status: task.status,
      native_outcome: task.native_outcome, objective_verdict: task.objective_verdict,
      cancel_requested: Boolean(task.cancel_requested), model_requested: task.model_requested, model_resolved: task.model_resolved,
      model_reported: task.model_reported, model_verified: Boolean(task.model_verified), provider: task.provider, route_id: task.route_id,
      model_resolution: task.resolution_json ? JSON.parse(task.resolution_json) : null,
      model_verification: task.verification_json ? JSON.parse(task.verification_json) : null,
      attempt: attempt ? {
        attempt_id: attempt.attempt_id, ordinal: Number(attempt.ordinal), status: attempt.status, submission: attempt.submission,
        fencing_token: attempt.fencing_token, heartbeat_at_ms: attempt.heartbeat_at_ms === null ? null : Number(attempt.heartbeat_at_ms),
      } : null,
      native: native ? { session_id: native.native_session_id, task_id: native.native_task_id, status: native.native_status, evidence_ref: native.evidence_ref } : null,
      error: taskErrorRecord(persistedError, attempt?.submission ?? 'not_sent'),
      lifecycle: this.#latestLifecycle(database, taskId),
      created_at_ms: Number(task.created_at_ms), updated_at_ms: Number(task.updated_at_ms),
    };
  }

  // Newest persisted managed-lifecycle summary (waiting events and dispatch
  // checkpoints carry it). Bounded scan over recent events; null when the
  // target was never managed in this task.
  #latestLifecycle(database, taskId) {
    const rows = database.prepare('SELECT payload_json FROM events WHERE task_id = ? ORDER BY sequence DESC LIMIT 50').all(taskId);
    for (const row of rows) {
      const payload = JSON.parse(row.payload_json);
      if (payload && typeof payload === 'object' && !Array.isArray(payload) && payload.lifecycle && typeof payload.lifecycle === 'object') {
        return payload.lifecycle;
      }
    }
    return null;
  }

  #waitingPhase(database, taskId) {
    const row = database.prepare(`SELECT payload_json FROM events WHERE task_id = ? AND type = 'task.waiting_user' ORDER BY sequence DESC LIMIT 1`).get(taskId);
    if (!row) return null;
    const phase = JSON.parse(row.payload_json)?.interaction?.phase;
    return typeof phase === 'string' && phase ? phase : null;
  }

  #resumePreflightInTransaction(database, taskId, { now }) {
    const task = database.prepare('SELECT status FROM tasks WHERE task_id = ?').get(taskId);
    if (!task) return null;
    const attempt = database.prepare("SELECT attempt_id, submission FROM attempts WHERE task_id = ? ORDER BY ordinal DESC LIMIT 1").get(taskId);
    if (task.status !== 'waiting_user' || attempt?.submission !== 'not_sent') return null;
    const native = database.prepare('SELECT 1 FROM native_sessions WHERE attempt_id = ? LIMIT 1').get(attempt.attempt_id);
    if (native || hasNativeProcess(database, attempt.attempt_id)) return null;
    if (this.#waitingPhase(database, taskId) !== 'preflight_login') return null;
    this.#requeueWaitingAttempt(database, taskId, attempt.attempt_id, now);
    return true;
  }

  #requeueWaitingAttempt(database, taskId, attemptId, now) {
    const currentEvidence = Number(database.prepare("SELECT coalesce(max(json_extract(payload_json, '$.evidence_strength')), 0) AS strength FROM events WHERE task_id = ?").get(taskId).strength);
    const state = transitionState({ status: 'waiting_user', evidence_strength: currentEvidence }, 'queued', {});
    database.prepare('UPDATE tasks SET status = ?, updated_at_ms = ? WHERE task_id = ?').run(state.status, now, taskId);
    database.prepare("UPDATE attempts SET status = 'queued' WHERE attempt_id = ?").run(attemptId);
    appendEvent(database, {
      taskId,
      attemptId,
      type: `task.${state.status}`,
      payload: {
        resumed: true,
        lifecycle: { resumed_from: 'waiting_user', interaction_phase: 'preflight_login' },
        evidence_strength: state.evidence_strength,
      },
      now,
    });
  }
}

function sanitizeWaitingEvent(event) {
  const interaction = event?.interaction && typeof event.interaction === 'object' && !Array.isArray(event.interaction) ? event.interaction : {};
  const nativeStatus = typeof event?.native_status === 'string' && event.native_status ? event.native_status : null;
  const error = typeof event?.error === 'string' && event.error ? redactText(event.error).slice(0, 200) : null;
  const lifecycle = event?.lifecycle && typeof event.lifecycle === 'object' && !Array.isArray(event.lifecycle) ? event.lifecycle : null;
  return {
    interaction: { phase: typeof interaction.phase === 'string' ? interaction.phase : null },
    ...(nativeStatus ? { native_status: nativeStatus } : {}),
    ...(error ? { error } : {}),
    // Pre-sanitized managed-lifecycle summary from the worker (state,
    // instance/installation ids, generation, flags). Never contains prompts.
    ...(lifecycle ? { lifecycle } : {}),
  };
}

function taskErrorRecord(value, submission) {
  if (!value) return null;
  if (typeof value === 'object' && !Array.isArray(value) && typeof value.code === 'string') {
    return errorRecord(new UAgentsError(value.code, typeof value.message === 'string' ? value.message : 'The native Agent reported a failure.', {
      category: typeof value.category === 'string' ? value.category : 'target',
      retryable: value.retryable === true,
      submission: typeof value.submission === 'string' ? value.submission : submission,
      details: value.details ?? null,
    }), value.schema_version ?? '1.0');
  }
  const code = typeof value === 'string' && value ? value : 'native_error';
  return errorRecord(new UAgentsError(code, `The native Agent reported ${code}.`, {
    category: 'target', retryable: false, submission,
  }));
}

function hasActiveLease(database, ownerNonce, fencingToken, now) {
  if (!ownerNonce || !fencingToken) return false;
  return Boolean(database.prepare(`SELECT 1 FROM leases
    WHERE owner_nonce = ? AND fencing_token = ? AND expires_at_ms > ? LIMIT 1`)
    .get(ownerNonce, fencingToken, now));
}

function hasNativeProcess(database, attemptId) {
  if (!attemptId) return false;
  return Boolean(database.prepare('SELECT 1 FROM native_processes WHERE attempt_id = ? LIMIT 1').get(attemptId));
}
