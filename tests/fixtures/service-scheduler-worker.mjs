import { FakeAdapter } from '../../plugins/uagents/src/adapters/fake/adapter.mjs';
import { runRegisteredTask } from '../../plugins/uagents/src/runtime/worker-factory.mjs';

const [, , root, taskId] = process.argv;
const adapter = new FakeAdapter();
try {
  const result = await runRegisteredTask(root, taskId, {
    adapterFactory: () => adapter, supervisorFactory: async () => null,
  });
  process.send?.({ type: 'result', status: result.status,
    attempt_id: result.attempt?.attempt_id, send_count: adapter.sendCount });
} catch {
  process.send?.({ type: 'error', code: 'fixture_worker_failed' });
  process.exitCode = 1;
}
