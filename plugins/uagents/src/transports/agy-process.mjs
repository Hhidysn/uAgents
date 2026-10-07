import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { childEnvironment } from '../runtime/child-environment.mjs';
import { errorRecord, UAgentsError } from '../protocol/errors.mjs';
import { atomicWriteJson } from '../store/task-files.mjs';
import { diagnosticMessage, recordToolError } from './native-diagnostics.mjs';

export function buildAgyArgs(workspace, request) {
  return [
    '--input-format', 'stream-json', '--output-format', 'stream-json',
    '--add-dir', workspace,
    ...(request.mode === 'implementation' ? ['--mode', 'accept-edits'] : []),
    '--model', request.model, '--dangerously-skip-permissions',
    ...(request.effort ? ['--effort', request.effort] : []),
    '--disable-slash-commands', '--print-timeout', `${request.timeout_ms}ms`,
    '--log-file', process.platform === 'win32' ? 'NUL' : '/dev/null',
  ];
}

export function invokeAgy(directory, workspace, request, publish, testDriver, { entry = null, attemptId = null } = {}) {
  return new Promise(resolve => {
    // `entry` is a supervisor-verified absolute agy executable; without it the
    // bare command name is resolved by the OS (legacy behavior).
    const driver = testDriver ?? { command: entry ?? (process.platform === 'win32' ? 'agy.exe' : 'agy'),
      args: buildAgyArgs(workspace, request) };
    const child = spawn(driver.command, driver.args, { cwd: workspace, windowsHide: true, env: driver.env ?? childEnvironment(), stdio: ['pipe', 'pipe', 'pipe'] });
    let sent = false, init, finalResult, outcome, stopped = false, finished = false, closeTimer, buffer = '', byteCount = 0, stderr = '', permissionDenied = false;
    const decoder = new StringDecoder('utf8');
    const stderrDecoder = new StringDecoder('utf8');
    const toolErrors = [];
    let diagnosticStderr = '', diagnosticStderrBytes = 0, stderrTruncated = false;
    let nativeErrorMessage = null, effortReported = null;
    const diagnosticsPath = request.kind !== 'probe' && typeof attemptId === 'string' && /^[a-zA-Z0-9-]+$/.test(attemptId)
      ? path.join(directory, 'native', attemptId, 'diagnostics.json') : null;
    const finish = value => {
      if (finished) return;
      finished = true;
      clearTimeout(timer); clearTimeout(closeTimer); clearInterval(cancellation);
      if (!stderrTruncated) diagnosticStderr += stderrDecoder.end();
      const acceptedResult = init && finalResult?.conversation_id === init.conversation_id ? finalResult : null;
      const diagnostics = {
        transport: 'agy-stream-json', native_status: acceptedResult?.status ?? null,
        native_exit_code: value.native_exit_code ?? null,
        effort_requested: request.effort ?? null, effort_reported: effortReported,
        native_error_message: diagnosticMessage(acceptedResult?.error) ?? nativeErrorMessage,
        stderr_tail: stderrTruncated ? null : diagnosticMessage(diagnosticStderr, { tail: true }),
        stderr_truncated: stderrTruncated, tool_errors: toolErrors,
        native_close_confirmed: value.native_close_confirmed ?? value.native_exit_code !== undefined,
      };
      if (diagnosticsPath) {
        try { atomicWriteJson(diagnosticsPath, diagnostics); }
        catch { diagnostics.persistence_error = 'native_diagnostics_write_failed'; }
      }
      resolve({ ...value, diagnostics });
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
    child.stderr.on('data', chunk => {
      const text = stderrDecoder.write(chunk);
      stderr = (stderr + text).slice(-8192);
      if (stderrTruncated) return;
      diagnosticStderrBytes += chunk.length;
      // Keep complete input until redaction. A raw rolling tail could discard a
      // credential/payload marker while retaining its private contents.
      if (diagnosticStderrBytes > 64 * 1024) { diagnosticStderr = ''; stderrTruncated = true; }
      else diagnosticStderr += text;
    });
    const line = text => {
      if (!text.trim() || stopped || finished) return;
      let event;
      try { event = JSON.parse(text); } catch { stop(sent ? 'unknown' : 'failed', 'malformed_stream'); return; }
      if (!event || typeof event !== 'object' || Array.isArray(event) || typeof event.event !== 'string') {
        stop(sent ? 'unknown' : 'failed', 'invalid_event'); return;
      }
      const eventSession = event.event === 'result' ? event.result?.conversation_id : event.conversation_id;
      if (sent && event.event !== 'init' && (eventSession === undefined || eventSession === init?.conversation_id)) {
        nativeErrorMessage = diagnosticMessage(event.error ?? event.step_update?.error ?? event.step_update?.error_info ?? event.step_update?.error_details) ?? nativeErrorMessage;
      }
      if (event.event === 'init') {
        if (init) { stop(sent ? 'unknown' : 'blocked', 'duplicate_init'); return; }
        init = event;
        const settings = event.init;
        effortReported = typeof settings?.effort === 'string' ? settings.effort : null;
        if (!settings || settings.model !== request.model ||
            typeof event.conversation_id !== 'string' || !event.conversation_id ||
            typeof settings.cwd !== 'string' || path.resolve(settings.cwd).toLowerCase() !== path.resolve(workspace).toLowerCase()) {
          stop('blocked', 'identity_unverified'); return;
        }
        publish({ native_session_id: event.conversation_id, model_reported: settings.model,
          tool_count: Array.isArray(settings.tools) ? settings.tools.length : null,
          native_permission_mode: settings.permission_mode ?? null, permission_policy: request.permission_policy,
          native_edit_mode: request.mode === 'implementation' ? 'accept-edits' : 'inherited' });
        // The configured native flag auto-approves tools. Read-only review guidance
        // remains advisory; implementation also selects native accept-edits mode.
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
        if (event.conversation_id !== undefined && event.conversation_id !== init?.conversation_id) {
          stop('unknown', 'native_session_mismatch'); return;
        }
        const step = event.step_update;
        const toolError = step.tool_info?.error;
        const toolErrorMessage = typeof toolError === 'string' ? toolError : toolError?.message;
        recordToolError(toolErrors, step.tool_name, toolError);
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
        if (outcome.scope === 'preflight_only' && (code !== 0 || finalResult?.status === 'ERROR')) finish({ status: 'failed', error: 'native_preflight_failed', submission: 'not_sent', native_exit_code: code });
        else finish({ ...outcome, native_exit_code: code });
        return;
      }
      if (!sent) {
        finish({ status: 'failed', error: 'preflight_incomplete', submission: 'not_sent', native_exit_code: code }); return;
      }
      if (!finalResult || finalResult.conversation_id !== init?.conversation_id) {
        finish({ status: 'unknown', error: 'missing_or_mismatched_result', retry_safe: false, native_exit_code: code }); return;
      }
      const nativeStatus = finalResult.status;
      let status = nativeStatus === 'SUCCESS' && code === 0 && typeof finalResult.response === 'string' && finalResult.response.trim() ? 'succeeded'
        : nativeStatus === 'CANCELED' ? 'cancelled' : nativeStatus === 'WAITING' ? 'needs_user'
        : nativeStatus === 'ERROR' ? 'failed' : 'unknown';
      // A zero exit or success response does not erase a native approval failure.
      if (permissionDenied || /permission.*(denied|requires|approval)|soft.denied/i.test(stderr)) status = 'needs_user';
      const reason = diagnosticMessage(finalResult.error) ?? nativeErrorMessage;
      const error = status === 'needs_user' ? 'native_approval_required'
        : status === 'failed' ? errorRecord(new UAgentsError('native_error', reason ?? 'agy reported ERROR without a native error reason.', {
          category: 'target', submission: 'sent', retryable: false,
          details: { native_status: nativeStatus, native_exit_code: code, reason_available: Boolean(reason) },
        })) : status === 'unknown' ? 'native_completion_unconfirmed' : null;
      finish({ status, ...(error ? { error } : {}), native_status: nativeStatus, native_exit_code: code, retry_safe: false,
        result: { native_session_id: finalResult.conversation_id, response: finalResult.response ?? '', usage: finalResult.usage ?? null } });
    });
  });
}
