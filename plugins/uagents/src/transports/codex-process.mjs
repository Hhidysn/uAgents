import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { childEnvironment } from '../runtime/child-environment.mjs';
import { verifiedNativeInputs } from '../artifacts/attachments.mjs';
import { fail } from '../protocol/errors.mjs';
import { uuidPattern } from '../protocol/schema.mjs';

const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
const VERSION_TIMEOUT_MS = 10_000;
const CLOSE_GRACE_MS = 2_000;

export function locateCodexEntry(env = process.env, entryOverride = null) {
  const explicit = entryOverride ?? env.UAGENTS_CODEX_CLI;
  if (explicit) {
    if (!path.isAbsolute(explicit) || path.basename(explicit).toLowerCase() !== 'codex.js' ||
        !fs.existsSync(explicit) || !fs.statSync(explicit).isFile()) {
      fail('invalid_cli_path', 'Codex CLI entry must be an existing absolute codex.js path.');
    }
    return path.resolve(explicit);
  }
  const dirs = (env.PATH ?? env.Path ?? '').split(path.delimiter).map(p => p.replace(/^"|"$/g, '')).filter(Boolean);
  const roots = [env.APPDATA && path.join(env.APPDATA, 'npm'), ...dirs].filter(Boolean);
  const found = roots.map(root => path.join(root, 'node_modules', '@openai', 'codex', 'bin', 'codex.js'))
    .find(file => fs.existsSync(file) && fs.statSync(file).isFile());
  if (!found) fail('cli_not_found', 'Installed @openai/codex npm CLI was not found; no installation was attempted.');
  return path.resolve(found);
}

export function prepareCodexImages(request, workspace, snapshots = []) {
  const inputs = request.inputs ?? [];
  if (inputs.some(input => input.type !== 'image')) {
    fail('unsupported_capability', 'Codex CLI has no native generic file attachment input.', {
      category: 'policy', submission: 'not_sent',
    });
  }
  return verifiedNativeInputs(workspace, inputs, snapshots).map(input => input.absolute_path);
}

export function codexExecArgs(request, workspace, entry, session = null, imagePaths = []) {
  const imageArgs = imagePaths.flatMap(imagePath => ['--image', imagePath]);
  if (!session) return [entry, 'exec', '--json', '--model', request.model_resolved, '--cd', workspace, ...imageArgs, '-'];
  if (!['continue', 'fork'].includes(session.action) || !uuidPattern.test(session.native_session_id ?? '')) {
    fail('invalid_native_session', 'Codex continuation/fork requires an explicit native UUID from a completed source task.', {
      category: 'user', submission: 'not_sent',
    });
  }
  // Native exec resume/fork have no --cd option. cwd is pinned by spawn;
  // avoid --last or any implicit native session selection.
  return [entry, 'exec', session.action === 'continue' ? 'resume' : 'fork', '--json', '--model',
    request.model_resolved, ...imageArgs, session.native_session_id, '-'];
}

export function buildCodexPrompt(request, workspace) {
  return `uAgents task workspace: ${workspace}\nMode: ${request.mode}. Expected files: ${JSON.stringify(request.expected_outputs ?? [])}\nWork only on this task. Other workers may be active; do not revert their changes.\n\n${request.prompt}`;
}

