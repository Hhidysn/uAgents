import { randomUUID } from 'node:crypto';
import { acquireLeaseRow, assertFencing, releaseLeases, renewLeases } from '../runtime/leases.mjs';

const RESOURCE_KEY = 'service:scheduler';
const UNSENT_STATES = new Set(['registered', 'queued']);

// The scheduler only starts the existing worker entry point. Core remains
// responsible for task claims, native identity and submission safety.
export class TaskScheduler {
  #lease = null;
  #ownerNonce = randomUUID();
  #timer = null;
  #tickPromise = null;
  #stopped = false;
  #cursor = null;
  #inFlight = new Map();
  #backoff = new Map();
  #lastScanAt = null;
  #lastProgressAt = null;
  #counts = {
    scans: 0, scanned: 0, launched: 0, recovered: 0, cancelled: 0,
    skipped: 0, completed: 0, launch_failed: 0, lease_conflicts: 0,
  };
  #errors = { total: 0, last_code: null, last_at_ms: null, by_code: {} };

  constructor({ runtime, launchTask, acceptsTask = () => true, intervalMs = 1000,
    leaseTtlMs = 10000, maxInFlight = 4, batchSize = 50, clock = Date.now,
    onEvent = () => {} } = {}) {
    if (!runtime?.control?.transaction || !runtime?.service?.recoverUnsent ||
        typeof launchTask !== 'function' || typeof acceptsTask !== 'function' ||
        typeof clock !== 'function' || typeof onEvent !== 'function') {
      throw new TypeError('TaskScheduler requires a runtime and synchronous launchTask callback.');
    }
    for (const [name, value] of Object.entries({ intervalMs, leaseTtlMs, maxInFlight, batchSize })) {
      if (!Number.isSafeInteger(value) || value < 1) throw new RangeError(`${name} must be a positive integer.`);
    }
    this.runtime = runtime;
    this.launchTask = launchTask;
    this.acceptsTask = acceptsTask;
    this.intervalMs = intervalMs;
    this.leaseTtlMs = leaseTtlMs;
    this.maxInFlight = maxInFlight;
    this.batchSize = batchSize;
    this.clock = clock;
    this.onEvent = onEvent;
  }

  start() {
    if (this.#timer) return this.snapshot();
    this.#stopped = false;
    this.#timer = setInterval(() => { void this.tick(); }, this.intervalMs);
    this.#timer.unref?.();
    void this.tick();
    return this.snapshot();
  }

  stop() {
    this.#stopped = true;
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
    const lease = this.#lease;
    this.#lease = null;
    if (lease) {
      try { releaseLeases(this.runtime.control, [lease]); }
      catch { this.#recordError('scheduler_release_failed'); }
    }
    // Existing workers own their own lifecycle and leases; never kill them.
    return this.snapshot();
  }

  tick() {
    if (this.#tickPromise) return this.#tickPromise;
    this.#tickPromise = Promise.resolve().then(() => {
      if (!this.#stopped) {
        try { this.#scan(); }
        catch { this.#recordError('scheduler_tick_failed'); }
      }
      return this.snapshot();
    }).finally(() => { this.#tickPromise = null; });
    return this.#tickPromise;
  }

  snapshot() {
    return {
      running: Boolean(this.#timer),
      lease_held: Boolean(this.#lease && this.#lease.expires_at_ms > this.clock()),
      last_scan_at_ms: this.#lastScanAt,
      last_progress_at_ms: this.#lastProgressAt,
      in_flight: this.#inFlight.size,
      counts: { ...this.#counts },
      errors: { ...this.#errors, by_code: { ...this.#errors.by_code } },
    };
  }

  #scan() {
    if (!this.#takeLeadership()) return;
    const cursor = this.#cursor;
    const rows = this.runtime.control.transaction(database => {
      assertFencing(database, this.#lease, this.clock());
      return database.prepare(`SELECT t.task_id, t.created_at_ms FROM tasks t
        JOIN attempts a ON a.task_id = t.task_id AND a.ordinal =
          (SELECT max(latest.ordinal) FROM attempts latest WHERE latest.task_id = t.task_id)
        WHERE t.status IN ('registered', 'queued') AND a.submission = 'not_sent'
          AND (? IS NULL OR t.created_at_ms > ? OR (t.created_at_ms = ? AND t.task_id > ?))
        ORDER BY t.created_at_ms, t.task_id LIMIT ?`)
        .all(cursor?.created_at_ms ?? null, cursor?.created_at_ms ?? null,
          cursor?.created_at_ms ?? null, cursor?.task_id ?? null, this.batchSize);
    });
    this.#lastScanAt = this.clock();
    this.#counts.scans++;
    this.#counts.scanned += rows.length;
    this.#cursor = rows.length === this.batchSize ? rows.at(-1) : null;

    for (const row of rows) {
      if (this.#stopped || !this.#isLeader()) break;
      try { this.#visit(row.task_id); }
      catch { this.#recordError('scheduler_task_failed', { task_id: row.task_id }); }
    }
  }

  #takeLeadership() {
    if (this.#lease) {
      try {
        this.#lease = this.runtime.control.transaction(database => {
          assertFencing(database, this.#lease, this.clock());
          return renewLeases(this.runtime.control, [this.#lease], {
            ttlMs: this.leaseTtlMs, now: this.clock(),
          })[0];
        });
        return true;
      } catch (error) {
        this.#lease = null;
        if (error?.code !== 'lease_conflict') throw error;
      }
    }
    try {
      this.#lease = this.runtime.control.transaction(database => acquireLeaseRow(
        database, RESOURCE_KEY, 'service_scheduler', this.#ownerNonce,
        this.leaseTtlMs, this.clock(), {},
      ));
      return true;
    } catch (error) {
      if (error?.code !== 'lease_conflict') throw error;
      this.#counts.lease_conflicts++;
      return false;
    }
  }

  #isLeader() {
    if (!this.#lease) return false;
    try {
      this.runtime.control.transaction(database => assertFencing(database, this.#lease, this.clock()));
      return true;
    } catch (error) {
      this.#lease = null;
      if (error?.code !== 'lease_conflict') throw error;
      this.#counts.lease_conflicts++;
      return false;
    }
  }

  #visit(taskId) {
    const service = this.runtime.service;
    const status = service.status(taskId);
    if (!UNSENT_STATES.has(status.status) || status.attempt?.submission !== 'not_sent' ||
        !this.acceptsTask(status)) {
      this.#counts.skipped++;
      return;
    }
    if (this.#stopped || !this.#isLeader()) return;
    if (status.cancel_requested) {
      const result = service.cancelUnsent(taskId, status.attempt.attempt_id, { now: this.clock() });
      if (result.cancelled) {
        this.#backoff.delete(taskId);
        this.#counts.cancelled++;
        this.#progress('scheduler.cancelled', { task_id: taskId });
      } else this.#counts.skipped++;
      return;
    }
    const backoff = this.#backoff.get(taskId);
    if (backoff && backoff.attempt_id !== status.attempt.attempt_id) this.#backoff.delete(taskId);
    if (this.#inFlight.has(taskId) ||
        (backoff?.attempt_id === status.attempt.attempt_id && backoff.retry_at_ms > this.clock())) {
      this.#counts.skipped++;
      return;
    }
    const recovered = service.recoverUnsent(taskId, { now: this.clock() });
    if (!recovered.recoverable) {
      this.#counts.skipped++;
      return;
    }
    if (recovered.status.cancel_requested) {
      const cancelled = service.cancelUnsent(taskId, recovered.attempt_id, { now: this.clock() });
      if (cancelled.cancelled) {
        this.#counts.cancelled++;
        this.#progress('scheduler.cancelled', { task_id: taskId });
      }
      return;
    }
    // Count shared workers before every launch, including detached workers
    // surviving a service restart and workers started by another CLI. Local
    // children without a task lease reserve capacity during the claim gap.
    if (this.#stopped || !this.#isLeader()) return;
    this.runtime.control.transaction(database => {
      const now = this.clock();
      assertFencing(database, this.#lease, now);
      const activeWorkers = Number(database.prepare(`SELECT count(*) AS count FROM leases
        WHERE resource_type = 'task' AND resource_key GLOB 'task:*' AND expires_at_ms > ?`)
        .get(now).count);
      const activeTaskLease = database.prepare(`SELECT 1 FROM leases
        WHERE resource_key = ? AND resource_type = 'task' AND expires_at_ms > ?`);
      let pendingWorkers = 0;
      for (const inFlightTaskId of this.#inFlight.keys()) {
        if (!activeTaskLease.get(`task:${inFlightTaskId}`, now)) pendingWorkers++;
      }
      if (activeWorkers + pendingWorkers >= this.maxInFlight) {
        this.#counts.skipped++;
        return;
      }
      // Keep fencing, the capacity observation and spawn in one synchronous
      // transaction so another lease writer cannot intervene before launch.
      if (recovered.recovered) this.#counts.recovered++;
      this.#launch(taskId, recovered.attempt_id);
    });
  }

  #launch(taskId, attemptId) {
    const prior = this.#backoff.get(taskId);
    const launches = prior?.attempt_id === attemptId ? prior.launches + 1 : 1;
    const entry = { attempt_id: attemptId, child: null };
    this.#inFlight.set(taskId, entry);
    this.#rememberBackoff(taskId, attemptId, launches);
    try {
      const child = this.launchTask(taskId);
      if (!child || typeof child.once !== 'function') throw new TypeError('Worker launcher must return a child emitter.');
      entry.child = child;
      child.once('error', () => this.#finish(taskId, entry, true));
      child.once('exit', () => this.#finish(taskId, entry, false));
      child.once('close', () => this.#finish(taskId, entry, false));
      this.#counts.launched++;
      this.#progress('scheduler.launched', { task_id: taskId, attempt_id: attemptId });
    } catch {
      this.#finish(taskId, entry, true);
    }
  }

  #finish(taskId, entry, launchFailed) {
    if (this.#inFlight.get(taskId) !== entry) return;
    this.#inFlight.delete(taskId);
    const prior = this.#backoff.get(taskId);
    this.#rememberBackoff(taskId, entry.attempt_id, prior?.launches ?? 1);
    if (launchFailed) {
      this.#counts.launch_failed++;
      this.#recordError('worker_launch_failed', { task_id: taskId, attempt_id: entry.attempt_id });
      try {
        this.runtime.service.recordLeaseWait(taskId, entry.attempt_id, {
          reason: 'worker_launch_failed', now: this.clock(),
          error: { code: 'worker_launch_failed', category: 'runtime',
            message: 'The local worker could not be started.' },
        });
      } catch { this.#recordError('scheduler_record_failed', { task_id: taskId }); }
    } else this.#counts.completed++;
    try {
      const status = this.runtime.service.status(taskId);
      if (!UNSENT_STATES.has(status.status) || status.attempt?.submission !== 'not_sent') this.#backoff.delete(taskId);
    } catch { /* Runtime may already have closed after stop(). */ }
    this.#progress('scheduler.worker_finished', { task_id: taskId, attempt_id: entry.attempt_id, launch_failed: launchFailed });
  }

  #rememberBackoff(taskId, attemptId, launches) {
    this.#backoff.delete(taskId);
    this.#backoff.set(taskId, {
      attempt_id: attemptId, launches,
      retry_at_ms: this.clock() + Math.min(60_000, this.intervalMs * 2 ** Math.min(launches - 1, 6)),
    });
    const limit = Math.max(this.batchSize, this.maxInFlight) * 4;
    while (this.#backoff.size > limit) this.#backoff.delete(this.#backoff.keys().next().value);
  }

  #progress(type, details) {
    this.#lastProgressAt = this.clock();
    this.#emit({ type, at_ms: this.#lastProgressAt, ...details });
  }

  #recordError(code, details = {}) {
    this.#errors.total++;
    this.#errors.last_code = code;
    this.#errors.last_at_ms = this.clock();
    this.#errors.by_code[code] = (this.#errors.by_code[code] ?? 0) + 1;
    this.#emit({ type: 'scheduler.error', code, at_ms: this.#errors.last_at_ms, ...details });
  }

  #emit(event) {
    try { this.onEvent(event); }
    catch {
      // Callback failures must not interrupt recovery or expose native text.
      this.#errors.total++;
      this.#errors.last_code = 'scheduler_event_failed';
      this.#errors.last_at_ms = this.clock();
      this.#errors.by_code.scheduler_event_failed = (this.#errors.by_code.scheduler_event_failed ?? 0) + 1;
    }
  }
}
