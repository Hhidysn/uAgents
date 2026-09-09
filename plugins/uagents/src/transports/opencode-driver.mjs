import path from 'node:path';
import { errorRecord, fail, UAgentsError } from '../protocol/errors.mjs';

const OPENCODE_PROTOCOL_FLAGS = Object.freeze(['--model', '--format', '--dir', '--title']);

export function validateOpenCodeNativeArgs(nativeArgs = []) {
  if (!Array.isArray(nativeArgs)) {
    fail('invalid_request', 'execution.native_args must be an array.', { category: 'user', submission: 'not_sent' });
  }
  for (const [index, argument] of nativeArgs.entries()) {
    for (const flag of OPENCODE_PROTOCOL_FLAGS) {
      if (argument === flag || argument.startsWith(`${flag}=`)) {
        fail('invalid_request', `execution.native_args[${index}] conflicts with dispatcher-owned OpenCode flag ${flag}.`, {
          category: 'user', submission: 'not_sent', details: { argument_index: index, flag },
        });
      }
    }
  }
  if (nativeArgs[0] === 'run') {
    fail('invalid_request', 'execution.native_args cannot replace the dispatcher-owned OpenCode run subcommand.', {
      category: 'user', submission: 'not_sent', details: { argument_index: 0, subcommand: 'run' },
    });
  }
  return nativeArgs;
}

export function buildOpenCodeArgs(request, workspace) {
  if (request.kind === 'probe') return ['--version'];
  const nativeArgs = validateOpenCodeNativeArgs(request.native_args ?? []);
  const files = (request.inputs ?? []).flatMap(input => ['--file', path.resolve(workspace, input.path)]);
  return [
    'run', '--model', request.model, '--format', 'json', '--dir', workspace, '--title', `uAgents ${request.request_id}`,
    ...files,
    ...nativeArgs,
  ];
}

export function buildOpenCodePrompt(request, workspace) {
  return `uAgents task workspace: ${workspace}\nMode: ${request.mode}. Expected files: ${JSON.stringify(request.expected_outputs ?? [])}\nWork only on this task. Do not delegate or start background work. You are not alone; do not revert others' edits.\n\n${request.prompt}`;
}

export function createOpenCodeDriver(request, workspace, entry) {
  return {
    command: entry,
    args: buildOpenCodeArgs(request, workspace),
    createParser: publish => createOpenCodeParser(request, workspace, publish),
    buildPrompt: () => buildOpenCodePrompt(request, workspace),
    initialObservation: { native_edit_mode: 'inherited' },
  };
}

export function createOpenCodeParser(request, workspace, publish) {
  let session, finalStep, stepMessage, approval = false, nativeError;
  const textParts = new Map();

  function identity(id) {
    if (typeof id !== 'string' || !id || (session && id !== session)) identityError();
    if (!session) {
      session = id;
      publish({ native_session_id: id });
    }
  }

  return {
    stderr(text) {
      if (denied(text)) approval = true;
    },
    event(event) {
      if (!object(event) || typeof event.type !== 'string') fail('invalid_event', 'Invalid native event.');
      identity(event.sessionID);
      if (event.type === 'error') {
        nativeError = openCodeError(event);
        return;
      }
      const part = event.part;
      if (!object(part)) fail('invalid_event', 'Missing OpenCode part.');
      identity(part.sessionID);
      if (typeof part.messageID !== 'string' || typeof part.id !== 'string') fail('invalid_event', 'Missing part identity.');
      if (event.type === 'text') {
        if (part.messageID !== stepMessage) identityError();
        if (typeof part.text !== 'string') fail('invalid_result', 'Invalid text part.');
        const previous = textParts.get(part.id);
        if (previous && previous.messageID !== part.messageID) identityError();
        textParts.set(part.id, { messageID: part.messageID, text: part.text });
      } else if (event.type === 'step_start') {
        finalStep = null;
        stepMessage = part.messageID;
        textParts.clear();
      } else if (event.type === 'step_finish') {
        if (part.messageID !== stepMessage) identityError();
        if (typeof part.reason !== 'string') fail('invalid_result', 'Missing finish reason.');
        finalStep = part;
      } else if (event.type === 'tool_use') {
        const state = object(part.state) ? part.state : null;
        const toolError = state?.error;
        publish({
          last_tool: typeof part.tool === 'string' ? part.tool : null,
          ...(state ? { native_tool_state: state.status ?? null } : {}),
        });
        if (denied(toolError)) approval = true;
      }
    },
    finish(code) {
      const response = [...textParts.values()]
        .filter(part => part.messageID === finalStep?.messageID)
        .map(part => part.text)
        .join('\n');
      const nativeStatus = finalStep?.reason ?? null;
      const usage = finalStep?.tokens ?? null;
      let status = 'unknown';
      let error;
      if (nativeError) {
        status = 'failed';
        error = nativeError;
      } else if (code === 0 && nativeStatus === 'stop' && response.trim()) {
        status = 'succeeded';
      }
      if (approval) {
        status = 'needs_user';
        error = 'native_approval_required';
      }
      if (!error && status === 'unknown') error = 'native_completion_unconfirmed';
      return {
        status,
        ...(error ? { error } : {}),
        native_status: nativeStatus,
        native_exit_code: code,
        retry_safe: false,
        ...(session ? { result: { native_session_id: session, response, usage } } : {}),
      };
    },
  };
}

const identityError = () => fail('native_session_mismatch', 'Native event identity does not match this task.');
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const denied = value => typeof value === 'string' && /permission.*(denied|requested|requires|approval)|auto.reject|soft.denied|not allowed/i.test(value);

function openCodeError(event) {
  const native = object(event.error) ? event.error : {};
  const data = object(native.data) ? native.data : {};
  const status = Number.isInteger(data.statusCode) ? data.statusCode : null;
  const nativeName = typeof native.name === 'string' && native.name ? native.name : null;
  const authentication = status === 401 || status === 403;
  const code = authentication ? 'authentication_required' : 'native_error';
  const message = authentication
    ? `OpenCode provider authentication failed (HTTP ${status}). Re-authenticate the configured provider.`
    : `OpenCode reported a native error${status === null ? '.' : ` (HTTP ${status}).`}`;
  return errorRecord(new UAgentsError(code, message, {
    category: 'target', retryable: false, submission: 'sent',
    details: {
      ...(nativeName ? { native_error_name: nativeName } : {}),
      ...(status === null ? {} : { native_http_status: status }),
    },
  }));
}
