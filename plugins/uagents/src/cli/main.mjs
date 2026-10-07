import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { parseArgs } from 'node:util';
import { StringDecoder } from 'node:string_decoder';
import { notOk, ok } from '../protocol/envelope.mjs';
import { fail } from '../protocol/errors.mjs';
import { targetDescriptor } from '../registry/registry.mjs';
import { loadRegistry } from '../registry/config-file.mjs';
import { CLI_PARSE_OPTIONS, describeCli, isKnownCliCommand } from './discovery.mjs';
import { DEFAULT_OBSERVATION_TIMEOUT_MS, REQUEST_LIMITS } from '../protocol/schema.mjs';
import { requestJsonSchema } from '../protocol/request-json-schema.mjs';
import { councilJsonSchema } from '../protocol/council-schema.mjs';
import { councilValidationJsonSchema } from '../protocol/council-validation-schema.mjs';
import { councilValidationProfilesJsonSchema } from '../protocol/council-validation-profiles.mjs';
import { adapterFor } from '../adapters/index.mjs';
import { discoverModelsForTarget, managedContextForModelListing } from '../runtime/model-discovery.mjs';

const RUN_TERMINAL_STATES = new Set(['succeeded', 'failed', 'cancelled', 'indeterminate']);
// Local worker failures that can never progress on their own: the worker never
// reached the target, so waiting out the full timeout would only hide the
// reason. Both codes stay recoverable through `resume`.
const RUN_STALLED_ERRORS = new Set(['worker_launch_failed', 'worker_start_failed']);
const DEFAULT_RUN_TIMEOUT_MS = 900_000;
// Extra wait granted on top of the effective observation deadline.
const RUN_WAIT_MARGIN_MS = 60_000;

