import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fail } from '../protocol/errors.mjs';

export const PI_SESSION_GUARD_PATH = fileURLToPath(new URL('./pi-session-guard.mjs', import.meta.url));

// Pi owns `--mode json` (JSONL session events) and its session selection flags.
// uAgents never forwards caller-provided native args to this driver, so only
// the dispatcher appears here.
export function parsePiVersion(text) {
  return String(text).trim().match(/^(\d+\.\d+\.\d+(?:[-+][\w.-]+)?)$/)?.[1] ?? null;
}

export function buildPiArgs(request, workspace) {
  if (request.kind === 'probe') return ['--version'];
  // Pi resolves `@path` from the process cwd, which invokeCli sets to the
  // workspace; pass absolute paths so a changed cwd could never re-resolve them.
  const files = (request.inputs ?? []).map(input => `@${path.resolve(workspace, input.path)}`);
  return [
    '--mode', 'json',
    '--extension', PI_SESSION_GUARD_PATH,
    ...(request.provider ? ['--provider', request.provider] : []),
    ...(request.model ? ['--model', request.model] : []),
    ...(request.effort ? ['--thinking', request.effort] : []),
    ...(request.continue_session_id ? ['--session', request.continue_session_id] : []),
    ...(request.fork_session_id ? ['--fork', request.fork_session_id] : []),
    ...files,
  ];
}

export function createPiDriver(request, workspace, entry) {
  return {
    // The installed pi entry is a Node script; run it with the current runtime
    // instead of a shell or an npm shim.
    command: process.execPath,
    args: [entry, ...buildPiArgs(request, workspace)],
    createParser: publish => createPiParser(request, workspace, publish),
    initialObservation: { native_edit_mode: 'inherited' },
  };
}

// JSON mode emits one session header, then agent/turn/message events, then
// `agent_settled` once no automatic work remains. The last assistant
// `message_end` is the authoritative final message.
export function createPiParser(request, workspace, publish) {
  let session = null, final = null, settled = false, approval = false, guard = null, guardFinal = false, sessionChangeBlocked = false;
  const expectedSession = request.continue_session_id ?? null;
  const forbiddenSession = request.fork_session_id ?? null;

  function identity(id) {
    if (typeof id !== 'string' || !id || (session && id !== session) ||
        (expectedSession && id !== expectedSession) || (forbiddenSession && id === forbiddenSession)) identityError();
    if (!session) {
      session = id;
      publish({ native_session_id: id });
    }
  }

  return {
    stderr(text) { if (denied(text)) approval = true; },
    event(event) {
      if (!object(event) || typeof event.type !== 'string') fail('invalid_event', 'Invalid native event.');
      if (event.type === 'uagents_pi_identity') {
        if (typeof event.id !== 'string' || !event.id || !sameWorkspace(event.cwd, workspace) ||
            (session && event.id !== session) || (guard && event.id !== guard.id)) identityError();
        guard = { id: event.id };
        // Raw guard writes can overtake Pi's queued JSON events. Only the
        // process-lifecycle quit snapshot proves the final session identity;
        // delayed agent_start records cannot invalidate that terminal proof.
        if (event.phase === 'quit') guardFinal = true;
        return;
      }
      if (event.type === 'uagents_pi_session_change_blocked') {
        sessionChangeBlocked = true;
        return;
      }
      if (event.type === 'uagents_pi_guard_invalidated') {
        guard = null; guardFinal = false; final = null; settled = false; publish({ model_reported: null });
        return;
      }
      if (event.type === 'session') {
        // Pi documents the session header as the first JSON-mode record. A
        // second header, a workspace mismatch, or any event before the header
        // means the stream cannot be bound to this task, so identity is only
        // published after the workspace is validated.
        if (session) identityError();
        if (!sameWorkspace(event.cwd, workspace) || (guard && event.id !== guard.id)) identityError();
        identity(event.id);
        return;
      }
      if (!session) identityError();
      // `agent_settled` closes only the latest low-level run; a new
      // `agent_start` (retry, compaction, steering or follow-up) invalidates
      // earlier settlement evidence.
      if (event.type === 'agent_start') { settled = false; final = null; publish({ model_reported: null }); return; }
      if (event.type === 'message_end' && object(event.message) && event.message.role === 'assistant') {
        // Intermediate assistant turns end with tool calls; the last message
        // before `agent_settled` is the final answer.
        final = event.message;
        publish({ model_reported: typeof event.message.model === 'string' ? event.message.model : null });
        return;
      }
      if (event.type === 'agent_settled') { settled = true; return; }
      if (event.type === 'tool_execution_end' && event.isError === true && denied(JSON.stringify(event.result ?? ''))) {
        approval = true;
      }
    },
    finish(code) {
      const response = final ? contentText(final.content) : '';
      const nativeStatus = typeof final?.stopReason === 'string' ? final.stopReason : null;
      const usage = final?.usage ?? null;
      let status = 'unknown', error;
      if (nativeStatus === 'error') { status = 'failed'; error = 'native_error'; }
      else if (nativeStatus === 'aborted') { status = 'failed'; error = 'native_aborted'; }
      else if (settled && code === 0 && (nativeStatus === 'stop' || nativeStatus === 'length') && response.trim()) {
        status = 'succeeded';
      }
      if (final && (final.provider !== request.provider || final.model !== request.model)) {
        status = 'failed'; error = 'native_model_mismatch';
      }
      if (approval) { status = 'needs_user'; error = 'native_approval_required'; }
      if (!guard || guard.id !== session || !guardFinal) { status = 'unknown'; error = 'native_session_guard_unconfirmed'; }
      if (sessionChangeBlocked) { status = 'unknown'; error = 'native_session_change_blocked'; }
      if (!error && status === 'unknown') error = 'native_completion_unconfirmed';
      return {
        status, ...(error ? { error } : {}), native_status: nativeStatus, native_exit_code: code, retry_safe: false,
        model_identity_verified: Boolean(guard && guard.id === session && guardFinal && !sessionChangeBlocked && final?.provider === request.provider && final?.model === request.model),
        ...(session ? { result: { native_session_id: session, response, usage } } : {}),
      };
    },
  };
}

export function contentText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter(part => object(part) && part.type === 'text' && typeof part.text === 'string')
    .map(part => part.text).join('\n');
}

const identityError = () => fail('native_session_mismatch', 'Native event identity does not match this task.');
const sameWorkspace = (actual, expected) => {
  if (typeof actual !== 'string') return false;
  const left = path.resolve(actual), right = path.resolve(expected);
  return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;
};
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const denied = value => typeof value === 'string' && /permission.*(denied|requested|requires|approval)|auto.reject|soft.denied|not allowed/i.test(value);
