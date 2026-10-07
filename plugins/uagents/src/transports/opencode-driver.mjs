import path from 'node:path';
import { errorRecord, fail, UAgentsError } from '../protocol/errors.mjs';
import { childEnvironment } from '../runtime/child-environment.mjs';
import { runNoPromptCommand } from './no-prompt-command.mjs';
import { readOpenCodeSession } from './opencode-session.mjs';
import { recordToolError } from './native-diagnostics.mjs';

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

export function parseOpenCodeVersion(text) {
  return String(text).trim().match(/^(?:opencode v)?(\d+\.\d+\.\d+(?:[-+][\w.-]+)?)$/)?.[1] ?? null;
}

export async function openCodeMajorVersion(entry, { runner = runNoPromptCommand, env = process.env } = {}) {
  let result;
  try {
    result = await runner(entry, ['--version'], {
      windowsHide: true, env: childEnvironment(env), timeout: 5_000, maxBuffer: 8192,
    });
  } catch {
    fail('native_version_probe_failed', 'Installed OpenCode version could not be verified.', {
      category: 'target', submission: 'not_sent',
    });
  }
  const version = result.status === 0 && !result.error ? parseOpenCodeVersion(result.stdout) : null;
  if (!version) fail('native_version_probe_failed', 'Installed OpenCode version could not be verified.', {
    category: 'target', submission: 'not_sent',
  });
  return Number(version.split('.')[0]);
}

export function buildOpenCodeArgs(request, workspace, { majorVersion = 1 } = {}) {
  if (request.kind === 'probe') return ['--version'];
  const nativeArgs = validateOpenCodeNativeArgs(request.native_args ?? []);
  const standalone = majorVersion >= 2 && request.execution_timeout_ms != null;
  if (standalone && nativeArgs.some(argument => argument === '--server' || argument.startsWith('--server=') ||
      (argument.startsWith('--standalone=') && argument !== '--standalone=true'))) {
    fail('unsupported_capability', 'OpenCode V2 execution deadlines require a private --standalone server.', {
      category: 'policy', submission: 'not_sent',
    });
  }
  const sourceSession = request.continue_session_id ?? request.fork_session_id ?? null;
  if (sourceSession && nativeArgs.some(isSessionSelectionArg)) {
    fail('invalid_request', 'execution.native_args cannot override structured OpenCode session selection.', {
      category: 'user', submission: 'not_sent',
    });
  }
  const files = (request.inputs ?? []).flatMap(input => ['--file', path.resolve(workspace, input.path)]);
  return [
    'run',
    ...(standalone && !nativeArgs.includes('--standalone') ? ['--standalone'] : []),
    ...(sourceSession ? ['--session', sourceSession] : []),
    ...(request.fork_session_id ? ['--fork'] : []),
    '--model', request.model, '--format', 'json',
    ...(majorVersion < 2 ? ['--dir', workspace] : []),
    ...(sourceSession ? [] : ['--title', `uAgents ${request.request_id}`]),
    ...files,
    ...nativeArgs,
  ];
}

export function buildOpenCodePrompt(request, workspace) {
  return `uAgents task workspace: ${workspace}\nMode: ${request.mode}. Expected files: ${JSON.stringify(request.expected_outputs ?? [])}\nWork only on this task. Do not delegate or start background work. You are not alone; do not revert others' edits.\n\n${request.prompt}`;
}

export function createOpenCodeDriver(request, workspace, entry, { majorVersion = 1 } = {}) {
  return {
    command: entry,
    // Both transports set cwd to workspace. V2 removed the redundant --dir flag.
    args: buildOpenCodeArgs(request, workspace, { majorVersion }),
    createParser: publish => createOpenCodeParser(request, workspace, publish, {
      sessionReader: majorVersion >= 2 ? session => readOpenCodeSession(entry, workspace, session) : null,
    }),
    buildPrompt: () => buildOpenCodePrompt(request, workspace),
    initialObservation: { native_edit_mode: 'inherited' },
  };
}

