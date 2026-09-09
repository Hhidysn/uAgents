import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { setTimeout as delay } from 'node:timers/promises';
import { fail, UAgentsError } from '../protocol/errors.mjs';
import { atomicWriteJson } from '../store/task-files.mjs';
import {
  bindProcessIdentity,
  createProvisionalProcess,
  getNativeProcess,
  markProcessExited,
  markProcessUnknown,
  nativeLaunchFingerprint,
  releaseWorkspaceGuard,
  updateTranscriptCursor,
} from '../runtime/native-processes.mjs';
import { canonicalWorkspace } from '../runtime/workspace-key.mjs';
import { refreshWorkspaceExecutionGuard } from '../runtime/workspace-execution-guard.mjs';
import { executionTimeoutEvidence, executionTimeoutPending } from '../runtime/execution-timeout.mjs';
import { launchExecutionTimeoutGuardian } from '../runtime/execution-timeout-guardian.mjs';

export const DURABLE_STDOUT_LIMIT_BYTES = 1024 * 1024;
export const DURABLE_STDERR_LIMIT_BYTES = 64 * 1024;
const DURABLE_STDERR_PARSER_WINDOW_CHARS = 8192;
const DEFAULT_PROCESS_IDENTITY_BUDGET_MS = 2_000;
const DEFAULT_PROCESS_IDENTITY_RETRY_MS = 40;
const DEFAULT_ACCEPT_POLL_MS = 20;
// Covers one guardian-claim failover (5s TTL) plus a full owned-tree
// termination budget (10s) with margin for Windows inspection latency. The
// observer may report unconfirmed after this window, but it must not beat a
// healthy redundant guardian that is still inside its documented failover.
const EXECUTION_TIMEOUT_SETTLE_MS = 20_000;

export function prepareDurableExecution({
  driver,
  request,
  workspace,
  taskDirectory,
  attemptId,
  installation = null,
  coreVersion = null,
  adapterVersion = null,
} = {}) {
  if (!driver || typeof driver !== 'object') fail('invalid_request', 'A durable CLI driver is required.');
  if (!request || typeof request !== 'object') fail('invalid_request', 'A durable CLI request is required.');
  if (typeof attemptId !== 'string' || !attemptId) fail('invalid_request', 'A durable Attempt id is required.');
  if (!path.isAbsolute(workspace ?? '') || !fs.existsSync(workspace) || !fs.statSync(workspace).isDirectory()) {
    fail('invalid_workspace', 'Durable CLI workspace must be an existing absolute directory.');
  }
  if (!path.isAbsolute(taskDirectory ?? '') || !fs.existsSync(taskDirectory) || !fs.statSync(taskDirectory).isDirectory()) {
    fail('invalid_workspace', 'Durable CLI task directory must be an existing absolute directory.');
  }
  if (!Array.isArray(driver.args) || driver.args.some(argument => typeof argument !== 'string')) {
    fail('invalid_request', 'Durable CLI driver args must contain only strings.');
  }
  const executablePath = installation?.canonical_path ?? driver.command;
  if (typeof executablePath !== 'string' || !absolutePath(executablePath)) {
    fail('invalid_cli_path', 'Durable CLI execution requires an absolute verified executable path.');
  }
  if (!fs.existsSync(executablePath) || !fs.statSync(executablePath).isFile()) {
    fail('invalid_cli_path', 'Durable CLI verified executable path must exist and be a file.');
  }
  if (typeof driver.command !== 'string' || !sameExecutable(driver.command, executablePath)) {
    fail('invalid_cli_path', 'Durable CLI driver command must match the verified executable path.');
  }
  const relativeDirectory = `native/${attemptId}`;
  const stdoutRelpath = `${relativeDirectory}/stdout.log`;
  const stderrRelpath = `${relativeDirectory}/stderr.log`;
  const exitRelpath = `${relativeDirectory}/exit.json`;
  const nativeDirectory = taskRelativePath(taskDirectory, relativeDirectory);
  const stdoutPath = taskRelativePath(taskDirectory, stdoutRelpath);
  const stderrPath = taskRelativePath(taskDirectory, stderrRelpath);
  const exitPath = taskRelativePath(taskDirectory, exitRelpath);
  const workspaceKey = canonicalWorkspace(workspace);
  const executableSha256 = typeof installation?.sha256 === 'string' ? installation.sha256 : null;
  const launchFingerprint = nativeLaunchFingerprint({
    target: request.target,
    attemptId,
    workspaceKey,
    executablePath,
    executableSha256,
    argv: driver.args,
    coreVersion,
    adapterVersion,
  });
  const prompt = typeof driver.buildPrompt === 'function'
    ? driver.buildPrompt(request, workspace)
    : request.prompt;
  if (typeof prompt !== 'string') fail('invalid_request', 'Durable CLI prompt must be a string.');

  return {
    driver,
    request,
    workspace: path.resolve(workspace),
    taskDirectory: path.resolve(taskDirectory),
    attemptId,
    executablePath,
    executableSha256,
    workspaceKey,
    launchFingerprint,
    nativeDirectory,
    stdoutPath,
    stderrPath,
    exitPath,
    stdoutRelpath,
    stderrRelpath,
    exitRelpath,
    prompt,
  };
}

