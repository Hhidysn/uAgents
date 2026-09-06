import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const pluginRoot = fileURLToPath(new URL('../../../', import.meta.url));
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const terminal = new Set(['succeeded', 'failed', 'unknown']);
export const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export function fail(code, message) { throw Object.assign(new Error(message), { code }); }

export function atomicJson(file, value) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  let descriptor;
  try {
    descriptor = fs.openSync(temporary, 'wx', 0o600);
    fs.writeFileSync(descriptor, JSON.stringify(value, null, 2) + '\n');
    fs.closeSync(descriptor); descriptor = undefined;
    for(let attempt=0;;attempt++){
      try{fs.renameSync(temporary,file);break;}
      catch(error){if(process.platform!=='win32'||!['EPERM','EACCES','EBUSY'].includes(error.code)||attempt===9)throw error;Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,20);}
    }
  } catch (error) {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
    throw error;
  }
}

function isWithin(parent,child){const relative=path.relative(parent,child);return relative===''||(!relative.startsWith(`..${path.sep}`)&&relative!=='..'&&!path.isAbsolute(relative));}

export function dataRoot(input = process.env.UAGENTS_STATE_DIR ?? process.env.PLUGIN_DATA ?? path.join(os.homedir(), '.uagents', 'doubao-work')) {
  if (!input || !path.isAbsolute(input)) fail('state_dir_required', 'Set PLUGIN_DATA or an absolute UAGENTS_STATE_DIR.');
  const resolved = path.resolve(input, process.env.PLUGIN_DATA && input === process.env.PLUGIN_DATA ? 'doubao-work' : '');
  const realPlugin=fs.realpathSync(pluginRoot);let ancestor=resolved;
  while(!fs.existsSync(ancestor)&&path.dirname(ancestor)!==ancestor)ancestor=path.dirname(ancestor);
  if(isWithin(realPlugin,fs.realpathSync(ancestor)))fail('invalid_state_dir','Runtime data must remain outside the plugin, including through linked paths.');
  fs.mkdirSync(path.join(resolved, 'tasks'), { recursive: true });
  const real=fs.realpathSync(resolved);if(isWithin(realPlugin,real))fail('invalid_state_dir','Runtime data must remain outside the plugin.');return real;
}

export class TaskStore {
  constructor(root = dataRoot()) { this.root = path.resolve(root); this.tasks = path.join(this.root, 'tasks'); fs.mkdirSync(this.tasks,{recursive:true}); this.lockFile = path.join(this.root, 'window.lock.json'); }
  taskDir(id) { if (!uuid.test(id ?? '')) fail('invalid_request_id', 'request_id must be a UUID.'); return path.join(this.tasks, id.toLowerCase()); }
  stateFile(id) { return path.join(this.taskDir(id), 'state.json'); }
  read(id) { const file=this.stateFile(id); if(!fs.existsSync(file)) fail('task_not_found', 'Task was not found.'); return JSON.parse(fs.readFileSync(file,'utf8')); }
  write(state) { atomicJson(this.stateFile(state.task_id), { ...state, updated_at_ms: Date.now() }); }
  register(id, digest, timeoutMs) {
    const directory=this.taskDir(id);
    try { fs.mkdirSync(directory); }
    catch(error) {
      if(error.code!=='EEXIST') throw error;
      const current=this.read(id);
      if(current.digest!==digest) fail('request_conflict','request_id belongs to a different prompt.');
      if(current.status==='starting'&&Date.now()-current.updated_at_ms>15000){const stale={...current,status:'unknown',error:'submission_start_unconfirmed',retry_safe:false};this.write(stale);return {state:stale,duplicate:true};}
      return { state: current, duplicate: true };
    }
    const state={task_id:id.toLowerCase(),digest,status:'starting',submission:'not_sent',timeout_ms:timeoutMs,created_at_ms:Date.now(),updated_at_ms:Date.now()};
    this.write(state); return { state, duplicate:false };
  }
  acquire(id) {
    const value={task_id:id.toLowerCase(),lock_id:randomUUID(),created_at_ms:Date.now()};
    let descriptor;
    try { descriptor=fs.openSync(this.lockFile,'wx',0o600);fs.writeFileSync(descriptor,JSON.stringify(value,null,2)+'\n');fs.closeSync(descriptor);return value; }
    catch(error){if(descriptor!==undefined)fs.closeSync(descriptor);if(error.code==='EEXIST'){const owner=JSON.parse(fs.readFileSync(this.lockFile,'utf8'));fail('window_busy',`Doubao Work is owned by task ${owner.task_id}.`);}throw error;}
  }
  release(lock) {
    if(!lock)return false;let current;
    try{current=JSON.parse(fs.readFileSync(this.lockFile,'utf8'));}catch(error){if(error.code==='ENOENT')return false;throw error;}
    if(current.lock_id!==lock.lock_id||current.task_id!==lock.task_id)fail('window_lock_mismatch','Window lock ownership changed.');
    fs.unlinkSync(this.lockFile);return true;
  }
  lockFor(id) { if(!fs.existsSync(this.lockFile))return null;const lock=JSON.parse(fs.readFileSync(this.lockFile,'utf8'));return lock.task_id===id.toLowerCase()?lock:null; }
}