export async function execute(argv, options = {}) {
  const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, strict: true, options: CLI_PARSE_OPTIONS });
  const registry = options.registry ?? loadRegistry({ configPath: values.config, env: options.env ?? process.env });
  if (values.format && !['json', 'table'].includes(values.format)) fail('invalid_request', 'format must be json or table.');
  const [command, subject, ...extra] = positionals;
  if (!command || extra.length) fail('usage', 'Invalid uagents command arguments.');
  if (!isKnownCliCommand(command)) fail('usage', `Unknown command: ${command}`);

  if (command === 'init' || command === 'checkin') {
    const { initializeCheckin, checkinScheduleStatus, disableCheckin } = await import('../checkin/scheduler.mjs');
    const { runCheckins, CHECKIN_TARGETS } = await import('../checkin/checkin.mjs');
    const env = options.env ?? process.env;
    const targets = values.target ?? CHECKIN_TARGETS.filter(target => registry.targets[target]?.enabled);
    const action = command === 'init' ? 'enable' : subject ?? 'run';
    if ((command === 'init' && subject) || !['run', 'status', 'enable', 'disable'].includes(action)) fail('usage', 'Use init or checkin run|status|enable|disable.');
    if (targets.some(target => !CHECKIN_TARGETS.includes(target) || !registry.targets[target]?.enabled)) fail('invalid_target', 'Check-in target must be enabled TRAE or WorkBuddy.');
    if ((values['check-only'] && action !== 'run') || (values.time && action !== 'enable')) fail('usage', '--check-only applies to run; --time applies to enable.');
    const injected = options.checkinOptions ?? {};
    if (action === 'run') return ok(await runCheckins({ ...injected, env, targets, checkOnly: values['check-only'] === true }));
    if (action === 'status') return ok(await checkinScheduleStatus({ ...injected, env }));
    if (action === 'disable') return ok(await disableCheckin({ ...injected, env }));
    return ok(await initializeCheckin({ ...injected, env, targets, time: values.time ?? null, explicit: command !== 'init' }));
  }

  if (command === 'targets') return ok(Object.entries(registry.targets).filter(([, value]) => value.enabled).map(([id]) => id));
  if (command === 'capabilities') return ok({ target: subject, ...targetDescriptor(registry, required(subject, 'target')) });
  if (command === 'models') {
    const target = required(subject, 'target'); targetDescriptor(registry, target);
    const ownsSupervisor = !('supervisor' in options);
    const supervisor = ownsSupervisor ? await createSupervisor() : options.supervisor;
    try {
      return ok(await discoverModelsForTarget(target, {
        registry,
        adapterFactory: options.adapterFactory ?? adapterFor,
        refresh: values.refresh === true,
        cacheStore: supervisor?.hostStore ?? null,
        resolveInstallation: supervisor?.resolveInstallation ?? null,
        acquireManagedContext: managedContextForModelListing(target, supervisor),
        releaseManagedContext: supervisor?.releaseInstanceLease ?? null,
      }));
    } finally {
      if (ownsSupervisor) supervisor?.hostStore?.close?.();
    }
  }
  if (command === 'describe') {
    if (values.format === 'table') fail('usage', 'describe is machine-readable JSON only.');
    return ok(describeCli(subject ?? null));
  }
  if (command === 'schema') {
    if (values.format === 'table') fail('usage', 'schema is machine-readable JSON only.');
    if (subject === 'request') return ok(requestJsonSchema());
    if (subject === 'council') return ok(councilJsonSchema());
    if (subject === 'council-validation') return ok(councilValidationJsonSchema());
    if (subject === 'council-validation-profiles') return ok(councilValidationProfilesJsonSchema());
    fail('usage', 'schema requires subject request, council, council-validation, or council-validation-profiles.');
  }
  if (command === 'config' && subject === 'validate') {
    return ok({ valid: true, registry_version: registry.version });
  }
  if (command === 'skills') {
    const { installSkill, skillSourceRoot } = await import('./skills.mjs');
    if (subject === 'path') {
      if (values.dir || values.force || values['dry-run']) fail('usage', 'skills path takes no options.');
      return ok({ skill: 'agent-dispatch', source: skillSourceRoot() });
    }
    if (subject === 'install') {
      if (!values.dir) fail('usage', 'skills install requires --dir <absolute directory>.');
      return ok(installSkill({ targetDir: values.dir, force: values.force === true, dryRun: values['dry-run'] === true }));
    }
    fail('usage', 'Use skills install --dir <directory> or skills path.');
  }

  const { resolveStateRoot, UnifiedRuntime } = await import('../runtime/api.mjs');
  const stateRoot = resolveStateRoot(values['state-dir'], options.env ?? process.env);
  // The supervisor is constructed only for commands that need it. An explicit
  // options.supervisor key (including null) is honored verbatim so tests and
  // hosts can pin the lifecycle behavior.
  const supervisor = 'supervisor' in options
    ? options.supervisor
    : ['ensure', 'stop', 'reconcile', 'resume'].includes(command) ? await createSupervisor(stateRoot) : null;
  const runtime = new UnifiedRuntime({ stateRoot, registry, spawnWorker: options.spawnWorker, supervisor });
  try {
    if (command === 'probe') return ok(await runtime.probe(required(subject, 'target'), { model: values.model ?? 'default' }));
    if (command === 'ensure') {
      const target = required(subject, 'target'); targetDescriptor(registry, target);
      if (values.profile && (target !== 'trae' || !['personal', 'isolated'].includes(values.profile))) {
        fail('invalid_request', '--profile accepts personal or isolated for TRAE only.');
      }
      return ok(await runtime.ensure(target, { refresh: values.refresh === true, profileMode: values.profile ?? null }));
    }
    if (command === 'submit') {
      if (subject || Boolean(values.request) === Boolean(values['request-stdin'])) fail('usage', 'submit requires exactly one of --request FILE or --request-stdin.');
      const serialized = values.request
        ? fs.readFileSync(values.request, 'utf8')
        : await readStdin(options.stdin ?? process.stdin);
      const input = parseJson(serialized, 'Request');
      return ok(runtime.submit(input));
    }
    if (command === 'run') {
      const target = required(subject, 'target'); targetDescriptor(registry, target);
      const prompt = await resolveRunPrompt(values, options);
      const execution = runExecution(values);
      const timeoutMs = resolveRunWaitTimeoutMs(values['timeout-ms'], execution.observation_timeout_ms);
      if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) fail('invalid_request', '--timeout-ms must be a positive integer.');
      const workspace = path.resolve(values.workspace ?? process.cwd());
      // One explicit request per invocation: a fresh request_id every time, so a
      // convenience call can never be deduplicated into an older task.
      const submitted = runtime.submit({
        schema_version: '1.0',
        request_id: randomUUID(),
        target,
        mode: values.mode ?? 'analysis',
        workspace,
        prompt,
        ...(values.model ? { model: values.model } : {}),
        ...(Object.keys(execution).length ? { execution } : {}),
      });
      if (values['no-wait']) return ok(submitted);
      const { payload, warnings } = await waitForRun(runtime, submitted.task_id, { timeoutMs });
      return ok(payload, warnings);
    }
    if (command === 'council-submit') {
      if (subject || Boolean(values.request) === Boolean(values['request-stdin'])) fail('usage', 'council-submit requires exactly one of --request FILE or --request-stdin.');
      const serialized = values.request
        ? fs.readFileSync(values.request, 'utf8')
        : await readStdin(options.stdin ?? process.stdin);
      return ok(runtime.submitCouncil(parseJson(serialized, 'Council request')));
    }
    if (command === 'council-status') return ok(runtime.councilStatus(required(subject, 'council id')));
    if (command === 'council-result') return ok(runtime.councilResult(required(subject, 'council id')));
    if (command === 'council-diff') return ok(runtime.councilDiff(required(subject, 'council id')));
    if (command === 'council-adopt') return ok(runtime.councilAdopt(required(subject, 'council id'), {
      memberId: required(values.member, '--member'),
      workspace: required(values.workspace, '--workspace'),
    }));
    if (command === 'council-validate') {
      if (Boolean(values.member) === Boolean(values.all)) fail('usage', 'council-validate requires exactly one of --member or --all.');
      if (Boolean(values.validation) === Boolean(values.profile)) fail('usage', 'council-validate requires exactly one of --validation or --profile.');
      const validation = values.validation ? parseJson(fs.readFileSync(values.validation, 'utf8'), 'Council validation') : null;
      return ok(runtime.councilValidate(required(subject, 'council id'), {
        memberId: values.member ?? null,
        all: values.all === true,
        validation,
        profile: values.profile ?? null,
      }));
    }
    if (command === 'council-cleanup') {
      if (Boolean(values.member) === Boolean(values.all)) fail('usage', 'council-cleanup requires exactly one of --member or --all.');
      return ok(runtime.councilCleanup(required(subject, 'council id'), {
        memberId: values.member ?? null,
        all: values.all === true,
        force: values.force === true,
      }));
    }
    if (command === 'status') return ok(runtime.status(required(subject, 'task id')));
    if (command === 'result') return ok(runtime.result(required(subject, 'task id')));
    if (command === 'cancel') return ok(runtime.cancel(required(subject, 'task id')));
    if (command === 'list') return ok(runtime.listTasks({
      cursor: values.cursor ?? null,
      limit: values.limit ? Number(values.limit) : 50,
      targets: values.target ?? null,
      hasResponse: values['has-response'] === true,
    }));
    if (command === 'sessions') return ok(runtime.listSessions({
      cursor: values.cursor ?? null,
      limit: values.limit ? Number(values.limit) : 50,
      targets: values.target ?? null,
    }));
    if (command === 'reconcile') return ok(await runtime.reconcile(required(subject, 'task id')));
    if (command === 'resume') return ok(await runtime.resume(required(subject, 'task id')));
    if (command === 'stop') {
      const target = required(subject, 'target'); targetDescriptor(registry, target);
      return ok(await runtime.stop(target));
    }
    fail('usage', `Unknown command: ${command}`);
  } finally { runtime.close(); }
}