export async function launchAndAccept({
  prepared,
  control,
  checkpoint,
  inspector,
  lease = null,
  signal = null,
  spawnImpl = spawn,
  identityBudgetMs = DEFAULT_PROCESS_IDENTITY_BUDGET_MS,
  identityRetryMs = DEFAULT_PROCESS_IDENTITY_RETRY_MS,
  acceptTimeoutMs = null,
  pollIntervalMs = DEFAULT_ACCEPT_POLL_MS,
  publishPatch = null,
  timeoutGuardianLauncher = launchExecutionTimeoutGuardian,
  now = Date.now,
} = {}) {
  requirePrepared(prepared);
  if (!control) fail('invalid_request', 'Durable CLI launch requires the control database.');
  if (typeof checkpoint !== 'function') fail('invalid_request', 'Durable CLI launch requires checkpoint().');
  if (!inspector || typeof inspector.inspectProcess !== 'function' || typeof inspector.inspectProcessTree !== 'function') {
    fail('invalid_request', 'Durable CLI launch requires a process inspector.');
  }
  if (getNativeProcess(control, prepared.attemptId)) {
    fail('invalid_state_transition', 'This Attempt has already consumed its durable CLI launch slot.', {
      category: 'conflict', submission: 'not_sent',
    });
  }

  const descriptors = createTranscriptFiles(prepared);
  let provisionalCreated = false;
  let child;
  try {
    createProvisionalProcess(control, {
      attemptId: prepared.attemptId,
      target: prepared.request.target,
      workspaceKey: prepared.workspaceKey,
      executablePath: prepared.executablePath,
      executableSha256: prepared.executableSha256,
      launchFingerprint: prepared.launchFingerprint,
      stdoutRelpath: prepared.stdoutRelpath,
      stderrRelpath: prepared.stderrRelpath,
    }, { lease, now: now() });
    provisionalCreated = true;

    try {
      child = spawnImpl(prepared.driver.command, prepared.driver.args, {
        cwd: prepared.workspace,
        windowsHide: true,
        shell: false,
        // Durable native execution must outlive the short-lived observer.
        // A separate process group/session plus file-backed output prevents a
        // Worker exit from implicitly becoming native-process cancellation.
        detached: true,
        env: prepared.driver.env ?? process.env,
        stdio: ['pipe', descriptors.stdout, descriptors.stderr],
      });
    } catch (error) {
      finalizeNoChild(control, prepared, { lease, now: now() });
      throw durableError('launch_failed', 'The durable native process could not be started.', 'not_sent', error);
    }
  } finally {
    closeDescriptor(descriptors.stdout);
    closeDescriptor(descriptors.stderr);
  }

  const closeTracker = trackChildClose(child, { control, prepared, inspector, lease, now });
  try {
    await waitForSpawn(child, closeTracker);
    const identity = await inspectSpawnIdentity({
      child,
      closeTracker,
      inspector,
      executablePath: prepared.executablePath,
      budgetMs: identityBudgetMs,
      retryMs: identityRetryMs,
      signal,
    });
    bindProcessIdentity(control, prepared.attemptId, {
      pid: child.pid,
      startedAtMs: identity.started_at_ms,
      executablePath: identity.executable_path,
    }, { lease, now: now() });
  } catch (error) {
    if (provisionalCreated) {
      await terminatePreSendChild(child, closeTracker, { control, prepared, inspector, lease, now });
    }
    if (error instanceof UAgentsError) throw error;
    throw durableError(error?.code ?? 'native_process_identity_mismatch', 'Durable native process identity could not be verified.', 'not_sent', error);
  }

  if (prepared.request.execution_timeout_ms !== null && prepared.request.execution_timeout_ms !== undefined) {
    try {
      await timeoutGuardianLauncher({
        control,
        attemptId: prepared.attemptId,
        executionTimeoutMs: prepared.request.execution_timeout_ms,
      });
    } catch (error) {
      if (!closeTracker.closed) await terminatePreSendChild(child, closeTracker, { control, prepared, inspector, lease, now });
      throw error;
    }
  }

  try {
    await checkpoint('possibly_sent');
  } catch (error) {
    if (!closeTracker.closed) await terminatePreSendChild(child, closeTracker, { control, prepared, inspector, lease, now });
    throw error;
  }

  let stdinError = null;
  child.stdin?.once?.('error', error => { stdinError = error; });
  try {
    child.stdin.end(prepared.prompt);
    child.unref?.();
  } catch (error) {
    throw durableError('submission_unknown', 'The durable prompt write failed after the send checkpoint.', 'may_have_been_sent', error);
  }

  const parserSession = createParserSession({
    driver: prepared.driver,
    target: prepared.request.target,
    checkpoint,
    publishPatch,
  });
  const record = getNativeProcess(control, prepared.attemptId);
  const stdoutReader = new IncrementalUtf8LineReader(prepared.stdoutPath, {
    maxBytes: DURABLE_STDOUT_LIMIT_BYTES,
    stream: 'stdout',
  });
  let stderrCursor = Number(record?.stderr_cursor_bytes ?? 0);
  const startedAt = Date.now();
  const acceptBudget = acceptTimeoutMs ?? Math.max(5_000, Number(prepared.request.timeout_ms ?? 0) || 0);

  for (;;) {
    try {
      await stdoutReader.readAvailable(async (line, endOffset) => {
        await parserSession.line(line);
        updateTranscriptCursor(control, prepared.attemptId, { stdoutBytes: endOffset }, { lease, now: now() });
      });
      stderrCursor = await observeStderr({
        file: prepared.stderrPath,
        parserSession,
        cursor: stderrCursor,
        control,
        attemptId: prepared.attemptId,
        lease,
        now,
      });
    } catch (error) {
      if (error?.code === 'output_limit') {
        try { markProcessUnknown(control, prepared.attemptId, { lease, now: now() }); } catch {}
      }
      throw strengthenSubmission(error, control, prepared.attemptId);
    }

    const timeoutEvidence = executionTimeoutEvidence(control, prepared.attemptId);
    if (timeoutEvidence) {
      throw durableError(timeoutEvidence.termination_confirmed === true
        ? 'execution_timeout' : 'execution_timeout_termination_unconfirmed',
      timeoutEvidence.termination_confirmed === true
        ? 'The durable native execution exceeded its execution deadline and its owned process tree was terminated.'
        : 'The durable native execution exceeded its execution deadline but owned process-tree termination could not be confirmed.',
      currentSubmission(control, prepared.attemptId));
    }
    const timeoutPending = executionTimeoutPending(control, prepared.attemptId);
    if (timeoutPending) {
      if (Date.now() - Number(timeoutPending.created_at_ms) >= EXECUTION_TIMEOUT_SETTLE_MS) {
        throw durableError('execution_timeout_termination_unconfirmed',
          'The execution deadline was reached but timeout termination evidence did not settle.',
          currentSubmission(control, prepared.attemptId));
      }
      await delay(Math.max(1, pollIntervalMs));
      continue;
    }

    if (parserSession.handle) {
      return {
        handle: {
          attempt_id: prepared.attemptId,
          session_id: parserSession.handle.session_id,
          task_id: parserSession.handle.task_id,
          status: parserSession.handle.status,
        },
        process: getNativeProcess(control, prepared.attemptId),
        closePromise: closeTracker.promise,
      };
    }

    if (closeTracker.closed) {
      // One final pass catches complete bytes written immediately before close.
      await stdoutReader.readAvailable(async (line, endOffset) => {
        await parserSession.line(line);
        updateTranscriptCursor(control, prepared.attemptId, { stdoutBytes: endOffset }, { lease, now: now() });
      });
      if (parserSession.handle) continue;
      throw durableError('native_acceptance_unconfirmed', 'Native process exited before a durable native identity was observed.', 'may_have_been_sent');
    }
    if (stdinError) {
      throw durableError('submission_unknown', 'Native stdin failed after the send checkpoint.', 'may_have_been_sent', stdinError);
    }
    if (signal?.aborted) {
      throw durableError('submission_unknown', 'Durable native acceptance observation was interrupted after send.', 'may_have_been_sent');
    }
    if (Date.now() - startedAt >= acceptBudget) {
      throw durableError('native_acceptance_unconfirmed', 'Durable native identity was not observed within the acceptance window.', 'may_have_been_sent');
    }
    await delay(Math.max(1, pollIntervalMs), undefined, signal ? { signal } : undefined).catch(() => {});
  }
}