export function createOpenCodeParser(request, workspace, publish, { sessionReader = null } = {}) {
  let session, finalStep, stepMessage, approval = false, nativeError, nativeErrorMessage;
  const textParts = new Map();
  const toolErrors = [];
  const expectedSession = request.continue_session_id ?? null;
  const forbiddenSession = request.fork_session_id ?? null;

  function identity(id) {
    if (typeof id !== 'string' || !id || (session && id !== session) || (expectedSession && id !== expectedSession) ||
        (forbiddenSession && id === forbiddenSession)) identityError();
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
        nativeErrorMessage = stepMessage;
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
        recordToolError(toolErrors, part.tool, toolError);
        publish({
          last_tool: typeof part.tool === 'string' ? part.tool : null,
          ...(state ? { native_tool_state: state.status ?? null } : {}),
        });
        if (denied(toolError)) approval = true;
      }
    },
    finish(code) {
      const response = [...textParts.values()]
        .filter(part => part.messageID === (finalStep?.messageID ?? stepMessage))
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
      const outcome = {
        status,
        ...(error ? { error } : {}),
        native_status: nativeStatus,
        native_exit_code: code,
        diagnostics: { transport: 'opencode-jsonl', native_exit_code: code, tool_errors: toolErrors },
        retry_safe: false,
        ...(session ? { result: { native_session_id: session, response, usage } } : {}),
      };
      // V2 may omit step_finish, or recover a provider error in a later message
      // while retaining exit code one. Only exact final session evidence can
      // confirm that recovery; neither later text nor an exit code proves it.
      const missingFinish = status === 'unknown' && code === 0 && !finalStep;
      const recoveredError = status === 'failed' && nativeError && nativeErrorMessage &&
        stepMessage !== nativeErrorMessage && (code === 0 || code === 1);
      if ((missingFinish || recoveredError) && session && stepMessage && response.trim() && sessionReader) {
        return Promise.resolve().then(() => sessionReader(session)).then(snapshot => {
          const verified = verifyOpenCodeCompletion(snapshot, { session, message: stepMessage, response, workspace, model: request.model });
          if (!verified) return outcome;
          return { ...outcome, status: 'succeeded', error: null, native_status: 'succeeded',
            model_reported: verified.model, result: { ...outcome.result, usage: verified.usage } };
        }).catch(() => outcome);
      }
      return outcome;
    },
  };
}

const identityError = () => fail('native_session_mismatch', 'Native event identity does not match this task.');
const isSessionSelectionArg = argument => argument === '--session' || argument.startsWith('--session=') || argument === '-s' ||
  argument === '--continue' || argument === '-c' || argument === '--fork';
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const denied = value => typeof value === 'string' && /permission.*(denied|requested|requires|approval)|auto.reject|soft.denied|not allowed/i.test(value);

function openCodeError(event) {
  const native = object(event.error) ? event.error : {};
  const data = object(native.data) ? native.data : {};
  const status = Number.isInteger(data.statusCode) ? data.statusCode : Number.isInteger(native.status) ? native.status : null;
  const nativeName = typeof native.name === 'string' && native.name ? native.name :
    typeof native.type === 'string' && /^[a-zA-Z0-9._-]{1,100}$/.test(native.type) ? native.type : null;
  const authentication = status === 401 || status === 403;
  const quota = status === 429 && nativeName === 'provider.quota';
  const code = authentication ? 'authentication_required' : quota ? 'quota_exhausted' : 'native_error';
  const message = authentication
    ? `OpenCode provider authentication failed (HTTP ${status}). Re-authenticate the configured provider.`
    : quota ? 'OpenCode provider reported exhausted quota (HTTP 429).'
    : `OpenCode reported a native error${status === null ? '.' : ` (HTTP ${status}).`}`;
  return errorRecord(new UAgentsError(code, message, {
    category: 'target', retryable: false, submission: 'sent',
    details: {
      ...(nativeName ? { native_error_name: nativeName } : {}),
      ...(status === null ? {} : { native_http_status: status }),
    },
  }));
}

export function verifyOpenCodeCompletion(snapshot, { session, message, response, workspace, model }) {
  if (!object(snapshot?.info) || snapshot.info.id !== session || snapshot.info.outcome !== 'succeeded' ||
      !Array.isArray(snapshot.messages)) return null;
  const directory = snapshot.info.location?.directory;
  if (typeof directory !== 'string' || !path.isAbsolute(directory)) return null;
  const normalize = value => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value);
  if (normalize(directory) !== normalize(workspace)) return null;
  const idle = snapshot.messages.at(-1);
  const assistant = snapshot.messages.at(-2);
  if (idle?.type !== 'idle' || assistant?.type !== 'assistant' || assistant.id !== message || assistant.error ||
      !Number.isSafeInteger(assistant.time?.completed) || assistant.time.completed <= 0 ||
      !Number.isSafeInteger(idle.time?.created) || idle.time.created < assistant.time.completed ||
      !Array.isArray(assistant.content)) return null;
  const route = `${assistant.model?.providerID}/${assistant.model?.id}`;
  const [expectedRoute, variant] = model.split('#');
  if (route !== expectedRoute || (variant && assistant.model?.variant !== variant)) return null;
  const text = assistant.content.filter(part => part.type === 'text').map(part => part.text).join('\n');
  if (!response.trim() || text !== response || assistant.content.some(part =>
    part.type === 'tool' && !['completed', 'error'].includes(part.state?.status))) return null;
  return { model: variant ? `${assistant.model.id}#${variant}` : assistant.model.id, usage: snapshot.info.tokens ?? null };
}