// The managed lifecycle supervisor is constructed only for commands that need it.
async function createSupervisor(stateRoot = null) {
  const { createHostSupervisor } = await import('../host/target-supervisor.mjs');
  return createHostSupervisor({ stateRoot });
}

export async function main(argv = process.argv.slice(2), io = console) {
  try {
    // Discovery and observation commands keep their read-only contract. CLI-only
    // users get the same registration hook on dispatch/ensure, or explicitly init.
    const parsed = parseArgs({ args: argv, allowPositionals: true, strict: true, options: CLI_PARSE_OPTIONS });
    if (['submit', 'run', 'council-submit', 'ensure'].includes(parsed.positionals[0])) {
      const { bootstrapCheckin } = await import('../checkin/scheduler.mjs');
      const registry = loadRegistry({ configPath: parsed.values.config });
      await bootstrapCheckin({ targets: ['trae', 'workbuddy'].filter(target => registry.targets[target]?.enabled) });
    }
    const envelope = await execute(argv);
    io.log(argv.includes('table') && argv.includes('--format') ? renderTable(envelope) : JSON.stringify(envelope));
    // `run` reports the task payload honestly, so the exit code carries the
    // outcome: 0 only for a succeeded task, or for an explicit --no-wait submit.
    if (parsed.positionals[0] === 'run' && envelope.ok) {
      return envelope.data?.status === 'succeeded' || parsed.values['no-wait'] === true ? 0 : 1;
    }
    return envelope.data?.results?.some(item => ['failed', 'unconfirmed'].includes(item.status)) ? 1 : 0;
  }
  catch (error) { io.log(JSON.stringify(notOk(error))); return 1; }
}

