import { ControlDatabase } from '../store/database.mjs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { adapterFor } from '../adapters/index.mjs';
import { fail } from '../protocol/errors.mjs';
import { TaskService } from './task-service.mjs';
import { runTask } from './worker.mjs';

// Worker-side host control plane. Uses the shared factory so CLI, MCP and
// worker subprocesses construct one identical supervisor.
async function createSupervisor(stateRoot) {
  const { createHostSupervisor } = await import('../host/target-supervisor.mjs');
  return createHostSupervisor({ stateRoot });
}

export async function runRegisteredTask(root, taskId,
  { adapterFactory = adapterFor, supervisorFactory = createSupervisor, leaseOptions = {} } = {}) {
  const control = new ControlDatabase(root);
  try {
    const service = new TaskService(control);
    const status = service.status(taskId);
    const registered = control.raw.prepare(`SELECT payload_json FROM events
      WHERE task_id = ? AND type = 'task.registered' ORDER BY sequence ASC LIMIT 1`).get(taskId);
    const transport = registered ? JSON.parse(registered.payload_json)?.dispatch_transport ?? null : null;
    const payloadTransport = service.payload(taskId).payload.dispatch_transport ?? null;
    if (!registered || transport !== payloadTransport) {
      fail('invalid_request', 'Persisted Task transport does not match registration.', {
        category: 'runtime', submission: status.attempt?.submission ?? 'not_sent',
      });
    }
    if (transport !== null && (status.target !== 'codex' || transport !== 'app-server')) {
      fail('invalid_request', 'Persisted Task transport is invalid.', {
        category: 'runtime', submission: status.attempt?.submission ?? 'not_sent',
      });
    }
    // Initialization is part of the owned execution, so a duplicate worker
    // cannot report a load failure while the owner is still initializing.
    return await runTask({ service, taskId, leaseOptions, initialize: async () => {
      try {
        const adapter = await adapterFactory(status.target, transport ? { transport } : undefined);
        const supervisor = await supervisorFactory(root);
        return { adapter, supervisor };
      } catch (error) {
        const failure = workerStartFailure(error);
        fail(failure.code, failure.message, { category: failure.category, retryable: true, submission: 'not_sent' });
      }
    } });
  } finally { control.close(); }
}

// The task stays locally recoverable (`queued`, unsent) and `resume` can retry
// it once the local installation is fixed.

// Our own coded errors carry a safe, human-readable cause; raw system errors
// keep only their code so no local path is persisted.
function workerStartFailure(error) {
  const coded = error && typeof error === 'object' && typeof error.code === 'string' && typeof error.category === 'string';
  const cause = coded ? `${error.code}: ${error.message}` : (typeof error?.code === 'string' ? error.code : 'unknown_error');
  return {
    code: 'worker_start_failed',
    category: 'runtime',
    retryable: true,
    message: `The local worker could not start this task (${cause}); nothing was sent. Fix the local installation, then resume the same task.`,
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [, , root, taskId] = process.argv;
  if (!root || !taskId) throw new Error('Usage: worker-factory.mjs STATE_ROOT TASK_ID');
  await runRegisteredTask(root, taskId);
}