export async function replayDurableExecution({
  control,
  taskDirectory,
  attemptId,
  driver,
  checkpoint,
  lease = null,
  publishPatch = null,
  now = Date.now,
} = {}) {
  if (!control || !driver || typeof checkpoint !== 'function') fail('invalid_request', 'Durable replay requires control, driver and checkpoint.');
  const record = getNativeProcess(control, attemptId);
  if (!record) fail('task_not_found', `No durable native process is recorded for Attempt ${attemptId}.`);
  const stdoutPath = taskRelativePath(taskDirectory, record.stdout_relpath);
  const stderrPath = taskRelativePath(taskDirectory, record.stderr_relpath);
  const parserSession = createParserSession({ driver, target: record.target, checkpoint, publishPatch });
  const stdoutReader = new IncrementalUtf8LineReader(stdoutPath, {
    maxBytes: DURABLE_STDOUT_LIMIT_BYTES,
    stream: 'stdout',
  });
  let persistedStdout = Number(record.stdout_cursor_bytes);
  let stderrCursor = Number(record.stderr_cursor_bytes);
  try {
    await stdoutReader.readAvailable(async (line, endOffset) => {
      await parserSession.line(line);
      if (endOffset > persistedStdout) {
        updateTranscriptCursor(control, attemptId, { stdoutBytes: endOffset }, { lease, now: now() });
        persistedStdout = endOffset;
      }
    });
    stderrCursor = await observeStderr({
      file: stderrPath,
      parserSession,
      cursor: stderrCursor,
      control,
      attemptId,
      lease,
      now,
      replayFromZero: true,
    });
  } catch (error) {
    throw strengthenSubmission(error, control, attemptId);
  }

  const refreshed = getNativeProcess(control, attemptId);
  let outcome = null;
  if (refreshed?.process_state === 'exited') {
    outcome = await parserSession.finish(refreshed.exit_code);
  }
  return {
    handle: parserSession.handle,
    outcome,
    timeout_evidence: executionTimeoutEvidence(control, attemptId),
    process: getNativeProcess(control, attemptId),
    stdout_cursor_bytes: stdoutReader.committedOffset,
    stderr_cursor_bytes: stderrCursor,
  };
}

