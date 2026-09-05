import { ControlDatabase } from '../store/database.mjs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { adapterFor } from '../adapters/index.mjs';
import { TaskService } from './task-service.mjs';
import { runTask } from './worker.mjs';

// Worker-side host control plane. Uses the shared factory so CLI, MCP and
// worker subprocesses construct one identical supervisor. Best-effort: when
// the host control plane cannot be created, tasks continue without the
// managed lifecycle (identical to pre-supervisor behavior).
async function createSupervisor() {
  const { createHostSupervisor } = await import('../host/target-supervisor.mjs');
  return createHostSupervisor();
}

export async function runRegisteredTask(root, taskId) {
  const control = new ControlDatabase(root);
  try {
    const service = new TaskService(control);
    const status = service.status(taskId);
    const adapter = adapterFor(status.target);
    const supervisor = await createSupervisor();
    return await runTask({ service, taskId, adapter, supervisor });
  } finally { control.close(); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [, , root, taskId] = process.argv;
  if (!root || !taskId) throw new Error('Usage: worker-factory.mjs STATE_ROOT TASK_ID');
  await runRegisteredTask(root, taskId);
}
