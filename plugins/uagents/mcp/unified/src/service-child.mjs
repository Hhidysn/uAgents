import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { UnifiedRuntime } from '../../../src/runtime/api.mjs';
import { loadRegistry } from '../../../src/registry/config-file.mjs';
import { createHostSupervisor } from '../../../src/host/target-supervisor.mjs';
import { notOk, ok } from '../../../src/protocol/envelope.mjs';
import { fail } from '../../../src/protocol/errors.mjs';
import { ServicePolicy } from '../../../src/service/policy.mjs';
import { serviceChildEnvironment } from '../../../src/service/config.mjs';
import { createToolHandlers } from './server.mjs';

export async function readChildInput(stream = process.stdin, maxBytes = 128 * 1024 * 1024) {
  const chunks = []; let bytes = 0;
  for await (const chunk of stream) {
    bytes += chunk.length;
    if (bytes > maxBytes) fail('invalid_request', 'Service child input exceeds its limit.');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

export function createExecutionRuntime(config, { spawnWorker } = {}) {
  return new UnifiedRuntime({ stateRoot: config.state_dir, registry: loadRegistry({ configPath: config.registry_config }), spawnWorker });
}

export async function executeServiceTool(config, name, input, { runtime = null } = {}) {
  const ownsRuntime = !runtime;
  // Service submits are durable registrations. The scheduler owns fresh dispatch.
  runtime ??= createExecutionRuntime(config, { spawnWorker: () => {} });
  let supervisor;
  try {
    const policy = new ServicePolicy(config, runtime);
    policy.authorize(name, input);
    if (['uagents_ensure', 'uagents_stop', 'uagents_probe', 'uagents_list_models', 'uagents_reconcile', 'uagents_resume'].includes(name)) {
      supervisor = await createHostSupervisor({ stateRoot: runtime.stateRoot });
      runtime.supervisor = supervisor;
    }
    const handlers = createToolHandlers(runtime);
    if (!handlers[name]) fail('invalid_request', 'Unknown service tool.');
    if (name === 'uagents_list_targets') return runtime.listTargets().filter(target => config.targets.includes(target));
    if (name === 'uagents_list_tasks') return policy.listTasks(input);
    return await handlers[name](input);
  } finally {
    supervisor?.hostStore?.close?.();
    if (ownsRuntime) runtime.close();
  }
}

export async function runToolChild() {
  let envelope;
  try { const { config, name, input } = await readChildInput(); envelope = ok(await executeServiceTool(config, name, input)); }
  catch (error) { envelope = notOk(error); }
  process.stdout.write(`${JSON.stringify(envelope)}\n`);
}

export async function runSchedulerChild(entry = fileURLToPath(import.meta.url)) {
  const { TaskScheduler } = await import('../../../src/service/scheduler.mjs');
  const { config } = await readChildInput();
  const runtime = createExecutionRuntime(config, { spawnWorker: () => {} });
  const policy = new ServicePolicy(config, runtime);
  const scheduler = new TaskScheduler({
    runtime, intervalMs: config.poll_interval_ms, maxInFlight: config.max_workers,
    acceptsTask: status => policy.acceptsTask(status),
    launchTask: taskId => {
      const child = spawn(process.execPath, [entry, '--task-worker', config.state_dir, taskId], {
        detached: true, windowsHide: true, env: serviceChildEnvironment(config), stdio: 'ignore',
      });
      child.unref();
      return child;
    },
  });
  let stopped = false;
  const stop = () => {
    if (stopped) return;
    stopped = true; clearInterval(reporter); scheduler.stop(); runtime.close();
    if (process.connected) process.disconnect();
  };
  const reporter = setInterval(() => { if (process.connected) process.send({ type: 'scheduler', ...scheduler.snapshot() }); }, config.poll_interval_ms);
  process.on('disconnect', stop);
  process.on('message', message => { if (message?.type === 'stop') stop(); });
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
  scheduler.start();
}
