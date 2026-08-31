import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { atomicJson, digest, fail, normalizeRequest, readJson, status, taskDirectory, terminalStates } from './store.mjs';

const workerFile = fileURLToPath(new URL('./worker.mjs', import.meta.url));

export async function submit(root, input, { kind = 'run', worker = workerFile } = {}) {
  const request = normalizeRequest(input, kind);
  const directory = taskDirectory(root, request.request_id);
  const requestDigest = digest(request);
  try { fs.mkdirSync(directory); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const current = status(root, request.request_id);
    if (!current.digest) fail('registration_incomplete', 'Existing task registration is incomplete; do not resubmit.');
    if (current.digest !== requestDigest) fail('request_conflict', 'The request_id already belongs to a different effective request.');
    if (current.registration_complete !== true) fail('registration_incomplete', 'Existing registration has not committed its inbox; do not resubmit.');
    if (current.error === 'worker_launch_unconfirmed') fail('worker_launch_unconfirmed', 'Registration exists but worker startup was never confirmed; inspect this task, do not replay it.');
    return { ...current, duplicate: true };
  }
  atomicJson(path.join(directory, 'state.json'), {
    task_id: request.request_id, target: request.target, model_requested: request.model, mode: request.mode, permission_policy: request.permission_policy,
    kind, digest: requestDigest, status: 'starting', submission: 'not_sent', registration_complete: false, updated_at_ms: Date.now(),
  });
  // The short-lived inbox is removed by the worker; prompts are not copied to logs.
  atomicJson(path.join(directory, 'inbox.json'), request);
  const registered = readJson(path.join(directory, 'state.json'));
  atomicJson(path.join(directory, 'state.json'), { ...registered, registration_complete: true, updated_at_ms: Date.now() });
  const child = spawn(process.execPath, [worker, directory], { detached: true, windowsHide: true, stdio: 'ignore' });
  await new Promise((resolve, reject) => {
    child.once('spawn', resolve);
    child.once('error', error => {
      const current = readJson(path.join(directory, 'state.json'));
      atomicJson(path.join(directory, 'state.json'), { ...current, status: 'failed', error: 'worker_spawn_failed', updated_at_ms: Date.now() });
      const inbox = path.join(directory, 'inbox.json');
      if (fs.existsSync(inbox)) fs.unlinkSync(inbox);
      reject(error);
    });
  });
  child.unref();
  return status(root, request.request_id);
}

export function cancel(root, id) {
  const current = status(root, id);
  if (terminalStates.has(current.status)) return { ...current, cancel_accepted: false };
  const directory = taskDirectory(root, id);
  const file = path.join(directory, 'cancel.json');
  try { fs.writeFileSync(file, JSON.stringify({ requested_at_ms: Date.now() }), { flag: 'wx', mode: 0o600 }); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  const latest = status(root, id);
  return { ...latest, cancel_accepted: !terminalStates.has(latest.status), cancel_recorded: true };
}

export function result(root, id) {
  const current = status(root, id);
  const file = path.join(taskDirectory(root, id), 'result.json');
  return { ...current, result: fs.existsSync(file) ? readJson(file) : null };
}