export async function observeDurableExecution({
  control,
  taskDirectory,
  attemptId,
  driver,
  checkpoint,
  inspector = null,
  lease = null,
  signal = null,
  publishPatch = null,
  observationTimeoutMs = 1_000,
  pollIntervalMs = DEFAULT_ACCEPT_POLL_MS,
  processPollMs = 250,
  now = Date.now,
} = {}) {
  if (!control || !driver || typeof checkpoint !== 'function') fail('invalid_request', 'Durable observation requires control, driver and checkpoint.');
  let record = getNativeProcess(control, attemptId);
  if (!record) fail('task_not_found', `No durable native process is recorded for Attempt ${attemptId}.`);
  const stdoutPath = taskRelativePath(taskDirectory, record.stdout_relpath);
  const stderrPath = taskRelativePath(taskDirectory, record.stderr_relpath);
  const parserSession = createParserSession({ driver, target: record.target, checkpoint, publishPatch });
  const reader = new IncrementalUtf8LineReader(stdoutPath, {
    maxBytes: DURABLE_STDOUT_LIMIT_BYTES,
    stream: 'stdout',
  });
  let persistedStdout = Number(record.stdout_cursor_bytes);
  let stderrCursor = Number(record.stderr_cursor_bytes);
  const startedAt = Date.now();
  let lastProcessPoll = 0;

  for (;;) {
    try {
      await reader.readAvailable(async (line, endOffset) => {
        await parserSession.line(line);
        if (endOffset > persistedStdout) {
          updateTranscriptCursor(control, attemptId, { stdoutBytes: endOffset }, { lease, now: now() });
          persistedStdout = endOffset;
        }
      });
      stderrCursor = await observeStderr({
        file: stderrPath, parserSession, cursor: stderrCursor, control, attemptId, lease, now,
      });
    } catch (error) {
      if (error?.code === 'output_limit') {
        try { markProcessUnknown(control, attemptId, { lease, now: now() }); } catch {}
      }
      throw strengthenSubmission(error, control, attemptId);
    }

    const timeoutEvidence = executionTimeoutEvidence(control, attemptId);
    if (timeoutEvidence) {
      return {
        handle: parserSession.handle,
        outcome: null,
        process: getNativeProcess(control, attemptId),
        observation_complete: true,
        timed_out: false,
        execution_timed_out: true,
        termination_confirmed: timeoutEvidence.termination_confirmed === true,
      };
    }
    const timeoutPending = executionTimeoutPending(control, attemptId);
    if (timeoutPending) {
      if (Date.now() - Number(timeoutPending.created_at_ms) >= EXECUTION_TIMEOUT_SETTLE_MS) {
        return {
          handle: parserSession.handle,
          outcome: null,
          process: getNativeProcess(control, attemptId),
          observation_complete: true,
          timed_out: false,
          execution_timed_out: true,
          termination_confirmed: false,
        };
      }
      if (signal?.aborted) {
        return { handle: parserSession.handle, outcome: null, process: record, observation_complete: false, timed_out: false, aborted: true };
      }
      await delay(Math.max(1, pollIntervalMs), undefined, signal ? { signal } : undefined).catch(() => {});
      continue;
    }

    record = getNativeProcess(control, attemptId);
    if (record?.process_state === 'exited') {
      // The close/inspection path may race the last file write. One final read
      // after exited evidence ensures complete newline-delimited tail bytes are
      // included before parser.finish().
      await reader.readAvailable(async (line, endOffset) => {
        await parserSession.line(line);
        if (endOffset > persistedStdout) {
          updateTranscriptCursor(control, attemptId, { stdoutBytes: endOffset }, { lease, now: now() });
          persistedStdout = endOffset;
        }
      });
      const outcome = await parserSession.finish(record.exit_code);
      return {
        handle: parserSession.handle,
        outcome,
        process: getNativeProcess(control, attemptId),
        observation_complete: true,
        timed_out: false,
      };
    }

    const elapsed = Date.now() - startedAt;
    if (inspector && elapsed - lastProcessPoll >= processPollMs) {
      lastProcessPoll = elapsed;
      try {
        await refreshWorkspaceExecutionGuard(control, attemptId, { inspector, now: now() });
      } catch {}
      record = getNativeProcess(control, attemptId);
      if (record?.process_state === 'exited') continue;
    }
    if (signal?.aborted) {
      return { handle: parserSession.handle, outcome: null, process: record, observation_complete: false, timed_out: false, aborted: true };
    }
    if (elapsed >= Math.max(0, Number(observationTimeoutMs) || 0)) {
      return { handle: parserSession.handle, outcome: null, process: record, observation_complete: false, timed_out: true };
    }
    await delay(Math.max(1, pollIntervalMs), undefined, signal ? { signal } : undefined).catch(() => {});
  }
}

