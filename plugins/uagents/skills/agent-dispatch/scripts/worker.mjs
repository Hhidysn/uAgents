import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { StringDecoder } from 'node:string_decoder';
import { atomicJson, digest, inspectOutputs, normalizeRequest, readJson } from './store.mjs';
import { invokeCli } from './cli-adapters.mjs';

export async function work(directory, testDriver) {
  let state = readJson(path.join(directory, 'state.json'));
  const publish = patch => {
    state = { ...state, ...patch, updated_at_ms: Date.now() };
    atomicJson(path.join(directory, 'state.json'), state);
  };
  let heartbeat;
  try {
    const saved = readJson(path.join(directory, 'inbox.json'));
    const { kind, ...input } = saved;
    const request = normalizeRequest(input, kind);
    if (digest(request) !== state.digest) throw new Error('request_digest_mismatch');
    fs.unlinkSync(path.join(directory, 'inbox.json'));
    const workspace = path.join(directory, 'workspace');
    fs.mkdirSync(workspace, { recursive: true });
    publish({ status: 'preflight', workspace, worker_pid: process.pid, worker_started_at_ms: Date.now() });
    heartbeat = setInterval(() => publish({}), 1000);
    const outcome = await (request.target === 'agy' ? invokeAgy : invokeCli)(directory, workspace, request, publish, testDriver);
    if (outcome.status === 'succeeded' && request.kind === 'run') {
      const artifacts = inspectOutputs(workspace, request.expected_outputs);
      outcome.result.artifacts = artifacts;
      outcome.artifact_check = artifacts.some(item => item.error) ? 'failed' : 'passed';
      if (outcome.artifact_check === 'failed') { outcome.status = 'failed'; outcome.error = 'expected_output_validation_failed'; }
    }
    if (outcome.result) atomicJson(path.join(directory, 'result.json'), outcome.result);
    const { result: _result, ...metadata } = outcome;
    publish(metadata);
  } catch (error) {
    publish({ status: state.submission === 'may_have_been_sent' ? 'unknown' : 'failed', error: 'worker_error', error_code: error.code ?? error.name, error_syscall: error.syscall ?? null, retry_safe: false });
  } finally { clearInterval(heartbeat); }
}

