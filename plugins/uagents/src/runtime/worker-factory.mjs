import { ControlDatabase } from '../store/database.mjs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { adapterFor } from '../adapters/index.mjs';
import { TaskService } from './task-service.mjs';
import { runTask } from './worker.mjs';

// Worker-side host control plane. Constructed best-effort: when the host store
// or locator cannot be created, tasks continue without the managed lifecycle
// (identical to pre-supervisor behavior). The warning is a fixed string; it
// never includes error messages, paths or environment details.
async function createSupervisor() {
  try {
    const [{ HostStore }, { createAgentLocator }, { createTargetSupervisor }, { createDoubaoLauncher }, { createTraeLauncher }] = await Promise.all([
      import('../host/host-store.mjs'),
      import('../host/agent-locator.mjs'),
      import('../host/target-supervisor.mjs'),
      import('../host/doubao-launcher.mjs'),
      import('../host/trae-launcher.mjs'),
    ]);
    const hostStore = new HostStore();
    const locator = createAgentLocator({ hostStore });
    return createTargetSupervisor({
      hostStore,
      locator,
      launchers: { doubao: createDoubaoLauncher(), trae: createTraeLauncher() },
    });
  } catch {
    process.stderr.write('uagents worker: host supervisor unavailable, continuing without managed lifecycle\n');
    return null;
  }
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
