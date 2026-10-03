import { fileURLToPath } from 'node:url';
import { runToolChild, runSchedulerChild } from '../../src/service-child.mjs';
import { runRegisteredTask } from '../../../../src/runtime/worker-factory.mjs';
import { FakeAdapter } from '../../../../src/adapters/fake/adapter.mjs';

const flag = process.argv[2];
if (flag === '--tool-child') await runToolChild();
else if (flag === '--scheduler-child') await runSchedulerChild(fileURLToPath(import.meta.url));
else if (flag === '--task-worker') {
  const adapter = new FakeAdapter();
  adapter.observe = async function* () {
    await new Promise(resolve => setTimeout(resolve, 350));
    yield { type: 'succeeded', same_native_identity: true, evidence_strength: 2 };
  };
  await runRegisteredTask(process.argv[3], process.argv[4], { adapterFactory: () => adapter, supervisorFactory: async () => null });
}
