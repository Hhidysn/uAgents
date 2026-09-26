import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { childEnvironment } from '../runtime/child-environment.mjs';
import { verifiedNativeInputs } from '../artifacts/attachments.mjs';
import { fail } from '../protocol/errors.mjs';

const SERVER_NAME = 'deepseek-harness-sdk-runtime';
const OUTPUT_LIMIT = 1024 * 1024;

export function locateDshEntry(env = process.env, entryOverride = null) {
  const explicit = entryOverride ?? env.UAGENTS_DSH_CLI;
  if (explicit) {
    if (!path.isAbsolute(explicit) || !fs.existsSync(explicit) || !fs.statSync(explicit).isFile()) {
      fail('invalid_cli_path', 'DSH CLI override must be an existing absolute JS entry.');
    }
    return path.resolve(explicit);
  }
  const paths = (env.PATH ?? env.Path ?? '').split(path.delimiter).map(item => item.replace(/^"|"$/g, '')).filter(Boolean);
  const candidates = [];
  if (env.APPDATA) candidates.push(path.join(env.APPDATA, 'npm', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'));
  for (const directory of paths) candidates.push(path.join(directory, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'));
  const found = candidates.find(file => fs.existsSync(file) && fs.statSync(file).isFile());
  if (!found) fail('cli_not_found', 'Installed DeepSeek Harness dsh CLI not found; no installation was attempted.');
  return path.resolve(found);
}

export function probeDshVersion(entry, { spawnImpl = spawn } = {}) {
  return new Promise(resolve => {
    const child = spawnImpl(process.execPath, [entry, '--version'], {
      windowsHide: true, env: childEnvironment(process.env), stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    child.stdout?.on('data', chunk => { stdout = (stdout + chunk.toString('utf8')).slice(-8192); });
    child.once('error', () => resolve({ status: 'failed', error: 'native_version_probe_failed', submission: 'not_sent' }));
    child.once('close', code => {
      const version = stdout.trim();
      resolve(code === 0 && /^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(version)
        ? { status: 'succeeded', scope: 'version_only', version, submission: 'not_sent' }
        : { status: 'failed', error: 'native_version_probe_failed', submission: 'not_sent' });
    });
  });
}

export async function invokeDshSdk({
  entry,
  request,
  workspace,
  contentBlocks = null,
  publish = () => {},
  onAccepted = () => {},
  signal = null,
  isCancelRequested = null,
  spawnImpl = spawn,
}) {
  const promptBlocks = contentBlocks ?? buildDshContentBlocks(request, workspace);
  const child = spawnImpl(process.execPath, [entry, '--profile', 'sdk'], {
    cwd: workspace,
    windowsHide: true,
    env: childEnvironment(process.env),
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let nextId = 1;
  let buffer = '';
  let bytes = 0;
  let closed = false;
  let closeCode = null;
  let promptWritten = false;
  let rootRunning = false;
  let rootIdle = false;
  let response = '';
  let usage = null;
  let modelReported = null;
  let turnError = null;
  let protocolError = null;
  let cancellation = null;
  const pending = new Map();
  let completeResolve;
  const complete = new Promise(resolve => { completeResolve = resolve; });

  const finishObservation = () => { completeResolve?.(); };
  const failPending = error => {
    for (const waiter of pending.values()) waiter.reject(error);
    pending.clear();
  };
  const line = text => {
    if (!text.trim()) return;
    let frame;
    try { frame = JSON.parse(text); }
    catch {
      protocolError = 'malformed_stream';
      failPending(Object.assign(new Error('Malformed DSH SDK JSON-RPC frame.'), { code: protocolError }));
      finishObservation();
      return;
    }
    if (Object.hasOwn(frame, 'id')) {
      const waiter = pending.get(frame.id);
      if (!waiter) return;
      pending.delete(frame.id);
      if (frame.error) {
        waiter.reject(Object.assign(new Error(typeof frame.error.message === 'string' ? frame.error.message : 'DSH SDK JSON-RPC error.'), {
          code: 'native_rpc_error', rpc_code: frame.error.code ?? null,
        }));
      } else waiter.resolve(frame.result);
      return;
    }
    if (frame.method === 'session.status' && frame.params?.sessionId === request.request_id) {
      if (frame.params.status === 'running') rootRunning = true;
      if (frame.params.status === 'idle' && rootRunning) {
        rootIdle = true;
        finishObservation();
      }
      return;
    }
    if (frame.method !== 'session.event' || frame.params?.sessionId !== request.request_id) return;
    const event = frame.params.event;
    if (!event || typeof event !== 'object') return;
    if (event.type === 'assistant/message') {
      const message = event.data?.message;
      const content = Array.isArray(message?.content) ? message.content : [];
      const textBlocks = content.filter(block => block?.type === 'text' && typeof block.text === 'string').map(block => block.text);
      if (textBlocks.length) response = textBlocks.join('');
      if (event.data?.usage && typeof event.data.usage === 'object') usage = event.data.usage;
      const reportedModel = typeof message?.source?.model === 'string' && message.source.model
        ? message.source.model
        : typeof message?.model === 'string' && message.model ? message.model : null;
      if (reportedModel) {
        modelReported = reportedModel;
        publish({ model_reported: modelReported });
      }
    }
    if (event.type === 'turn/end' && event.data?.reason?.kind === 'error') turnError = 'native_error';
  };

  child.stdout.on('data', chunk => {
    bytes += chunk.length;
    if (bytes > OUTPUT_LIMIT) {
      protocolError = 'output_limit';
      finishObservation();
      return;
    }
    buffer += chunk.toString('utf8');
    let newline;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const current = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      line(current);
    }
  });
  child.stderr.on('data', () => {});
  child.once('error', error => { failPending(error); finishObservation(); });
  child.once('close', code => {
    closed = true;
    closeCode = code;
    if (buffer.trim()) line(buffer);
    failPending(Object.assign(new Error('DSH SDK runtime exited.'), { code: 'native_process_exit' }));
    finishObservation();
  });

  const requestRpc = (method, params) => new Promise((resolve, reject) => {
    if (closed) {
      reject(Object.assign(new Error('DSH SDK runtime is closed.'), { code: 'native_process_exit' }));
      return;
    }
    const id = nextId++;
    pending.set(id, { resolve, reject });
    try {
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) })}\n`);
    } catch (error) {
      pending.delete(id);
      reject(error);
    }
  });

  const shutdown = async () => {
    if (closed) return;
    try { await Promise.race([requestRpc('shutdown'), delay(1500, true)]); } catch {}
    if (!closed) await Promise.race([waitForClose(), delay(500, true)]);
    if (!closed) child.kill();
  };

  const waitForClose = () => closed ? Promise.resolve() : new Promise(resolve => child.once('close', resolve));

  try {
    const initializeTimeoutMs = Math.min(30_000, request.execution.observation_timeout_ms);
    const initialized = await Promise.race([
      requestRpc('initialize', {
        cwd: workspace,
        provider: request.provider,
        model: request.model_resolved,
      }),
      rejectAfter(initializeTimeoutMs, 'native_initialize_timeout'),
    ]);
    if (initialized?.serverInfo?.name !== SERVER_NAME || typeof initialized?.serverInfo?.version !== 'string') {
      await shutdown();
      return { status: 'failed', error: 'native_protocol_mismatch', native_status: 'initialize_failed' };
    }
    if (signal?.aborted || isCancelRequested?.()) {
      await shutdown();
      return { status: 'cancelled', error: 'cancelled_before_send', native_status: 'cancelled' };
    }

    publish({ status: 'running', submission: 'may_have_been_sent' });
    promptWritten = true;
    const observationStartedAt = Date.now();
    cancellation = watchCancellation(signal, isCancelRequested);
    const promptAck = await Promise.race([
      requestRpc('session/prompt', {
        sessionId: request.request_id,
        contentBlocks: promptBlocks,
      }).then(result => ({ kind: 'ack', result })),
      delay(request.execution.observation_timeout_ms).then(() => ({ kind: 'timeout' })),
      cancellation.promise.then(() => ({ kind: 'cancel' })),
    ]);
    if (promptAck.kind === 'cancel') {
      await shutdown();
      return { status: 'unknown', error: 'cancel_remote_state_unknown', native_status: 'sent', response, usage, model_reported: modelReported };
    }
    if (promptAck.kind === 'timeout') {
      await shutdown();
      return { status: 'unknown', error: 'native_observation_timeout', native_status: 'sent', response, usage, model_reported: modelReported };
    }
    const promptResult = promptAck.result;
    if (typeof promptResult?.messageId !== 'string' || !promptResult.messageId) {
      throw Object.assign(new Error('Missing DSH message id.'), { code: 'native_acceptance_unconfirmed' });
    }
    onAccepted({ session_id: request.request_id, task_id: promptResult.messageId, status: 'accepted' });

    const remainingObservationMs = Math.max(1, request.execution.observation_timeout_ms - (Date.now() - observationStartedAt));
    const observed = await Promise.race([
      complete.then(() => 'complete'),
      delay(remainingObservationMs).then(() => 'timeout'),
      cancellation.promise.then(() => 'cancel'),
    ]);
    if (observed === 'cancel') {
      await shutdown();
      return { status: 'unknown', error: 'cancel_remote_state_unknown', native_status: rootRunning ? 'running' : 'accepted', response, usage, model_reported: modelReported };
    }
    if (observed === 'timeout') {
      await shutdown();
      return { status: 'unknown', error: 'native_observation_timeout', native_status: rootRunning ? 'running' : 'accepted', response, usage, model_reported: modelReported };
    }
    if (protocolError) {
      await shutdown();
      return { status: 'unknown', error: protocolError, native_status: 'unknown', response, usage, model_reported: modelReported };
    }
    if (closed && !(rootRunning && rootIdle)) {
      return { status: 'unknown', error: 'native_process_exit', native_status: closeCode === 0 ? 'exited' : 'error', response, usage, model_reported: modelReported };
    }
    await shutdown();
    if (turnError) return { status: 'failed', error: turnError, native_status: 'error', response, usage, model_reported: modelReported };
    if (!response.trim()) return { status: 'failed', error: 'native_response_empty', native_status: 'idle', response: '', usage, model_reported: modelReported };
    return { status: 'succeeded', native_status: 'idle', response, usage, model_reported: modelReported };
  } catch (error) {
    await shutdown();
    return {
      status: promptWritten ? 'unknown' : 'failed',
      error: error?.code ?? (promptWritten ? 'native_completion_unconfirmed' : 'native_preflight_failed'),
      native_status: promptWritten ? 'unknown' : 'initialize_failed',
      response, usage, model_reported: modelReported,
    };
  } finally {
    cancellation?.cleanup();
  }
}

export function buildDshPrompt(request, workspace) {
  return `uAgents task workspace: ${workspace}\nMode: ${request.mode}. Expected files: ${JSON.stringify(request.expected_outputs ?? [])}\nWork only on this task. Do not delegate or start background work. You are not alone; do not revert others' edits.\n\n${request.prompt}`;
}

export function buildDshContentBlocks(request, workspace, snapshots = []) {
  const inputs = request.inputs ?? [];
  if (inputs.some(input => input.type !== 'image')) {
    fail('unsupported_capability', 'DSH SDK does not accept inline generic file inputs.', {
      category: 'policy', submission: 'not_sent',
    });
  }
  return [{ type: 'text', text: buildDshPrompt(request, workspace) },
    ...verifiedNativeInputs(workspace, inputs, snapshots).map(input => ({
      type: 'image', data: input.bytes.toString('base64'), mimeType: input.media_type,
    }))];
}

const delay = (ms, unref = false) => new Promise(resolve => {
  const timer = setTimeout(resolve, ms);
  if (unref) timer.unref?.();
});

const rejectAfter = (ms, code) => new Promise((_, reject) => {
  const timer = setTimeout(() => reject(Object.assign(new Error(code), { code })), ms);
  timer.unref?.();
});

function watchCancellation(signal, isCancelRequested) {
  let timer = null;
  let abortHandler = null;
  let resolvePromise;
  let settled = false;
  const promise = new Promise(resolve => { resolvePromise = resolve; });
  const cancel = () => {
    if (settled) return;
    settled = true;
    resolvePromise();
  };
  if (signal?.aborted) cancel();
  else if (signal?.addEventListener) {
    abortHandler = cancel;
    signal.addEventListener('abort', abortHandler, { once: true });
  }
  if (!settled && typeof isCancelRequested === 'function') {
    const poll = () => {
      try { if (isCancelRequested()) cancel(); } catch {}
    };
    poll();
    if (!settled) {
      timer = setInterval(poll, 50);
      timer.unref?.();
    }
  }
  return {
    promise,
    cleanup() {
      settled = true;
      if (timer) clearInterval(timer);
      if (abortHandler) signal?.removeEventListener?.('abort', abortHandler);
    },
  };
}
