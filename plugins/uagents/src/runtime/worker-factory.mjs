import { ControlDatabase } from '../store/database.mjs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { adapterFor } from '../adapters/index.mjs';
import { TaskService } from './task-service.mjs';
import { runTask } from './worker.mjs';

export async function runRegisteredTask(root, taskId) {
  const control = new ControlDatabase(root);
  try {
    const service = new TaskService(control);
    const status = service.status(taskId);
    return await runTask({ service, taskId, adapter: adapterFor(status.target) });
  } finally { control.close(); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [, , root, taskId] = process.argv;
  if (!root || !taskId) throw new Error('Usage: worker-factory.mjs STATE_ROOT TASK_ID');
  await runRegisteredTask(root, taskId);
}
