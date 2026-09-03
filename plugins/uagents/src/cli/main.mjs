import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { adapterFor } from '../adapters/index.mjs';
import { evaluateRequest } from '../policy/evaluate.mjs';
import { notOk, ok } from '../protocol/envelope.mjs';
import { fail } from '../protocol/errors.mjs';
import { createRegistry, targetDescriptor } from '../registry/registry.mjs';
import { ControlDatabase } from '../store/database.mjs';
import { reconcileTask } from '../runtime/reconcile.mjs';
import { TaskService } from '../runtime/task-service.mjs';

const workerFile = fileURLToPath(new URL('../runtime/worker-factory.mjs', import.meta.url));

export async function execute(argv, options = {}) {
  const registry = options.registry ?? createRegistry();
  const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, strict: true, options: {
    request: { type: 'string' }, 'state-dir': { type: 'string' }, model: { type: 'string' }, refresh: { type: 'boolean' },
    limit: { type: 'string' }, cursor: { type: 'string' }, config: { type: 'string' }, format: { type: 'string' },
  } });
  if (values.format && values.format !== 'json') fail('unsupported_capability', 'Only JSON output is implemented in this release.');
  const [command, subject, ...extra] = positionals;
  if (!command || extra.length) fail('usage', 'Invalid uagents command arguments.');

  if (command === 'targets') return ok(Object.entries(registry.targets).filter(([, value]) => value.enabled).map(([id]) => id));
  if (command === 'capabilities') return ok({ target: subject, ...targetDescriptor(registry, required(subject, 'target')) });
  if (command === 'models') {
    const target = required(subject, 'target'); targetDescriptor(registry, target);
    return ok(Object.values(registry.models).filter(model => model.target === target && model.enabled));
  }
  if (command === 'config' && subject === 'validate') {
    const config = values.config ? JSON.parse(fs.readFileSync(values.config, 'utf8')) : {};
    return ok({ valid: true, registry_version: createRegistry(config).version });
  }

  const stateRoot = resolveStateRoot(values['state-dir'], options.env ?? process.env);
  fs.mkdirSync(stateRoot, { recursive: true });
  if (command === 'probe') {
    const target = required(subject, 'target');
    const model = values.model ?? 'default';
    const probeWorkspace = path.join(stateRoot, 'probe-workspace'); fs.mkdirSync(probeWorkspace, { recursive: true });
    const evaluated = evaluateRequest({
      schema_version: '1.0', request_id: randomUUID(), target, model, mode: 'analysis', prompt: 'probe-not-sent', workspace: probeWorkspace,
      execution: { observation_timeout_ms: 30_000, effort: 'low', permission: 'native' }, policy: { fallback: 'none', max_cost_usd: null },
    }, { registry });
    const result = await adapterFor(target).probe(evaluated.request, { workspace: probeWorkspace });
    return ok(result);
  }

  const control = new ControlDatabase(stateRoot);
  try {
    const service = new TaskService(control, { registry });
    if (command === 'submit') {
      if (subject || !values.request) fail('usage', 'submit requires --request FILE.');
      const input = JSON.parse(fs.readFileSync(values.request, 'utf8'));
      const result = service.submit(input);
      if (!result.duplicate) (options.spawnWorker ?? spawnDetached)(stateRoot, result.task_id);
      return ok({ ...result, poll_after_ms: 250 });
    }
    if (command === 'status') return ok(service.status(required(subject, 'task id')));
    if (command === 'result') return ok(service.result(required(subject, 'task id')));
    if (command === 'cancel') return ok(service.requestCancel(required(subject, 'task id')));
    if (command === 'list') return ok(service.list({ cursor: values.cursor ?? null, limit: values.limit ? Number(values.limit) : 50 }));
    if (command === 'reconcile') {
      const taskId = required(subject, 'task id');
      const status = service.status(taskId);
      return ok(await reconcileTask({ service, taskId, adapter: adapterFor(status.target) }));
    }
    fail('usage', `Unknown command: ${command}`);
  } finally { control.close(); }
}

export async function main(argv = process.argv.slice(2), io = console) {
  try { io.log(JSON.stringify(await execute(argv))); return 0; }
  catch (error) { io.log(JSON.stringify(notOk(error))); return 1; }
}

function resolveStateRoot(value, env) {
  const root = value ?? (env.LOCALAPPDATA ? path.join(env.LOCALAPPDATA, 'uAgents', 'v1') : null);
  if (!root || !path.isAbsolute(root)) fail('invalid_workspace', 'Provide an absolute --state-dir or LOCALAPPDATA.');
  return path.resolve(root);
}

function required(value, label) { if (!value) fail('usage', `Missing ${label}.`); return value; }

function spawnDetached(root, taskId) {
  const child = spawn(process.execPath, [workerFile, root, taskId], { detached: true, windowsHide: true, stdio: 'ignore' });
  child.unref();
}
