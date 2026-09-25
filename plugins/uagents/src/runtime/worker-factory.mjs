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
  { adapterFactory = adapterFor, supervisorFactory = createSupervisor } = {}) {
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
    const adapter = adapterFactory(status.target, transport ? { transport } : undefined);
    const supervisor = await supervisorFactory(root);
    return await runTask({ service, taskId, adapter, supervisor });
  } finally { control.close(); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [, , root, taskId] = process.argv;
  if (!root || !taskId) throw new Error('Usage: worker-factory.mjs STATE_ROOT TASK_ID');
  await runRegisteredTask(root, taskId);
}
