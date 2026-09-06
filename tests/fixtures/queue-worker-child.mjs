import { ControlDatabase } from '../../plugins/uagents/src/store/database.mjs';
import { FakeAdapter } from '../../plugins/uagents/src/adapters/fake/adapter.mjs';
import { TaskService } from '../../plugins/uagents/src/runtime/task-service.mjs';
import { runTask } from '../../plugins/uagents/src/runtime/worker.mjs';

const [, , root, taskId] = process.argv;

if (!root || !taskId) {
  process.stderr.write('Usage: queue-worker-child.mjs STATE_ROOT TASK_ID\n');
  process.exitCode = 2;
} else {
  const control = new ControlDatabase(root);
  const service = new TaskService(control);
  const adapter = new FakeAdapter();
  try {
    const queued = service.status(taskId);
    process.stdout.write(`${JSON.stringify({ type: 'ready', status: queued.status, attempt_id: queued.attempt?.attempt_id ?? null })}\n`);
    const result = await runTask({
      service,
      taskId,
      adapter,
      leaseOptions: { maxLeaseWaitMs: 3_000, leaseRetryIntervalMs: 10, maxLeaseRetryIntervalMs: 25 },
    });
    process.stdout.write(`${JSON.stringify({ type: 'result', status: result.status, attempt_id: result.attempt?.attempt_id ?? null, send_count: adapter.sendCount })}\n`);
  } catch (error) {
    process.stdout.write(`${JSON.stringify({ type: 'error', code: error?.code ?? 'child_failed', message: error?.message ?? 'child failed' })}\n`);
    process.exitCode = 1;
  } finally {
    control.close();
  }
}
