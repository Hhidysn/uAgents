import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { pathIsWithin } from '../path-containment.mjs';
import { fail } from '../protocol/errors.mjs';
import { uuidPattern } from '../protocol/schema.mjs';

export function taskDirectory(root, taskId, { create = false } = {}) {
  if (!uuidPattern.test(taskId ?? '')) fail('invalid_request_id', 'task_id must be a UUID.');
  const tasksRoot = path.join(root, 'tasks');
  if (create) fs.mkdirSync(tasksRoot, { recursive: true });
  const directory = path.join(tasksRoot, taskId.toLowerCase());
  if (create) fs.mkdirSync(directory, { recursive: false });
  if (fs.existsSync(directory)) {
    const realTasks = fs.realpathSync(tasksRoot);
    const realDirectory = fs.realpathSync(directory);
    if (!pathIsWithin(realTasks, realDirectory)) fail('unsafe_task_path', 'Task directory resolves outside the task root.');
  }
  return directory;
}

export function atomicWriteJson(file, value) {
  return atomicWrite(file, `${JSON.stringify(value, null, 2)}\n`);
}

export function atomicWriteText(file, value) {
  return atomicWrite(file, String(value));
}

function atomicWrite(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${randomUUID()}.tmp`);
  let descriptor;
  try {
    descriptor = fs.openSync(temporary, 'wx', 0o600);
    fs.writeFileSync(descriptor, value);
    fs.closeSync(descriptor); descriptor = undefined;
    for (let attempt = 0; ; attempt++) {
      try { fs.renameSync(temporary, file); break; }
      catch (error) {
        if (process.platform !== 'win32' || !['EPERM', 'EACCES', 'EBUSY'].includes(error.code) || attempt === 9) throw error;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
      }
    }
  } catch (error) {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    try { fs.unlinkSync(temporary); } catch {}
    throw error;
  }
}

export function readTaskJson(directory, name) {
  return JSON.parse(fs.readFileSync(path.join(directory, name), 'utf8'));
}
