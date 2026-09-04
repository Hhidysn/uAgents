import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { fail } from '../protocol/errors.mjs';
import { childEnvironment } from '../runtime/child-environment.mjs';

// Only launch installed native entrypoints. No shell, installation, auth reads or config edits.
export function locateCli(target, env = process.env) {
  const override = env[target === 'workbuddy' ? 'UAGENTS_WORKBUDDY_CLI' : 'UAGENTS_OPENCODE_BIN'];
  if (override) {
    if (!path.isAbsolute(override) || !fs.existsSync(override) || !fs.statSync(override).isFile() ||
        (target === 'workbuddy' ? !override.endsWith('codebuddy.js') : process.platform === 'win32' && !override.toLowerCase().endsWith('.exe'))) {
      fail('invalid_cli_path', 'CLI override must be an existing absolute native executable or codebuddy.js path.');
    }
    return override;
  }
  const directories = (env.PATH ?? env.Path ?? '').split(path.delimiter).map(p => p.replace(/^"|"$/g, '')).filter(Boolean);
  const candidates = target === 'workbuddy'
    ? [env.ProgramFiles && path.join(env.ProgramFiles, 'WorkBuddy/resources/app.asar.unpacked/cli/dist/codebuddy.js'),
       env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, 'Programs/WorkBuddy/resources/app.asar.unpacked/cli/dist/codebuddy.js')]
    : directories.flatMap(dir => [path.join(dir, process.platform === 'win32' ? 'opencode.exe' : 'opencode'),
      ...(process.platform === 'win32' ? [path.join(dir, 'node_modules/opencode-ai/bin/opencode.exe')] : [])]);
  const found = candidates.find(file => file && fs.existsSync(file) && fs.statSync(file).isFile());
  if (!found) fail('cli_not_found', `Installed ${target} CLI not found. Configure its UAGENTS path override; no installation was attempted.`);
  return found;
}

export function nativeDriver(request, workspace) {
  const entry = locateCli(request.target);
  if (request.target === 'opencode') return { command: entry, args: request.kind === 'probe' ? ['--version'] : [
    'run', '--pure', '--model', request.model, '--format', 'json', '--dir', workspace, '--title', `uAgents ${request.request_id}`,
  ] };
  return { command: process.execPath, args: [entry, ...(request.kind === 'probe' ? ['--version'] : [
    '-p', '--output-format', 'stream-json', '--verbose', '--session-id', request.request_id, '--max-turns', '6',
    ...(request.mode === 'implementation' ? ['--permission-mode', 'acceptEdits'] : []),
  ])], env: childEnvironment(process.env, { CODEBUDDY_CODE_DISABLE_BACKGROUND_TASKS: '1' }) };
}

const identityError = () => fail('native_session_mismatch', 'Native event identity does not match this task.');
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const denied = value => typeof value === 'string' && /permission.*(denied|requested|requires|approval)|auto.reject|soft.denied|not allowed/i.test(value);

// Native protocols differ: WorkBuddy has a terminal result; OpenCode emits completed parts.
export function createParser(request, workspace, publish) {
  let session, init, final, lastStep, stepMessage, approval = false, nativeError;
  const textParts = new Map(), active = new Set();
  function identity(id) {
    if (typeof id !== 'string' || !id || (session && id !== session) ||
        (request.target === 'workbuddy' && id !== request.request_id)) identityError();
    if (!session) { session = id; publish({ native_session_id: id }); }
  }
  return {
    stderr(text) { if (denied(text)) approval = true; },
    event(event) {
      if (!object(event) || typeof event.type !== 'string') fail('invalid_event', 'Invalid native event.');
      if (request.target === 'workbuddy') {
        if (event.session_id !== undefined) identity(event.session_id);
        if (event.type === 'system' && event.subtype === 'init') {
          if (init) fail('duplicate_init', 'Repeated native initialization.');
          identity(event.session_id);
          if (typeof event.cwd !== 'string' || path.resolve(event.cwd).toLowerCase() !== path.resolve(workspace).toLowerCase()) identityError();
          init = event;
          publish({ model_reported: typeof event.model === 'string' ? event.model : null, native_permission_mode: event.permissionMode ?? null });
        } else if (event.type === 'result') {
          if (final) fail('duplicate_result', 'Repeated native result.');
          identity(event.session_id);
          if (!init || typeof event.subtype !== 'string' || typeof event.is_error !== 'boolean') fail('invalid_result', 'Invalid WorkBuddy result.');
          final = event;
          if (Array.isArray(event.permission_denials) && event.permission_denials.length) approval = true;
        } else if (event.type === 'system' && typeof event.task_id === 'string') {
          if (event.subtype === 'task_started') active.add(event.task_id);
          const taskStatus = event.status ?? event.patch?.status;
          if (['completed', 'failed', 'stopped', 'killed', 'cancelled'].includes(taskStatus)) active.delete(event.task_id);
          if (['failed', 'stopped', 'killed', 'cancelled'].includes(taskStatus)) nativeError = 'native_background_task_failed';
        }
        return;
      }
      identity(event.sessionID);
      if (event.type === 'error') {
        nativeError = 'native_error'; return;
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
        lastStep = null; stepMessage = part.messageID; textParts.clear();
      }
      else if (event.type === 'step_finish') {
        if (part.messageID !== stepMessage) identityError();
        if (typeof part.reason !== 'string') fail('invalid_result', 'Missing finish reason.');
        lastStep = part;
      } else if (event.type === 'tool_use') {
        publish({ last_tool: typeof part.tool === 'string' ? part.tool : null });
        if (denied(part.state?.error)) approval = true;
      }
    },
    finish(code) {
      let response = '', usage = null, nativeStatus, status = 'unknown', error;
      if (request.target === 'workbuddy') {
        nativeStatus = final?.subtype ?? null;
        response = typeof final?.result === 'string' ? final.result : '';
        usage = final?.usage ?? null;
        if (nativeError || final?.is_error === true) { status = 'failed'; error = nativeError ?? 'native_error'; }
        else if (final?.subtype === 'success' && code === 0 && response.trim() && active.size === 0) status = 'succeeded';
        if (active.size) error = 'native_background_tasks_unconfirmed';
      } else {
        nativeStatus = lastStep?.reason ?? null;
        response = [...textParts.values()].filter(part => part.messageID === lastStep?.messageID).map(part => part.text).join('\n');
        usage = lastStep?.tokens ?? null;
        if (nativeError) { status = 'failed'; error = nativeError; }
        else if (code === 0 && nativeStatus === 'stop' && response.trim()) status = 'succeeded';
      }
      if (approval) { status = 'needs_user'; error = 'native_approval_required'; }
      if (!error && status === 'unknown') error = 'native_completion_unconfirmed';
      return { status, ...(error ? { error } : {}), native_status: nativeStatus, native_exit_code: code, retry_safe: false,
        ...(session ? { result: { native_session_id: session, response, usage } } : {}) };
    },
  };
}

