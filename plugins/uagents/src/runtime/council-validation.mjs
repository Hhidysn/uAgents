import { spawnSync } from 'node:child_process';
import { parseCouncilValidation } from '../protocol/council-validation-schema.mjs';

export const COUNCIL_VALIDATION_OUTPUT_BYTES = 64 * 1024;
const SPAWN_BUFFER_BYTES = 4 * 1024 * 1024;

export function runCouncilValidation(member, input, { clock = () => Date.now(), env = process.env } = {}) {
  const validation = parseCouncilValidation(input);
  const startedAt = clock();
  const result = spawnSync(validation.command[0], validation.command.slice(1), {
    cwd: member.worktree.workspace,
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
    schema_version: validation.schema_version,
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
