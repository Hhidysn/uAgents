import fs from 'node:fs';
import { ControlDatabase } from '../../plugins/uagents/src/store/database.mjs';
import { TaskService } from '../../plugins/uagents/src/runtime/task-service.mjs';

const [, , root, requestFile] = process.argv;
const control = new ControlDatabase(root);
try {
  const result = new TaskService(control).submit(JSON.parse(fs.readFileSync(requestFile, 'utf8')), { adapterVersion: 'fixture-1' });
  process.stdout.write(JSON.stringify({ task_id: result.task_id, attempt_id: result.attempt.attempt_id, duplicate: result.duplicate }));
} finally {
  control.close();
}