export class IncrementalUtf8LineReader {
  constructor(file, { startOffset = 0, maxBytes = DURABLE_STDOUT_LIMIT_BYTES, stream = 'stdout', chunkBytes = 4096 } = {}) {
    this.file = file;
    this.readOffset = startOffset;
    this.committedOffset = startOffset;
    this.pendingStartOffset = startOffset;
    this.pending = Buffer.alloc(0);
    this.maxBytes = maxBytes;
    this.stream = stream;
    this.chunkBytes = chunkBytes;
  }

  async readAvailable(onLine) {
    const stat = fs.statSync(this.file);
    if (stat.size > this.maxBytes) throw outputLimit(this.stream, this.maxBytes, stat.size);
    if (stat.size < this.readOffset) {
      fail('transcript_changed', 'Durable transcript shrank while it was being observed.', {
        category: 'runtime', submission: 'may_have_been_sent', details: { stream: this.stream },
      });
    }
    await this.#drainCompleteLines(onLine);
    if (stat.size === this.readOffset) return this.committedOffset;
    const descriptor = fs.openSync(this.file, 'r');
    try {
      while (this.readOffset < stat.size) {
        const length = Math.min(this.chunkBytes, stat.size - this.readOffset);
        const chunk = Buffer.allocUnsafe(length);
        const bytesRead = fs.readSync(descriptor, chunk, 0, length, this.readOffset);
        if (bytesRead <= 0) break;
        this.readOffset += bytesRead;
        this.pending = this.pending.length
          ? Buffer.concat([this.pending, chunk.subarray(0, bytesRead)])
          : Buffer.from(chunk.subarray(0, bytesRead));
        await this.#drainCompleteLines(onLine);
      }
    } finally {
      fs.closeSync(descriptor);
    }
    return this.committedOffset;
  }