function required(value, label) { if (!value) fail('usage', `Missing ${label}.`); return value; }

// `--timeout-ms` bounds the CLI wait; these two bound the native run. The target
// transport stops the native process when `observation_timeout_ms` elapses, so a
// task that legitimately runs longer must raise it, otherwise it ends as
// `indeterminate` with no captured answer.
const RUN_EXECUTION_FLAGS = Object.freeze([
  ['observation-timeout-ms', 'observation_timeout_ms', REQUEST_LIMITS.observation_timeout_min_ms, REQUEST_LIMITS.observation_timeout_max_ms],
  ['execution-timeout-ms', 'execution_timeout_ms', REQUEST_LIMITS.execution_timeout_min_ms, REQUEST_LIMITS.execution_timeout_max_ms],
]);

// Raising the native deadline without raising the wait would only turn a
// finished task into a premature `run_wait_timeout`, so the wait follows an
// effective deadline unless the caller sets `--timeout-ms` itself.
export function resolveRunWaitTimeoutMs(explicitTimeoutMs, observationTimeoutMs) {
  if (explicitTimeoutMs !== undefined) return Number(explicitTimeoutMs);
  return Math.max(DEFAULT_RUN_TIMEOUT_MS, (observationTimeoutMs ?? DEFAULT_OBSERVATION_TIMEOUT_MS) + RUN_WAIT_MARGIN_MS);
}

function runExecution(values) {
  const execution = {};
  for (const [flag, field, minimum, maximum] of RUN_EXECUTION_FLAGS) {
    if (values[flag] === undefined) continue;
    const ms = Number(values[flag]);
    if (!Number.isSafeInteger(ms) || ms < minimum || ms > maximum) {
      fail('invalid_request', `--${flag} must be an integer between ${minimum} and ${maximum}.`);
    }
    execution[field] = ms;
  }
  return execution;
}

