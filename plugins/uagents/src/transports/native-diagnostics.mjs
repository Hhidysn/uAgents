import { redactText } from '../protocol/errors.mjs';
import fs from 'node:fs';

// Persist bounded failure evidence, never tool arguments, provider bodies or
// entire native events. A successful turn can still contain failed tools.
export function diagnosticMessage(value, { tail = false } = {}) {
  const message = typeof value === 'string' ? value
    : typeof value?.message === 'string' ? value.message
      : typeof value?.error_message === 'string' ? value.error_message : null;
  if (!message) return null;
  const safe = redactText(message
    // Native argument-validation errors can echo entire write contents. Keep
    // the actual failure reason but omit echoed tool/provider payloads.
    .replace(/\b(?:Arguments\s+provided|Tool\s+arguments|(?:Request|Response)\s+body)\s*:[\s\S]*/gi, '[Native payload omitted]')
    .replace(/(["'](?:authorization|x-api-key|api[-_]?key|(?:(?:access|refresh)[-_]?)?token|cookie|client[-_]?secret|password)["']\s*:\s*)("(?:\\.|[^"\\])*(?:"|$)|'(?:\\.|[^'\\])*(?:'|$))/gi, '$1"[REDACTED]"')
    .replace(/\b(bearer|basic)\s+[a-zA-Z0-9._~+/=-]+/gi, '$1 [REDACTED]')
    .replace(/((?:authorization|proxy-authorization|cookie|set-cookie)\s*[:=]\s*)[^\r\n]+/gi, '$1[REDACTED]')
    .replace(/\b(https?:\/\/)[^\s/@]+@/gi, '$1[REDACTED]@'));
  return tail ? safe.slice(-1024) : safe.slice(0, 1024);
}

export function recordToolError(errors, tool, value) {
  const message = diagnosticMessage(value);
  if (!message) return;
  if (errors.length < 50) errors.push({ tool: diagnosticMessage(tool)?.slice(0, 100) ?? null, message });
}

export function sanitizeNativeDiagnostics(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const result = {};
  for (const field of ['transport', 'native_status', 'effort_requested', 'effort_reported', 'persistence_error']) {
    if (typeof value[field] === 'string' && /^[a-zA-Z0-9_.-]{1,100}$/.test(value[field])) result[field] = value[field];
    else if (value[field] === null) result[field] = null;
  }
  if (Number.isInteger(value.native_exit_code) || value.native_exit_code === null) result.native_exit_code = value.native_exit_code;
  if (typeof value.native_close_confirmed === 'boolean') result.native_close_confirmed = value.native_close_confirmed;
  if (typeof value.stderr_truncated === 'boolean') result.stderr_truncated = value.stderr_truncated;
  for (const field of ['native_error_message', 'stderr_tail']) {
    if (field in value) result[field] = diagnosticMessage(value[field], { tail: field === 'stderr_tail' });
  }
  if (Array.isArray(value.tool_errors)) {
    result.tool_errors = [];
    for (const failure of value.tool_errors.slice(0, 50)) recordToolError(result.tool_errors, failure?.tool, failure?.message);
  }
  if (Array.isArray(value.native_errors)) result.native_errors = value.native_errors.slice(0, 10).map(error => ({
    type: typeof error?.type === 'string' && /^[a-zA-Z0-9_.-]{1,100}$/.test(error.type) ? error.type : null,
    status: Number.isInteger(error?.status) ? error.status : null,
    message: diagnosticMessage(error?.message),
  }));
  if (value.transcript && typeof value.transcript === 'object') {
    result.transcript = {};
    for (const field of ['bytes_read', 'file_bytes', 'malformed_lines']) {
      if (Number.isSafeInteger(value.transcript[field]) && value.transcript[field] >= 0) result.transcript[field] = value.transcript[field];
    }
    if (typeof value.transcript.truncated === 'boolean') result.transcript.truncated = value.transcript.truncated;
    if (typeof value.transcript.identity_verified === 'boolean') result.transcript.identity_verified = value.transcript.identity_verified;
  }
  return result;
}

// Diagnostic-only replay never sends a prompt, declares completion, or fills
// model/response evidence. Timeouts can precede parser.finish despite earlier errors.
export function readOpenCodeDiagnostics(file, { sessionId = null, limitBytes = 1024 * 1024 } = {}) {
  const verified = typeof sessionId === 'string' && sessionId.length > 0;
  const summary = { tool_errors: [], native_errors: [], transcript: { bytes_read: 0, file_bytes: 0, malformed_lines: 0, truncated: false, identity_verified: false } };
  let descriptor;
  try {
    descriptor = fs.openSync(file, 'r');
    summary.transcript.file_bytes = fs.fstatSync(descriptor).size;
    const buffer = Buffer.alloc(Math.min(summary.transcript.file_bytes, limitBytes));
    const count = fs.readSync(descriptor, buffer, 0, buffer.length, 0);
    summary.transcript.bytes_read = count;
    summary.transcript.truncated = count < summary.transcript.file_bytes;
    const seen = new Set();
    for (const line of buffer.subarray(0, count).toString('utf8').split('\n')) {
      if (!line.trim()) continue;
      let event;
      try { event = JSON.parse(line); } catch { summary.transcript.malformed_lines++; continue; }
      if (!verified || !event || typeof event !== 'object' || event.sessionID !== sessionId) continue;
      if (['step_start', 'step_finish', 'text', 'tool_use'].includes(event.type) && event.part?.sessionID === sessionId) {
        summary.transcript.identity_verified = true;
      }
      if (event.type === 'tool_use' && event.part?.state?.error) {
        if (event.part.sessionID !== sessionId) continue;
        const key = event.part?.id;
        if (typeof key === 'string' && seen.has(key)) continue;
        if (typeof key === 'string') seen.add(key);
        recordToolError(summary.tool_errors, event.part.tool, event.part.state.error);
      }
      if (event.type === 'error' && summary.native_errors.length < 10) {
        if (!event.error || typeof event.error !== 'object' || Array.isArray(event.error)) continue;
        summary.transcript.identity_verified = true;
        summary.native_errors.push({ type: event.error?.type ?? event.error?.name ?? null,
          status: event.error?.status ?? event.error?.data?.statusCode ?? null,
          message: diagnosticMessage(event.error?.message ?? event.error?.data?.message) });
      }
    }
  } catch { /* Missing transcripts cannot create execution evidence. */ }
  finally { if (descriptor !== undefined) fs.closeSync(descriptor); }
  return sanitizeNativeDiagnostics(summary);
}
