import { spawnSync } from 'node:child_process';
import { parseCouncilValidation } from '../protocol/council-validation-schema.mjs';

export const COUNCIL_VALIDATION_OUTPUT_BYTES = 64 * 1024;
const SPAWN_BUFFER_BYTES = 4 * 1024 * 1024;

export function runCouncilValidation(member, input, { clock = () => Date.now(), env = process.env } = {}) {
  const validation = parseCouncilValidation(input);
  if (validation.command) return runSingle(member.worktree.workspace, validation, { clock, env });

  const startedAt = clock();
  const checks = [];
  let stopped = false;
  for (const check of validation.checks) {
    if (stopped) {
      checks.push(skippedCheck(check));
      continue;
    }
    const evidence = runSingle(member.worktree.workspace, check, { clock, env });
    checks.push({ name: check.name, ...evidence });
    if (validation.on_failure === 'stop' && evidence.outcome !== 'passed') stopped = true;
  }
  const finishedAt = clock();
  return {
    schema_version: validation.schema_version,
    timeout_ms: validation.timeout_ms,
    on_failure: validation.on_failure,
    started_at_ms: startedAt,
    finished_at_ms: finishedAt,
    duration_ms: Math.max(0, finishedAt - startedAt),
    outcome: aggregateOutcome(checks),
    checks,
  };
}

function runSingle(workspace, validation, { clock, env }) {
  const startedAt = clock();
  const result = spawnSync(validation.command[0], validation.command.slice(1), {
    cwd: workspace,
    env,
    encoding: null,
    windowsHide: true,
    shell: false,
    timeout: validation.timeout_ms,
    maxBuffer: SPAWN_BUFFER_BYTES,
  });
  const finishedAt = clock();
  const errorCode = typeof result.error?.code === 'string' ? result.error.code : null;
  const outputLimitExceeded = errorCode === 'ENOBUFS';
  const timedOut = errorCode === 'ETIMEDOUT';
  return {
    ...(validation.schema_version ? { schema_version: validation.schema_version } : {}),
    command: validation.command,
    timeout_ms: validation.timeout_ms,
    started_at_ms: startedAt,
    finished_at_ms: finishedAt,
    duration_ms: Math.max(0, finishedAt - startedAt),
    outcome: timedOut ? 'timeout' : result.error ? 'error' : result.status === 0 ? 'passed' : 'failed',
    exit_code: Number.isInteger(result.status) ? result.status : null,
    signal: result.signal ?? null,
    error_code: errorCode,
    output_limit_exceeded: outputLimitExceeded,
    stdout: boundedOutput(result.stdout, outputLimitExceeded),
    stderr: boundedOutput(result.stderr, outputLimitExceeded),
  };
}

function skippedCheck(check) {
  return {
    name: check.name,
    command: check.command,
    timeout_ms: check.timeout_ms,
    started_at_ms: null,
    finished_at_ms: null,
    duration_ms: 0,
    outcome: 'skipped',
    exit_code: null,
    signal: null,
    error_code: null,
    output_limit_exceeded: false,
    stdout: boundedOutput(null, false),
    stderr: boundedOutput(null, false),
  };
}

function aggregateOutcome(checks) {
  if (checks.some(check => check.outcome === 'error')) return 'error';
  if (checks.some(check => check.outcome === 'timeout')) return 'timeout';
  if (checks.some(check => check.outcome === 'failed')) return 'failed';
  return 'passed';
}

function boundedOutput(value, forcedTruncation) {
  const body = Buffer.isBuffer(value) ? value : Buffer.from(value ?? '');
  const truncated = forcedTruncation || body.length > COUNCIL_VALIDATION_OUTPUT_BYTES;
  const visible = truncated ? body.subarray(0, COUNCIL_VALIDATION_OUTPUT_BYTES) : body;
  return {
    text: visible.toString('utf8'),
    captured_bytes: body.length,
    truncated,
  };
}