export function invokeCli(directory, workspace, request, publish, testDriver) {
  if (fs.existsSync(path.join(directory, 'cancel.json'))) return Promise.resolve({ status: 'cancelled', submission: 'not_sent', error: 'cancelled_before_send' });
  const driver = testDriver ?? nativeDriver(request, workspace);
  return new Promise(resolve => {
    const child = (testDriver?.spawn ?? spawn)(driver.command, driver.args, {
      cwd: workspace, windowsHide: true, env: driver.env ?? childEnvironment(), stdio: ['pipe', 'pipe', 'pipe'],
    });
    const parser = createParser(request, workspace, publish), decoder = new StringDecoder('utf8');
    let sent = false, stopped = false, finished = false, outcome, closeTimer, buffer = '', bytes = 0, version = '', stderr = '';
    const finish = value => {
      if (finished) return;
      finished = true; clearTimeout(timer); clearTimeout(closeTimer); clearInterval(cancellation); resolve(value);
    };
    const stop = (status, error) => {
      if (stopped || finished) return;
      stopped = true; outcome = { status, error, retry_safe: false }; child.stdin.destroy(); child.kill();
      closeTimer = setTimeout(() => { child.stdout.destroy(); child.stderr.destroy(); child.unref(); finish({ ...outcome, native_close_confirmed: false }); }, 2000);
    };
    const timer = setTimeout(() => stop(sent ? 'unknown' : 'failed', sent ? 'deadline_remote_state_unknown' : 'preflight_timeout'), request.timeout_ms);
    const cancellation = setInterval(() => {
      if (fs.existsSync(path.join(directory, 'cancel.json'))) stop(sent ? 'unknown' : 'cancelled', sent ? 'cancel_remote_state_unknown' : 'cancelled_before_send');
    }, 100);
    const line = text => {
      if (!text.trim() || stopped || finished) return;
      if (request.kind === 'probe') { version += text; return; }
      try { parser.event(JSON.parse(text)); }
      catch (error) { stop(sent ? 'unknown' : 'failed', error.code ?? 'malformed_stream'); }
    };
    child.once('spawn', () => {
      try {
        if (fs.existsSync(path.join(directory, 'cancel.json'))) { stop('cancelled', 'cancelled_before_send'); return; }
        if (request.kind === 'probe') { child.stdin.end(); return; }
        // These CLIs need input before a handshake. Mark ambiguity before writing, then validate output identity.
        publish({ status: 'running', submission: 'may_have_been_sent', model_reported: null,
          native_edit_mode: request.target === 'workbuddy' && request.mode === 'implementation' ? 'acceptEdits' : 'inherited' });
        sent = true;
        child.stdin.end(`uAgents task workspace: ${workspace}\nMode: ${request.mode}. Expected files: ${JSON.stringify(request.expected_outputs)}\nWork only on this task. Do not delegate or start background work. You are not alone; do not revert others' edits.\n\n${request.prompt}`);
      } catch { stop(sent ? 'unknown' : 'failed', 'submission_failed'); }
    });
    child.stdin.on('error', () => stop(sent ? 'unknown' : 'failed', 'stdin_failed'));
    child.on('error', () => { if (!stopped && !finished) outcome = { status: sent ? 'unknown' : 'failed', error: 'native_process_error', retry_safe: false }; });
    child.stderr.on('data', chunk => { stderr = (stderr + chunk.toString('utf8')).slice(-8192); parser.stderr(stderr); });
    child.stdout.on('data', chunk => {
      if (stopped || finished) return;
      bytes += chunk.length;
      if (bytes > 1048576) { stop(sent ? 'unknown' : 'failed', 'output_limit'); return; }
      buffer += decoder.write(chunk);
      let end;
      while ((end = buffer.indexOf('\n')) >= 0) { const current = buffer.slice(0, end); buffer = buffer.slice(end + 1); line(current); }
    });
    child.on('close', code => {
      if (finished) return;
      buffer += decoder.end(); if (buffer) line(buffer);
      if (outcome) { finish(outcome); return; }
      if (request.kind === 'probe') {
        const match = version.trim().match(/^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/);
        finish(code === 0 && match ? { status: 'succeeded', scope: 'version_only', version: match[0], submission: 'not_sent' }
          : { status: 'failed', error: 'native_version_probe_failed', submission: 'not_sent' }); return;
      }
      try { finish(parser.finish(code)); } catch { finish({ status: 'unknown', error: 'result_handling_failed', retry_safe: false }); }
    });
  });
}
