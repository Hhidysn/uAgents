import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const pluginRoot = fileURLToPath(new URL('../../../', import.meta.url));
export const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const terminalStates = new Set(['succeeded', 'failed', 'blocked', 'cancelled', 'unknown', 'needs_user']);

export function fail(code, message) { throw Object.assign(new Error(message), { code }); }
export function readJson(file) { return JSON.parse(fs.readFileSync(file, 'utf8')); }
export function atomicJson(file, data) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  let descriptor, created = false;
  try {
    descriptor = fs.openSync(temporary, 'wx', 0o600); created = true;
    fs.writeFileSync(descriptor, JSON.stringify(data, null, 2) + '\n');
    fs.closeSync(descriptor); descriptor = undefined;
    for (let attempt = 0; ; attempt++) {
      try { fs.renameSync(temporary, file); break; }
      catch (error) {
        // A Windows reader can briefly prevent replacement. Retry this same rename,
        // never the task or the native prompt, and do not change filesystem permissions.
        if (process.platform !== 'win32' || !['EPERM', 'EACCES', 'EBUSY'].includes(error.code) || attempt === 9) throw error;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
      }
    }
  } catch (error) {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    if (created) fs.unlinkSync(temporary);
    throw error;
  }
}
export function isWithin(parent, child) {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}
export function stateRoot(directory, create = false) {
  if (!directory || !path.isAbsolute(directory)) fail('invalid_state_dir', 'Provide an absolute --state-dir outside the plugin.');
  if (isWithin(fs.realpathSync(pluginRoot), path.resolve(directory))) fail('invalid_state_dir', 'Runtime data cannot be stored inside the plugin.');
  let ancestor = path.resolve(directory);
  while (!fs.existsSync(ancestor) && path.dirname(ancestor) !== ancestor) ancestor = path.dirname(ancestor);
  if (isWithin(fs.realpathSync(pluginRoot), fs.realpathSync(ancestor))) fail('invalid_state_dir', 'A linked state path resolves inside the plugin.');
  if (create) fs.mkdirSync(directory, { recursive: true });
  const real = fs.realpathSync(directory);
  if (isWithin(fs.realpathSync(pluginRoot), real)) fail('invalid_state_dir', 'Runtime data cannot be stored inside the plugin.');
  return real;
}
export function taskDirectory(root, id) {
  if (!uuidPattern.test(id ?? '')) fail('invalid_request_id', 'request_id must be a UUID.');
  const candidate = path.join(root, id.toLowerCase());
  if (fs.existsSync(candidate) && fs.realpathSync(candidate) !== candidate) fail('unsafe_task_path', 'Linked task directories are not supported.');
  return candidate;
}
export function normalizeRequest(value, kind = 'run') {
  if (!value || Array.isArray(value) || typeof value !== 'object') fail('invalid_request', 'Expected a request object.');
  const allowed = new Set(['request_id', 'target', 'model', 'mode', 'prompt', 'timeout_ms']);
  for (const key of Object.keys(value)) if (!allowed.has(key)) fail('unsupported_field', `Unsupported request field: ${key}`);
  if (!uuidPattern.test(value.request_id ?? '')) fail('invalid_request_id', 'request_id must be a UUID.');
  if (value.target !== 'agy' || value.mode !== 'analysis') fail('unsupported_capability', 'This preview only supports agy text analysis; file access and implementation are unavailable.');
  if (typeof value.model !== 'string' || !/^gemini-[a-z0-9.-]+$/.test(value.model)) fail('invalid_model', 'Specify an explicit Gemini model slug; no default or fallback model.');
  if (!['run', 'probe'].includes(kind)) fail('invalid_kind', 'Unsupported invocation kind.');
  if (kind === 'run' && (typeof value.prompt !== 'string' || !value.prompt.trim() || Buffer.byteLength(value.prompt) > 65536)) fail('invalid_prompt', 'Provide 1–65536 bytes of text.');
  if (kind === 'probe' && value.prompt !== undefined) fail('invalid_prompt', 'A probe cannot include a prompt.');
  const timeout = value.timeout_ms ?? 120000;
  if (!Number.isInteger(timeout) || timeout < 1000 || timeout > 300000) fail('invalid_timeout', 'timeout_ms must be 1000–300000.');
  return { request_id: value.request_id.toLowerCase(), target: 'agy', model: value.model, mode: 'analysis', kind, ...(kind === 'run' ? { prompt: value.prompt } : {}), timeout_ms: timeout };
}
export function digest(request) { return createHash('sha256').update(JSON.stringify(request)).digest('hex'); }
export function status(root, id) {
  const directory = taskDirectory(root, id);
  const file = path.join(directory, 'state.json');
  if (!fs.existsSync(file)) {
    if (fs.existsSync(directory)) return { task_id: id, status: 'unknown', error: 'incomplete_registration', retry_safe: false };
    fail('task_not_found', 'No task with this request_id exists.');
  }
  const state = readJson(file);
  if (!terminalStates.has(state.status) && Date.now() - state.updated_at_ms > 15000) {
    return { ...state, status: 'unknown', error: 'worker_heartbeat_stale', retry_safe: false };
  }
  const recorded = fs.existsSync(path.join(directory, 'cancel.json'));
  return { ...state, cancel_recorded: recorded, cancel_requested: recorded && !terminalStates.has(state.status) };
}