async function resolveRunPrompt(values, options) {
  const provided = [values.prompt !== undefined, values['prompt-file'] !== undefined, values['prompt-stdin'] === true].filter(Boolean).length;
  if (provided !== 1) fail('usage', 'run requires exactly one of --prompt, --prompt-file, or --prompt-stdin.');
  if (values.prompt !== undefined) {
    if (!values.prompt.trim()) fail('invalid_request', 'The run prompt must not be empty.');
    return values.prompt;
  }
  if (values['prompt-file'] !== undefined) {
    const text = fs.readFileSync(values['prompt-file'], 'utf8');
    if (Buffer.byteLength(text) > 1_048_576) fail('invalid_request', 'Prompt file exceeds 1 MiB.');
    if (!text.trim()) fail('invalid_request', 'The run prompt must not be empty.');
    return text;
  }
  const text = await readStdin(options.stdin ?? process.stdin, 'Prompt');
  if (!text.trim()) fail('invalid_request', 'The run prompt must not be empty.');
  return text;
}

// Waits for a terminal task state without ever re-sending the prompt. A native
// login wait is returned to the caller instead of being blocked on, and a
// timeout returns the last persisted status rather than a guessed outcome.
async function waitForRun(runtime, taskId, { timeoutMs, clock = Date.now, sleep = pause }) {
  const deadline = clock() + timeoutMs;
  for (;;) {
    const status = runtime.status(taskId);
    if (RUN_TERMINAL_STATES.has(status.status)) return { payload: runtime.result(taskId), warnings: [] };
    if (status.status === 'waiting_user') return { payload: runtime.result(taskId), warnings: ['run_waiting_user'] };
    // A claimed attempt means a worker owns this task right now, so a stall
    // error left over from an earlier failed worker is not the current state.
    if (RUN_STALLED_ERRORS.has(status.error?.code) && !status.attempt?.fencing_token) {
      return { payload: runtime.result(taskId), warnings: ['run_not_started'] };
    }
    const remaining = deadline - clock();
    if (remaining <= 0) return { payload: runtime.result(taskId), warnings: ['run_wait_timeout'] };
    await sleep(Math.min(status.poll_after_ms ?? 1000, remaining));
  }
}

function pause(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

function parseJson(value, label) {
  try { return JSON.parse(value); }
  catch { fail('invalid_request', `${label} must contain valid JSON.`); }
}

// A stream may split one UTF-8 character across chunks, so bytes are decoded
// with a stateful decoder instead of per-chunk `toString()`.
async function readStdin(stream, label = 'Request') {
  const decoder = new StringDecoder('utf8');
  let value = '';
  const guard = () => {
    if (Buffer.byteLength(value) > 1_048_576) fail('invalid_request', `${label} stdin exceeds 1 MiB.`);
  };
  for await (const chunk of stream) {
    value += typeof chunk === 'string' ? chunk : decoder.write(chunk);
    guard();
  }
  value += decoder.end();
  guard();
  return value;
}

function renderTable(envelope) {
  if (!envelope.ok) return JSON.stringify(envelope);
  const rows = Array.isArray(envelope.data) ? envelope.data : envelope.data?.tasks ?? [envelope.data];
  if (!rows.length) return '(no rows)';
  if (rows.every(row => typeof row !== 'object' || row === null)) return rows.map(row => String(row)).join('\n');
  const normalized = rows.map(row => Object.fromEntries(Object.entries(row).map(([key, value]) => [key, value && typeof value === 'object' ? JSON.stringify(value) : String(value ?? '')])));
  const columns = [...new Set(normalized.flatMap(row => Object.keys(row)))];
  const widths = columns.map(column => Math.max(column.length, ...normalized.map(row => String(row[column] ?? '').length)));
  const line = row => columns.map((column, index) => String(row[column] ?? '').padEnd(widths[index])).join(' | ').trimEnd();
  return [line(Object.fromEntries(columns.map(column => [column, column]))), widths.map(width => '-'.repeat(width)).join('-|-'), ...normalized.map(line)].join('\n');
}