  async #drainCompleteLines(onLine) {
    for (;;) {
      const newline = this.pending.indexOf(0x0a);
      if (newline < 0) return;
      const rawLine = this.pending.subarray(0, newline);
      const decoder = new StringDecoder('utf8');
      const line = decoder.write(rawLine) + decoder.end();
      const endOffset = this.pendingStartOffset + newline + 1;
      await onLine(line.endsWith('\r') ? line.slice(0, -1) : line, endOffset);
      this.pending = Buffer.from(this.pending.subarray(newline + 1));
      this.pendingStartOffset = endOffset;
      this.committedOffset = endOffset;
    }
  }
}

function createParserSession({ driver, target, checkpoint, publishPatch }) {
  const pendingPatches = [];
  let handle = null;
  const publish = patch => {
    if (patch && typeof patch === 'object') pendingPatches.push(patch);
  };
  const parser = typeof driver.createParser === 'function'
    ? driver.createParser(publish)
    : null;
  if (!parser) fail('invalid_request', 'Durable CLI driver must provide createParser().');

  async function flush() {
    while (pendingPatches.length) {
      const patch = pendingPatches.shift();
      if (patch.native_session_id !== undefined && patch.native_session_id !== null) {
        const next = {
          session_id: patch.native_session_id,
          task_id: patch.native_task_id ?? null,
          status: patch.native_status ?? 'accepted',
        };
        await checkpoint('accepted', {
          handle: next,
          evidence_ref: driver.evidenceRef ?? `${target}:native-session`,
        });
        handle = next;
      }
      if (typeof publishPatch === 'function') await publishPatch(patch);
    }
  }

  return {
    get handle() { return handle; },
    async line(line) {
      if (!line.trim()) return;
      if (typeof parser.line === 'function') parser.line(line);
      else if (typeof parser.event === 'function') {
        let event;
        try { event = typeof driver.decodeLine === 'function' ? driver.decodeLine(line) : JSON.parse(line); }
        catch (error) { throw durableError('malformed_stream', 'Durable native stdout contained an invalid event line.', 'may_have_been_sent', error); }
        parser.event(event);
      } else fail('invalid_request', 'Durable CLI parser must expose line() or event().');
      await flush();
    },
    async stderr(text) {
      if (typeof parser.stderr === 'function') parser.stderr(text);
      await flush();
    },
    async finish(code) {
      const result = typeof parser.finish === 'function' ? parser.finish(code) : null;
      await flush();
      return result;
    },
  };
}

async function observeStderr({ file, parserSession, cursor, control, attemptId, lease, now, replayFromZero = false }) {
  const stat = fs.statSync(file);
  if (stat.size > DURABLE_STDERR_LIMIT_BYTES) throw outputLimit('stderr', DURABLE_STDERR_LIMIT_BYTES, stat.size);
  if (stat.size === 0) return cursor;
  if (!replayFromZero && stat.size <= cursor) return cursor;
  const text = fs.readFileSync(file, 'utf8');
  const visible = text.slice(-DURABLE_STDERR_PARSER_WINDOW_CHARS);
  await parserSession.stderr(visible);
  if (stat.size > cursor) {
    updateTranscriptCursor(control, attemptId, { stderrBytes: stat.size }, { lease, now: now() });
    return stat.size;
  }
  return cursor;
}

function createTranscriptFiles(prepared) {
  fs.mkdirSync(prepared.nativeDirectory, { recursive: true, mode: 0o700 });
  const realTask = fs.realpathSync(prepared.taskDirectory);
  const realNative = fs.realpathSync(prepared.nativeDirectory);
  const relativeNative = path.relative(realTask, realNative);
  if (relativeNative === '..' || relativeNative.startsWith(`..${path.sep}`) || path.isAbsolute(relativeNative)) {
    fail('unsafe_task_path', 'Durable transcript directory resolves outside the task directory.');
  }
  let stdout;
  let stderr;
  try {
    stdout = fs.openSync(prepared.stdoutPath, 'wx', 0o600);
    stderr = fs.openSync(prepared.stderrPath, 'wx', 0o600);
    return { stdout, stderr };
  } catch (error) {
    closeDescriptor(stdout);
    closeDescriptor(stderr);
    throw error;
  }
}

