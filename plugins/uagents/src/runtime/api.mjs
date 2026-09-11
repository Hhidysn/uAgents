import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { adapterFor } from '../adapters/index.mjs';
import { evaluateRequest } from '../policy/evaluate.mjs';
import { fail } from '../protocol/errors.mjs';
import { createRegistry, targetDescriptor } from '../registry/registry.mjs';
import { ControlDatabase } from '../store/database.mjs';
import { reconcileTask } from './reconcile.mjs';
import { TaskService } from './task-service.mjs';
import { childEnvironment } from './child-environment.mjs';
import { CouncilService } from './council-service.mjs';

const sourceWorkerFile = fileURLToPath(new URL('./worker-factory.mjs', import.meta.url));

export class UnifiedRuntime {
  constructor({ stateRoot, registry = createRegistry(), adapterFactory = adapterFor, spawnWorker = spawnSourceWorker, supervisor = null } = {}) {
    this.stateRoot = resolveStateRoot(stateRoot);
    this.registry = registry;
    this.adapterFactory = adapterFactory;
    this.spawnWorker = spawnWorker;
    // Optional Target Supervisor (host control plane). Worker subprocesses
    // construct their own; this injection point exists for in-process hosts.
    this.supervisor = supervisor;
    this.control = new ControlDatabase(this.stateRoot);
    this.service = new TaskService(this.control, { registry });
    this.councils = new CouncilService({
      stateRoot: this.stateRoot,
      registry,
      submitTask: input => this.submit(input),
      statusTask: taskId => this.status(taskId),
      resultTask: taskId => this.result(taskId),
    });
  }

  close() { this.control.close(); }

  listTargets() {
    return Object.entries(this.registry.targets).filter(([, value]) => value.enabled).map(([id]) => id);
  }

  capabilities(target) { return { target, ...targetDescriptor(this.registry, target) }; }

  listModels(target) {
    targetDescriptor(this.registry, target);
    return Object.values(this.registry.models).filter(model => model.target === target && model.enabled);
  }

  async probe(target, { model = 'default' } = {}) {
    const workspace = path.join(this.stateRoot, 'probe-workspace');
    fs.mkdirSync(workspace, { recursive: true });
    const evaluated = evaluateRequest({
      schema_version: '1.0', request_id: randomUUID(), target, model, mode: 'analysis', prompt: 'probe-not-sent', workspace,
      execution: { observation_timeout_ms: 30_000, effort: 'low', permission: 'native' },
      policy: { fallback: 'none', max_cost_usd: null },
    }, { registry: this.registry });
    const result = await this.adapterFactory(target).probe(evaluated.request, { workspace });
    if (this.supervisor) {
      // Read-only managed-lifecycle snapshot merged into probe output;
      // never starts, never mutates host state.
      return { ...result, managed: this.supervisor.inspect(target) };
    }
    return result;
  }

  // Managed lifecycle: discover/verify/cache and (for desktop targets)
  // start or reuse the dedicated instance. Never sends a prompt. One-shot
  // callers (CLI/MCP tools) hold no lease after returning: no live worker
  // exists to release it, and a residual lease would block stop/resume for
  // one TTL window. The task path keeps the lease until the worker finishes.
  async ensure(target, { refresh = false } = {}) {
    if (!this.supervisor) fail('unsupported_capability', 'Managed lifecycle is unavailable in this process.', { submission: 'not_sent' });
    const ensured = await this.supervisor.ensure(target, { refresh });
    if (ensured.lease) this.supervisor.releaseInstanceLease(ensured.lease);
    return {
      target,
      mode: ensured.mode,
      lifecycle: ensured.lifecycle ?? { state: ensured.mode === 'cli' ? 'cli_entry_cached' : ensured.mode, reused: ensured.mode === 'cli' },
      installation: ensured.installation,
      ...(ensured.instance ? { instance: ensured.instance } : {}),
    };
  }

  // Stop only ownership-proven managed instances of one target.
  async stop(target) {
    if (!this.supervisor) fail('unsupported_capability', 'Managed lifecycle is unavailable in this process.', { submission: 'not_sent' });
    return this.supervisor.stop(target);
  }

  submit(input) {
    let result = this.service.submit(input);
    if (!result.duplicate || result.resumed) this.#launchWorker(result.task_id);
    else if (result.status === 'queued') {
      const recovery = this.service.recoverUnsent(result.task_id);
      if (recovery.recoverable) {
        this.#launchWorker(result.task_id);
        result = { ...recovery.status, duplicate: true, resumed: true };
      }
    }
    return { ...result, poll_after_ms: 250 };
  }

  #launchWorker(taskId) {
    try {
      const child = this.spawnWorker(this.stateRoot, taskId);
      // Launch errors arrive asynchronously, often after a one-shot CLI has
      // closed this runtime. Record through a fresh connection and keep the
      // same unsent task recoverable. Never persist the native error text.
      child?.once?.('error', () => {
        let control;
        try {
          control = new ControlDatabase(this.stateRoot);
          const service = new TaskService(control);
          const status = service.status(taskId);
          service.recordLeaseWait(taskId, status.attempt.attempt_id, {
            reason: 'worker_launch_failed',
            error: { code: 'worker_launch_failed', message: 'The local worker could not be started.' },
          });
        } catch {} finally { control?.close(); }
      });
    } catch {
      fail('worker_launch_failed', 'The local worker could not be started. Resume the same task to retry.', {
        category: 'runtime', retryable: true, submission: 'not_sent', details: { task_id: taskId },
      });
    }
  }

  status(taskId) { return this.service.status(taskId); }
  result(taskId) { return this.service.result(taskId); }
  cancel(taskId) { return this.service.requestCancel(taskId); }
  listTasks(options = {}) { return this.service.list(options); }
  submitCouncil(input) { return this.councils.submit(input); }
  councilStatus(councilId) { return this.councils.status(councilId); }
  councilResult(councilId) { return this.councils.result(councilId); }
  councilDiff(councilId) { return this.councils.diff(councilId); }

  async resume(taskId) {
    const result = this.service.resume(taskId);
    if (result.mode === 'preflight' || result.mode === 'dispatch') {
      this.#launchWorker(result.task_id);
      return { ...result, ok: true, resumed: true, poll_after_ms: 250 };
    }
    return this.reconcile(taskId);
  }

  async reconcile(taskId) {
    const status = this.service.status(taskId);
    return reconcileTask({ service: this.service, taskId, adapter: this.adapterFactory(status.target), supervisor: this.supervisor });
  }
}

export function resolveStateRoot(value, env = process.env) {
  const root = value ?? env.UAGENTS_STATE_DIR ?? (env.LOCALAPPDATA ? path.join(env.LOCALAPPDATA, 'uAgents', 'v1') : null);
  if (!root || !path.isAbsolute(root)) fail('invalid_workspace', 'Provide an absolute state directory or LOCALAPPDATA.');
  return path.resolve(root);
}

function spawnSourceWorker(root, taskId) {
  const child = spawn(process.execPath, [sourceWorkerFile, root, taskId], {
    detached: true, windowsHide: true, env: childEnvironment(), stdio: 'ignore',
  });
  child.unref();
  return child;
}
