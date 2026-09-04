import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { evaluateRequest } from '../policy/evaluate.mjs';
import { fail } from '../protocol/errors.mjs';
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
        return { ...this.#statusWith(database, existing.task_id), duplicate: true };
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
      appendEvent(database, { taskId, attemptId, type: `task.${state.status}`, payload: { ...event, evidence_strength: state.evidence_strength }, now });
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
      created_at_ms: Number(task.created_at_ms), updated_at_ms: Number(task.updated_at_ms),
    };
  }
}