function trackChildClose(child, { control, prepared, inspector, lease, now }) {
  const tracker = { closed: false, code: null, signal: null, promise: null };
  tracker.promise = new Promise(resolve => {
    child.once('close', (code, signal) => {
      tracker.closed = true;
      tracker.code = Number.isInteger(code) ? code : null;
      tracker.signal = typeof signal === 'string' ? signal : null;
      let timeoutPending = false;
      try {
        atomicWriteJson(prepared.exitPath, {
          exit_code: tracker.code,
          signal: tracker.signal,
          observed_at_ms: now(),
        });
        timeoutPending = Boolean(executionTimeoutPending(control, prepared.attemptId));
        if (!timeoutPending) {
          markProcessExited(control, prepared.attemptId, { exitCode: tracker.code, exitedAtMs: now() }, { lease, now: now() });
        }
      } catch {}
      let refresh = Promise.resolve();
      if (!timeoutPending) {
        try {
          refresh = Promise.resolve(refreshWorkspaceExecutionGuard(control, prepared.attemptId, { inspector, now: now() }));
        } catch {}
      }
      refresh
        .catch(() => {})
        .finally(() => resolve({ code: tracker.code, signal: tracker.signal }));
    });
  });
  return tracker;
}

async function waitForSpawn(child, closeTracker) {
  if (!child) throw durableError('launch_failed', 'Durable native process was not created.', 'not_sent');
  await Promise.race([
    new Promise((resolve, reject) => {
      child.once?.('spawn', resolve);
      child.once?.('error', error => reject(durableError('launch_failed', 'Durable native process failed to spawn.', 'not_sent', error)));
    }),
    closeTracker.promise,
  ]);
  if (closeTracker.closed) throw durableError('launch_failed', 'Durable native process exited before identity verification.', 'not_sent');
  if (!Number.isSafeInteger(child?.pid) || child.pid <= 0) throw durableError('launch_failed', 'Durable native process has no valid PID.', 'not_sent');
}

async function inspectSpawnIdentity({ child, closeTracker, inspector, executablePath, budgetMs, retryMs, signal }) {
  const deadline = Date.now() + Math.max(1, Number(budgetMs) || DEFAULT_PROCESS_IDENTITY_BUDGET_MS);
  let lastCode = 'native_process_inspection_failed';
  for (;;) {
    if (closeTracker.closed) throw durableError('launch_failed', 'Durable native process exited before its identity was verified.', 'not_sent');
    if (signal?.aborted) throw durableError('native_process_inspection_failed', 'Process identity verification was interrupted.', 'not_sent');
    const inspection = await inspector.inspectProcess({ pid: child.pid });
    if (inspection?.kind === 'alive') {
      if (Number(inspection.pid) !== child.pid) {
        throw durableError('native_process_identity_mismatch', 'Observed native PID does not match the spawned child PID.', 'not_sent');
      }
      if (!sameExecutable(inspection.executable_path, executablePath)) {
        throw durableError('native_process_identity_mismatch', 'Observed native executable does not match the verified launch executable.', 'not_sent');
      }
      if (!Number.isSafeInteger(Number(inspection.started_at_ms)) || Number(inspection.started_at_ms) <= 0) {
        lastCode = 'native_process_inspection_failed';
      } else return inspection;
    } else if (inspection?.kind === 'absent') {
      lastCode = 'launch_failed';
    } else {
      lastCode = inspection?.code ?? 'native_process_inspection_failed';
    }
    if (Date.now() >= deadline) {
      throw durableError(lastCode === 'launch_failed' ? 'launch_failed' : 'native_process_inspection_failed', 'Native process identity could not be proven before prompt submission.', 'not_sent');
    }
    await delay(Math.max(1, Number(retryMs) || DEFAULT_PROCESS_IDENTITY_RETRY_MS));
  }
}