export function probeCodexVersion(entry, { spawnImpl = spawn } = {}) {
  return new Promise(resolve => {
    let child;
    try {
      child = spawnImpl(process.execPath, [entry, '--version'], {
        windowsHide: true, env: childEnvironment(), stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch {
      resolve({ status: 'failed', error: 'native_version_probe_failed', submission: 'not_sent' });
      return;
    }
    let text = '';
    let finished = false;
    const finish = value => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => {
      child.kill();
      finish({ status: 'failed', error: 'native_version_probe_timeout', submission: 'not_sent' });
    }, VERSION_TIMEOUT_MS);
    child.stdout?.on('data', chunk => { text = (text + chunk.toString('utf8')).slice(-4096); });
    child.once('error', () => finish({ status: 'failed', error: 'native_version_probe_failed', submission: 'not_sent' }));
    child.once('close', code => {
      const version = text.trim().match(/^codex-cli\s+(\S+)$/)?.[1];
      finish(code === 0 && version
        ? { status: 'succeeded', scope: 'version_only', version, submission: 'not_sent' }
        : { status: 'failed', error: 'native_version_probe_failed', submission: 'not_sent' });
    });
  });
}

export function createCodexParser(onAccepted = () => {}, session = null) {
  let threadId = null;
  let turnStarted = false;
  let turnCompleted = false;
  let turnFailed = false;
  let nativeError = null;
  let response = '';
  let usage = null;

  return {
    event(event) {
      if (!event || typeof event !== 'object' || Array.isArray(event) || typeof event.type !== 'string') {
        throw Object.assign(new Error('Invalid Codex JSON event.'), { code: 'invalid_event' });
      }
      if (event.type === 'thread.started') {
        if (turnStarted || typeof event.thread_id !== 'string' || !event.thread_id || (threadId && threadId !== event.thread_id)) {
          throw Object.assign(new Error('Codex thread identity mismatch.'), { code: 'native_session_mismatch' });
        }
        if (session?.action === 'continue' && event.thread_id !== session.native_session_id ||
            session?.action === 'fork' && event.thread_id === session.native_session_id) {
          throw Object.assign(new Error('Codex continuation/fork thread identity mismatch.'), { code: 'native_session_mismatch' });
        }
        if (!threadId) { threadId = event.thread_id; onAccepted(threadId); }
      } else if (event.type === 'turn.started') {
        if (!threadId || turnStarted || turnCompleted || turnFailed) {
          throw Object.assign(new Error('Codex turn start is out of order.'), { code: 'invalid_event_order' });
        }
        turnStarted = true;
      } else if (event.type === 'item.completed' && event.item?.type === 'agent_message' && typeof event.item.text === 'string') {
        if (!turnStarted || turnCompleted || turnFailed) {
          throw Object.assign(new Error('Codex assistant message is out of order.'), { code: 'invalid_event_order' });
        }
        response = event.item.text;
      } else if (event.type === 'turn.completed') {
        if (!turnStarted || turnCompleted || turnFailed) {
          throw Object.assign(new Error('Codex turn completion is out of order.'), { code: 'invalid_event_order' });
        }
        turnCompleted = true;
        if (event.usage && typeof event.usage === 'object') usage = event.usage;
      } else if (event.type === 'turn.failed') {
        // Native pre-turn failures can be authoritative even without turn.started.
        if (turnCompleted || turnFailed) {
          throw Object.assign(new Error('Codex turn failure is out of order.'), { code: 'invalid_event_order' });
        }
        turnFailed = true;
        nativeError = typeof event.error?.message === 'string' ? event.error.message : 'native_turn_failed';
      } else if (event.type === 'error') {
        nativeError = typeof event.message === 'string' ? event.message : 'native_error';
      }
    },
    finish(code, processError = null) {
      const data = { native_session_id: threadId, response, usage };
      if (turnFailed) return { status: 'failed', error: 'native_turn_failed', native_status: 'failed', data };
      if (threadId && turnCompleted && code === 0 && response.trim()) {
        return { status: 'succeeded', native_status: 'completed', data };
      }
      return {
        status: 'unknown',
        error: processError ?? (nativeError ? 'native_error' : !threadId ? 'native_session_missing' : !turnCompleted ? 'native_terminal_missing' : !response.trim() ? 'native_response_empty' : 'native_process_exit'),
        native_status: turnCompleted ? 'completed' : 'unknown',
        data,
      };
    },
  };
}

export function invokeCodexExec({ entry, request, workspace, publish = () => {}, onAccepted = () => {},
  session = null, imagePaths = [], signal = null, isCancelRequested = null, spawnImpl = spawn, closeGraceMs = CLOSE_GRACE_MS } = {}) {
  if (signal?.aborted || isCancelRequested?.()) {
    return Promise.resolve({ status: 'cancelled', error: 'cancelled_before_send', submission: 'not_sent' });
  }
  const args = codexExecArgs(request, workspace, entry, session, imagePaths);
  return new Promise(resolve => {
    let child;
    try {
      child = spawnImpl(process.execPath, args, {
        cwd: workspace, windowsHide: true, env: childEnvironment(), stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch {
      resolve({ status: 'failed', error: 'native_process_error', submission: 'not_sent' });
      return;
    }
    const decoder = new StringDecoder('utf8');
    const parser = createCodexParser(threadId => {
      publish({ native_session_id: threadId });
      onAccepted({ session_id: threadId, task_id: null, status: 'accepted' });
    }, session);
    let sent = false;
    let finished = false;
    let buffer = '';
    let bytes = 0;
    let streamError = null;
    let exitError = null;
    let cancelled = false;
    let timedOut = false;
    let closeTimer = null;
    const finish = outcome => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      clearTimeout(closeTimer);
      clearInterval(cancelPoll);
      signal?.removeEventListener?.('abort', cancel);
      resolve(outcome);
    };
    const outcome = (code, launcherCloseConfirmed) => {
      if (!sent) return {
        status: cancelled ? 'cancelled' : 'failed',
        error: cancelled ? 'cancelled_before_send' : exitError ?? streamError ?? 'native_preflight_failed',
        submission: 'not_sent', launcher_close_confirmed: launcherCloseConfirmed,
      };
      const parsed = parser.finish(code, streamError ?? exitError);
      return {
        status: cancelled || timedOut || streamError || exitError || !launcherCloseConfirmed ? 'unknown' : parsed.status,
        error: cancelled ? 'cancel_remote_state_unknown' : timedOut ? 'native_observation_timeout'
          : streamError ?? exitError ?? (!launcherCloseConfirmed ? 'native_close_unconfirmed' : parsed.error),
        native_status: parsed.native_status,
        response: parsed.data.response,
        usage: parsed.data.usage,
        native_session_id: parsed.data.native_session_id,
        launcher_close_confirmed: launcherCloseConfirmed,
      };
    };
    const stop = () => {
      if (finished || closeTimer) return;
      try { child.kill(); } catch {}
      // The npm JS launcher can fail to close after its own child has been
      // signalled. Never hold the worker lease indefinitely waiting for close.
      closeTimer = setTimeout(() => {
        child.stdin?.destroy?.();
        child.stdout?.destroy?.();
        child.stderr?.destroy?.();
        child.unref?.();
        finish(outcome(null, false));
      }, closeGraceMs);
    };
    const cancel = () => { if (!cancelled && !finished) { cancelled = true; stop(); } };
    if (signal?.aborted) cancel();
    else signal?.addEventListener?.('abort', cancel, { once: true });
    const cancelPoll = setInterval(() => {
      try { if (isCancelRequested?.()) cancel(); } catch {}
    }, 100);
    cancelPoll.unref?.();
    const timer = setTimeout(() => { timedOut = true; stop(); }, request.execution.observation_timeout_ms);
    const parseLine = text => {
      if (!text.trim() || streamError) return;
      try { parser.event(JSON.parse(text)); }
      catch (error) { streamError = error?.code ?? 'malformed_stream'; stop(); }
    };
    child.stdout?.on('data', chunk => {
      bytes += chunk.length;
      if (bytes > MAX_OUTPUT_BYTES) { streamError = 'output_limit'; stop(); return; }
      buffer += decoder.write(chunk);
      let newline;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const text = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        parseLine(text);
      }
    });
    child.stderr?.on('data', () => {});
    child.stdin?.on('error', () => { exitError ??= 'stdin_failed'; stop(); });
    child.once('error', () => { exitError ??= 'native_process_error'; stop(); });
    child.once('close', code => {
      if (finished) return;
      buffer += decoder.end();
      if (buffer.trim()) parseLine(buffer);
      finish(outcome(code, true));
    });
    child.once('spawn', () => {
      if (finished || cancelled) return;
      if (isCancelRequested?.()) { cancel(); return; }
      try { publish({ status: 'running', submission: 'may_have_been_sent' }); }
      catch { exitError = 'checkpoint_failed'; stop(); return; }
      sent = true;
      try { child.stdin.end(buildCodexPrompt(request, workspace)); }
      catch { exitError = 'stdin_failed'; stop(); }
    });
  });
}
