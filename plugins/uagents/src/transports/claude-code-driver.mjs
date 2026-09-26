import path from 'node:path';
import { verifiedNativeInputs } from '../artifacts/attachments.mjs';
import { childEnvironment } from '../runtime/child-environment.mjs';
import { fail } from '../protocol/errors.mjs';

const samePath = (left, right) => process.platform === 'win32'
  ? path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase()
  : path.resolve(left) === path.resolve(right);

export function createClaudeCodeDriver(request, workspace, entry, snapshots = []) {
  if (request.kind === 'probe') return { command: entry, args: ['--version'], env: childEnvironment() };
  if (typeof request.model !== 'string' || !request.model.trim() || request.model === 'default') {
    fail('model_unavailable', 'Claude Code requires an approved concrete model ID.', { submission: 'not_sent' });
  }
  const hasInputs = (request.inputs ?? []).length > 0;
  return {
    command: entry,
    args: ['--print', '--output-format', 'stream-json', '--verbose', '--model', request.model,
      ...(hasInputs ? ['--input-format', 'stream-json'] : [])],
    env: childEnvironment(),
    stdinPayload: hasInputs ? buildClaudeCodeInput(request, workspace, snapshots) : request.prompt,
    initialObservation: { native_edit_mode: 'inherited' },
    createParser: publish => createClaudeCodeParser(request, workspace, publish),
  };
}

export function buildClaudeCodeInput(request, workspace, snapshots = []) {
  const inputs = request.inputs ?? [];
  const attachments = verifiedNativeInputs(workspace, inputs, snapshots);
  const content = [{ type: 'text', text: request.prompt }];
  for (const [index, input] of inputs.entries()) {
    const attachment = attachments[index];
    if (input.type === 'image') {
      content.push({ type: 'image', source: {
        type: 'base64', media_type: attachment.media_type, data: attachment.bytes.toString('base64'),
      } });
    } else if (attachment.media_type === 'application/pdf') {
      content.push({ type: 'document', source: {
        type: 'base64', media_type: 'application/pdf', data: attachment.bytes.toString('base64'),
      }, title: path.basename(input.path) });
    } else {
      let data;
      try { data = new TextDecoder('utf-8', { fatal: true }).decode(attachment.bytes); }
      catch { unsupportedFile(input.path); }
      if (data.includes('\0')) unsupportedFile(input.path);
      content.push({ type: 'document', source: { type: 'text', media_type: 'text/plain', data },
        title: path.basename(input.path) });
    }
  }
  return `${JSON.stringify({ type: 'user', message: { role: 'user', content } })}\n`;
}

function unsupportedFile(inputPath) {
  fail('unsupported_capability', `Claude Code file input requires PDF or UTF-8 text: ${inputPath}`, {
    category: 'policy', submission: 'not_sent',
  });
}

export function createClaudeCodeParser(request, workspace, publish = () => {}) {
  let session = null;
  let init = null;
  let result = null;
  const identity = id => {
    if (typeof id !== 'string' || !id || session && session !== id) {
      fail('native_session_mismatch', 'Claude Code session identity changed.');
    }
    if (!session) { session = id; publish({ native_session_id: id }); }
  };
  return {
    stderr() {},
    event(event) {
      if (!event || typeof event !== 'object' || Array.isArray(event) || typeof event.type !== 'string') {
        fail('invalid_event', 'Invalid Claude Code stream event.');
      }
      if (event.session_id !== undefined) identity(event.session_id);
      if (event.type === 'system' && event.subtype === 'init') {
        if (init || typeof event.cwd !== 'string' || !samePath(event.cwd, workspace) ||
            typeof event.model !== 'string' || !event.model) {
          fail('invalid_event', 'Claude Code initialization is missing or inconsistent.');
        }
        init = event;
        publish({ model_reported: event.model });
      } else if (event.type === 'result') {
        if (result || !init || typeof event.is_error !== 'boolean' || typeof event.subtype !== 'string') {
          fail('invalid_result', 'Claude Code result is missing initialization or is duplicated.');
        }
        result = event;
      }
    },
    finish(code) {
      let status = 'unknown', error = 'native_completion_unconfirmed';
      if (result && init) {
        if (result.is_error || result.subtype !== 'success') {
          status = 'failed'; error = 'native_error';
        } else if (Array.isArray(result.permission_denials) && result.permission_denials.length) {
          status = 'needs_user'; error = 'native_approval_required';
        } else if (init.model !== request.model) {
          status = 'failed'; error = 'model_identity_mismatch';
        } else if (code === 0 && typeof result.result === 'string' && result.result.trim()) {
          status = 'succeeded'; error = null;
        }
      }
      return {
        status, ...(error ? { error } : {}), native_status: result?.subtype ?? null,
        native_exit_code: code, retry_safe: false,
        ...(session ? { result: {
          native_session_id: session,
          response: typeof result?.result === 'string' ? result.result : '',
          usage: result?.usage ?? null,
        } } : {}),
      };
    },
  };
}