async function terminatePreSendChild(child, closeTracker, { control, prepared, inspector, lease, now }) {
  try { child.stdin?.destroy?.(); } catch {}
  try { child.kill(); } catch {}
  await Promise.race([closeTracker.promise, delay(2_000)]);
  if (!closeTracker.closed) {
    try { markProcessUnknown(control, prepared.attemptId, { lease, now: now() }); } catch {}
    return false;
  }
  // The ChildProcess handle proves which just-created root we terminated.
  // This path is used both before identity binding and after identity binding
  // when a required pre-send control-plane primitive (such as the timeout
  // guardian) cannot start. Release is still allowed only after descendant
  // enumeration proves that root tree quiescent.
  try {
    const tree = await inspector.inspectProcessTree({ rootPid: child.pid, rootStartedAtMs: null });
    if (tree?.kind === 'quiescent') {
      markProcessExited(control, prepared.attemptId, { exitCode: closeTracker.code, exitedAtMs: now() }, { lease, now: now() });
      releaseWorkspaceGuard(control, prepared.attemptId, { lease, quiescenceProven: true, now: now() + 1 });
      return true;
    }
    markProcessUnknown(control, prepared.attemptId, { lease, now: now() });
  } catch {}
  return true;
}

function finalizeNoChild(control, prepared, { lease, now }) {
  try {
    markProcessExited(control, prepared.attemptId, { exitCode: null, exitedAtMs: now }, { lease, now });
    releaseWorkspaceGuard(control, prepared.attemptId, { lease, quiescenceProven: true, now: now + 1 });
    atomicWriteJson(prepared.exitPath, { exit_code: null, signal: null, observed_at_ms: now, spawn_failed: true });
  } catch {}
}

function outputLimit(stream, limit, observed) {
  return new UAgentsError('output_limit', `Durable ${stream} transcript exceeded its safety limit.`, {
    category: 'runtime', retryable: false, submission: 'may_have_been_sent',
    details: { stream, limit_bytes: limit, observed_bytes: observed, truncated: true },
  });
}

function durableError(code, message, submission, cause = null) {
  return new UAgentsError(code, message, {
    category: code.includes('identity') ? 'transport' : 'runtime',
    retryable: false,
    submission,
    ...(cause ? { cause } : {}),
  });
}

function currentSubmission(control, attemptId) {
  try {
    return control.raw.prepare('SELECT submission FROM attempts WHERE attempt_id = ?').get(attemptId)?.submission ?? 'may_have_been_sent';
  } catch {
    return 'may_have_been_sent';
  }
}

function strengthenSubmission(error, control, attemptId) {
  if (!error || typeof error !== 'object') return error;
  const persisted = currentSubmission(control, attemptId);
  const rank = { not_sent: 0, may_have_been_sent: 1, sent: 2 };
  const current = typeof error.submission === 'string' ? error.submission : 'not_sent';
  if ((rank[persisted] ?? 0) > (rank[current] ?? 0)) error.submission = persisted;
  return error;
}

function requirePrepared(prepared) {
  if (!prepared || typeof prepared !== 'object' || typeof prepared.attemptId !== 'string' ||
      typeof prepared.stdoutPath !== 'string' || typeof prepared.stderrPath !== 'string') {
    fail('invalid_request', 'Invalid prepared durable CLI execution.');
  }
}

function taskRelativePath(taskDirectory, relative) {
  if (!path.isAbsolute(taskDirectory ?? '')) fail('invalid_workspace', 'Task directory must be absolute.');
  if (typeof relative !== 'string' || !relative || path.isAbsolute(relative) || path.win32.isAbsolute(relative) || path.posix.isAbsolute(relative)) {
    fail('invalid_request', 'Durable transcript path must be task-relative.');
  }
  const normalized = path.posix.normalize(relative.replaceAll('\\', '/'));
  if (normalized === '..' || normalized.startsWith('../') || normalized.includes('/../')) {
    fail('invalid_request', 'Durable transcript path escapes the task directory.');
  }
  const candidate = path.resolve(taskDirectory, ...normalized.split('/'));
  const relativeToTask = path.relative(path.resolve(taskDirectory), candidate);
  if (relativeToTask === '..' || relativeToTask.startsWith(`..${path.sep}`) || path.isAbsolute(relativeToTask)) {
    fail('invalid_request', 'Durable transcript path escapes the task directory.');
  }
  return candidate;
}

function sameExecutable(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string') return false;
  const a = path.normalize(path.resolve(left));
  const b = path.normalize(path.resolve(right));
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function absolutePath(value) {
  return path.isAbsolute(value) || path.win32.isAbsolute(value) || path.posix.isAbsolute(value);
}

function closeDescriptor(descriptor) {
  if (Number.isInteger(descriptor)) {
    try { fs.closeSync(descriptor); } catch {}
  }
}
