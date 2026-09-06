import fs from 'node:fs';
import path from 'node:path';
import { ControlDatabase } from '../../plugins/uagents/src/store/database.mjs';
import { TaskService } from '../../plugins/uagents/src/runtime/task-service.mjs';
import { persistCheckpoint } from '../../plugins/uagents/src/runtime/checkpoints.mjs';
import { taskDirectory } from '../../plugins/uagents/src/store/task-files.mjs';
import { launchAndAccept, prepareDurableExecution } from '../../plugins/uagents/src/transports/durable-cli-execution.mjs';
import { createDurableFixtureDriver } from './durable-fixture-driver.mjs';

const [, , stateRoot, taskId, attemptId, workspace, markerDirectory] = process.argv;
if (![stateRoot, taskId, attemptId, workspace, markerDirectory].every(value => typeof value === 'string' && value)) {
  throw new Error('Usage: durable-worker-runner STATE_ROOT TASK_ID ATTEMPT_ID WORKSPACE MARKER_DIR');
}

const control = new ControlDatabase(path.resolve(stateRoot));
const service = new TaskService(control);
const stored = service.payload(taskId);
const driver = createDurableFixtureDriver(markerDirectory);
const prepared = prepareDurableExecution({
  driver,
  request: { ...stored.request, prompt: stored.payload.prompt },
  workspace,
  taskDirectory: taskDirectory(control.root, taskId),
  attemptId,
  installation: { canonical_path: process.execPath, sha256: null },
  coreVersion: 'fixture-core',
  adapterVersion: 'fixture-adapter',
});
const checkpoint = (kind, payload = {}) => persistCheckpoint(control, {
  taskId,
  attemptId,
  kind,
  payload: { target: 'opencode', ...payload },
});
const inspector = {
  inspectProcess: async ({ pid }) => ({ kind: 'alive', pid, started_at_ms: Date.now(), executable_path: process.execPath }),
  inspectProcessTree: async () => ({ kind: 'quiescent', descendants: [] }),
};

const execution = await launchAndAccept({ prepared, control, checkpoint, inspector, acceptTimeoutMs: 5_000 });
fs.writeFileSync(path.join(markerDirectory, 'worker-accepted.json'), JSON.stringify({
  pid: execution.process.pid,
  session_id: execution.handle.session_id,
}));

// Keep the observer alive so the parent test can terminate exactly this
// process after acceptance. The native fixture has direct file descriptors and
// must continue without this observer.
setInterval(() => {}, 1_000);
