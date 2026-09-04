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

const sourceWorkerFile = fileURLToPath(new URL('./worker-factory.mjs', import.meta.url));

export class UnifiedRuntime {
  constructor({ stateRoot, registry = createRegistry(), adapterFactory = adapterFor, spawnWorker = spawnSourceWorker } = {}) {
    this.stateRoot = resolveStateRoot(stateRoot);
    this.registry = registry;
    this.adapterFactory = adapterFactory;
    this.spawnWorker = spawnWorker;
    this.control = new ControlDatabase(this.stateRoot);
    this.service = new TaskService(this.control, { registry });
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
    return this.adapterFactory(target).probe(evaluated.request, { workspace });
  }

  submit(input) {
    const result = this.service.submit(input);
    if (!result.duplicate) this.spawnWorker(this.stateRoot, result.task_id);
    return { ...result, poll_after_ms: 250 };
  }

  status(taskId) { return this.service.status(taskId); }
  result(taskId) { return this.service.result(taskId); }
  cancel(taskId) { return this.service.requestCancel(taskId); }
  listTasks(options = {}) { return this.service.list(options); }

  async reconcile(taskId) {
    const status = this.service.status(taskId);
    return reconcileTask({ service: this.service, taskId, adapter: this.adapterFactory(status.target) });
  }
}

export function resolveStateRoot(value, env = process.env) {
  const root = value ?? env.UAGENTS_STATE_DIR ?? (env.LOCALAPPDATA ? path.join(env.LOCALAPPDATA, 'uAgents', 'v1') : null);
  if (!root || !path.isAbsolute(root)) fail('invalid_workspace', 'Provide an absolute state directory or LOCALAPPDATA.');
  return path.resolve(root);
}

export function spawnSourceWorker(root, taskId) {
  const child = spawn(process.execPath, [sourceWorkerFile, root, taskId], {
    detached: true, windowsHide: true, env: childEnvironment(), stdio: 'ignore',
  });
  child.unref();
}
