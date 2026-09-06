import { ControlDatabase } from '../../plugins/uagents/src/store/database.mjs';
import { TaskService } from '../../plugins/uagents/src/runtime/task-service.mjs';
import { runTask } from '../../plugins/uagents/src/runtime/worker.mjs';
import { OpenCodeAdapter } from '../../plugins/uagents/src/adapters/opencode/adapter.mjs';

const [stateRoot, taskId, fakeCli, scenario = 'slow-success'] = process.argv.slice(2);
const control = new ControlDatabase(stateRoot);
try {
  const service = new TaskService(control);
  const driver = { command: process.execPath, args: [fakeCli, 'opencode', taskId, scenario] };
  const adapter = new OpenCodeAdapter({ testDriver: driver });
  await runTask({
    service,
    taskId,
    adapter,
    leaseOptions: {
      ttlMs: 150,
      taskLeaseTtlMs: 150,
      heartbeatIntervalMs: 30,
      maxLeaseWaitMs: 300,
    },
  });
} finally {
  control.close();
}