export function invokeAgy(directory, workspace, request, publish, testDriver) {
  return new Promise(resolve => {
    const driver = testDriver ?? { command: process.platform === 'win32' ? 'agy.exe' : 'agy', args: [
      '--input-format', 'stream-json', '--output-format', 'stream-json',
      '--add-dir', workspace,
      ...(request.mode === 'implementation' ? ['--mode', 'accept-edits'] : []),
      '--model', request.model, '--sandbox', '--disable-slash-commands', '--print-timeout', `${request.timeout_ms}ms`,
      '--log-file', process.platform === 'win32' ? 'NUL' : '/dev/null',
    ] };
    const child = spawn(driver.command, driver.args, { cwd: workspace, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let sent = false, init, finalResult, outcome, stopped = false, finished = false, closeTimer, buffer = '', byteCount = 0, stderr = '', permissionDenied = false;
    const decoder = new StringDecoder('utf8');
    const finish = value => {
      if (finished) return;
      finished = true;
      clearTimeout(timer); clearTimeout(closeTimer); clearInterval(cancellation);
      resolve(value);
    };
    const stop = (status, error) => {
      if (stopped || finished) return;
      stopped = true;
      outcome = { status, error, retry_safe: false };
      child.stdin.destroy();
      child.kill(); // Live ChildProcess handle; never reopen or kill a persisted PID.
      closeTimer = setTimeout(() => {
        child.stdout.destroy(); child.stderr.destroy(); child.unref();
        finish({ ...outcome, native_close_confirmed: false });
      }, 2000);
    };
    const timer = setTimeout(() => stop(sent ? 'unknown' : 'failed', sent ? 'deadline_remote_state_unknown' : 'preflight_timeout'), request.timeout_ms);
    const cancellation = setInterval(() => {
      if (fs.existsSync(path.join(directory, 'cancel.json'))) stop(sent ? 'unknown' : 'cancelled', sent ? 'cancel_remote_state_unknown' : 'cancelled_before_send');
    }, 100);
    child.stdin.on('error', () => stop(sent ? 'unknown' : 'failed', 'stdin_failed'));
    child.on('error', () => { if (!stopped && !finished) outcome = { status: sent ? 'unknown' : 'failed', error: 'native_process_error', retry_safe: false }; });
    child.stderr.on('data', chunk => { stderr = (stderr + chunk.toString('utf8')).slice(-8192); });
    const line = text => {
      if (!text.trim() || stopped || finished) return;
      let event;
      try { event = JSON.parse(text); } catch { stop(sent ? 'unknown' : 'failed', 'malformed_stream'); return; }
      if (!event || typeof event !== 'object' || Array.isArray(event) || typeof event.event !== 'string') {
        stop(sent ? 'unknown' : 'failed', 'invalid_event'); return;
      }
      if (event.event === 'init') {
        if (init) { stop(sent ? 'unknown' : 'blocked', 'duplicate_init'); return; }
        init = event;
        const settings = event.init;
        if (!settings || settings.model !== request.model ||
            typeof event.conversation_id !== 'string' || !event.conversation_id ||
            typeof settings.cwd !== 'string' || path.resolve(settings.cwd).toLowerCase() !== path.resolve(workspace).toLowerCase()) {
          stop('blocked', 'identity_unverified'); return;
        }
        publish({ native_session_id: event.conversation_id, model_reported: settings.model,
          tool_count: Array.isArray(settings.tools) ? settings.tools.length : null,
          native_permission_mode: settings.permission_mode ?? null, permission_policy: request.permission_policy,
          native_edit_mode: request.mode === 'implementation' ? 'accept-edits' : 'inherited' });
        // Native agy permissions govern tools. This adapter does not enforce read-only access
        // or disable tool approval. Implementation opts into native accept-edits for files.
        if (fs.existsSync(path.join(directory, 'cancel.json'))) { stop('cancelled', 'cancelled_before_send'); return; }
        if (request.kind === 'probe') {
          outcome = { status: 'succeeded', scope: 'preflight_only', submission: 'not_sent' };
          child.stdin.end(); return;
        }
        // Persist the ambiguity BEFORE the potentially billable write. Never replay automatically.
        publish({ status: 'running', submission: 'may_have_been_sent' });
        sent = true;
        const content = `uAgents task workspace (already exists): ${workspace}\nTask mode: ${request.mode}. Operate in this directory; do not create or switch to a scratch workspace. Other workers may be active; do not revert their changes.\nExpected output files, relative to this directory: ${JSON.stringify(request.expected_outputs)}\n\n${request.prompt}`;
        child.stdin.end(JSON.stringify({ event: 'user', message: { content } }) + '\n');
      } else if (event.event === 'result') {
        if (finalResult) { stop(sent ? 'unknown' : 'failed', 'duplicate_result'); return; }
        if (!event.result || typeof event.result !== 'object' || Array.isArray(event.result) ||
            typeof event.result.status !== 'string' || typeof event.result.conversation_id !== 'string') {
          stop(sent ? 'unknown' : 'failed', 'invalid_result'); return;
        }
        finalResult = event.result;
        if (!init) stop('failed', typeof finalResult.error === 'string' && finalResult.error.includes('Eligibility') ? 'native_eligibility_failed' : 'native_preflight_failed');
      } else if (event.event === 'step_update' && event.step_update?.step_type === 'tool') {
        if (!sent) { stop('blocked', 'tool_before_submission'); return; }
        const step = event.step_update;
        const toolError = step.tool_info?.error;
        const toolErrorMessage = typeof toolError === 'string' ? toolError : toolError?.message;
        if (typeof toolErrorMessage === 'string' && /permission.*(denied|requires|approval)|soft.denied/i.test(toolErrorMessage)) permissionDenied = true;
        publish({ last_tool: typeof step.tool_name === 'string' ? step.tool_name : null });
      }
    };
    const safeLine = text => {
      try { line(text); } catch { stop(sent ? 'unknown' : 'failed', 'stream_handling_failed'); }
    };
    child.stdout.on('data', chunk => {
      if (finished) return;
      byteCount += chunk.length;
      if (byteCount > 1048576) { stop(sent ? 'unknown' : 'failed', 'output_limit'); return; }
      buffer += decoder.write(chunk);
      let newline;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const current = buffer.slice(0, newline); buffer = buffer.slice(newline + 1); safeLine(current);
      }
    });
    child.on('close', code => {
      if (finished) return;
      buffer += decoder.end(); if (buffer) safeLine(buffer);
      if (outcome) {
        if (outcome.scope === 'preflight_only' && (code !== 0 || finalResult?.status === 'ERROR')) finish({ status: 'failed', error: 'native_preflight_failed', submission: 'not_sent' });
        else finish(outcome);
        return;
      }
      if (!sent) {
        finish({ status: 'failed', error: 'preflight_incomplete', submission: 'not_sent' }); return;
      }
      if (!finalResult || finalResult.conversation_id !== init?.conversation_id) {
        finish({ status: 'unknown', error: 'missing_or_mismatched_result', retry_safe: false }); return;
      }
      const nativeStatus = finalResult.status;
      let status = nativeStatus === 'SUCCESS' && code === 0 && typeof finalResult.response === 'string' && finalResult.response.trim() ? 'succeeded'
        : nativeStatus === 'CANCELED' ? 'cancelled' : nativeStatus === 'WAITING' ? 'needs_user'
        : nativeStatus === 'ERROR' ? 'failed' : 'unknown';
      // A zero exit or success response does not erase a native approval failure.
      if (permissionDenied || /permission.*(denied|requires|approval)|soft.denied/i.test(stderr)) status = 'needs_user';
      finish({ status, ...(status === 'needs_user' ? { error: 'native_approval_required' } : {}), native_status: nativeStatus, native_exit_code: code, retry_safe: false,
        result: { native_session_id: finalResult.conversation_id, response: finalResult.response ?? '', usage: finalResult.usage ?? null } });
    });
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await work(path.resolve(process.argv[2]));
}
