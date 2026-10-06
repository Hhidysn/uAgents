import { fail } from '../protocol/errors.mjs';
import { DEFAULT_OBSERVATION_TIMEOUT_MS, REQUEST_LIMITS, SCHEMA_VERSION } from '../protocol/schema.mjs';

export const CLI_PARSE_OPTIONS = Object.freeze({
  request: Object.freeze({ type: 'string' }),
  'request-stdin': Object.freeze({ type: 'boolean' }),
  'state-dir': Object.freeze({ type: 'string' }),
  model: Object.freeze({ type: 'string' }),
  refresh: Object.freeze({ type: 'boolean' }),
  limit: Object.freeze({ type: 'string' }),
  cursor: Object.freeze({ type: 'string' }),
  config: Object.freeze({ type: 'string' }),
  format: Object.freeze({ type: 'string' }),
  member: Object.freeze({ type: 'string' }),
  workspace: Object.freeze({ type: 'string' }),
  'observation-timeout-ms': Object.freeze({ type: 'string' }),
  'execution-timeout-ms': Object.freeze({ type: 'string' }),
  all: Object.freeze({ type: 'boolean' }),
  force: Object.freeze({ type: 'boolean' }),
  validation: Object.freeze({ type: 'string' }),
  profile: Object.freeze({ type: 'string' }),
  target: Object.freeze({ type: 'string', multiple: true }),
  'check-only': Object.freeze({ type: 'boolean' }),
  time: Object.freeze({ type: 'string' }),
  prompt: Object.freeze({ type: 'string', short: 'p' }),
  'prompt-file': Object.freeze({ type: 'string' }),
  'prompt-stdin': Object.freeze({ type: 'boolean' }),
  mode: Object.freeze({ type: 'string' }),
  'no-wait': Object.freeze({ type: 'boolean' }),
  'timeout-ms': Object.freeze({ type: 'string' }),
  dir: Object.freeze({ type: 'string' }),
  'dry-run': Object.freeze({ type: 'boolean' }),
  'has-response': Object.freeze({ type: 'boolean' }),
});

const stateDir = option('--state-dir', 'absolute_path', 'Use one explicit task-state directory for this command.');
const configFile = option('--config', 'absolute_path', 'Load registry routes and target defaults from this JSON file; overrides UAGENTS_CONFIG.');
const taskId = positional('task_id', 'uuid', true);
const target = positional('target', 'target_id', true);

export const CLI_COMMANDS = Object.freeze({
  init: command('init', 'init [--config <file>]', 'Detect locally logged-in TRAE/WorkBuddy accounts and register daily check-in on Windows.', [], [configFile], 'local_state_change'),
  checkin: command('checkin', 'checkin [run|status|enable|disable] [--target trae|workbuddy ...] [--check-only] [--time HH:mm]', 'Run or inspect check-in, or manage the independent Windows daily task.', [positional('action', 'enum', false, ['run', 'status', 'enable', 'disable'])], [
    option('--target', 'string', 'Limit check-in to TRAE or WorkBuddy; repeat to select both.'),
    option('--check-only', 'boolean', 'Query provider check-in state without claiming credits.'),
    option('--time', 'string', 'Daily local Windows time for enable; default 00:30.'), configFile,
  ], 'may_claim_checkin_credits'),
  targets: command('targets', 'targets [--config <file>]', 'List enabled target IDs.', [], [configFile], 'local_only'),
  capabilities: command('capabilities', 'capabilities <target> [--config <file>]', 'Read the static capability descriptor for one target.', [target], [configFile], 'local_only'),
  models: command('models', 'models <target> [--refresh]', 'List model routes, native no-prompt discovery, and route-level file/image evidence.', [target], [
    option('--refresh', 'boolean', 'Bypass the uAgents model discovery cache and refresh the native catalog.'),
    configFile,
  ], 'native_no_prompt'),
  probe: command('probe', 'probe <target> [--model <model>] [--config <file>]', 'Run the target-specific non-prompt probe.', [target], [option('--model', 'string', 'Model selector for the probe.'), configFile], 'native_no_prompt'),
  describe: command('describe', 'describe [command]', 'Return the machine-readable CLI contract.', [positional('command', 'command_name', false)], [], 'local_only'),
  schema: command('schema', 'schema <request|council|council-validation|council-validation-profiles>', 'Return a machine-readable protocol JSON Schema.', [positional('subject', 'enum', true, ['request', 'council', 'council-validation', 'council-validation-profiles'])], [], 'local_only'),
  config: command('config', 'config validate [--config <file>]', 'Validate user model routes, defaults, and capability restrictions.', [positional('action', 'enum', true, ['validate'])], [configFile], 'local_only'),
  submit: {
    ...command('submit', 'submit (--request <file> | --request-stdin) [--config <file>] [--state-dir <dir>]', 'Register one idempotent task; a detached worker may send the prompt after registration.', [], [
      option('--request', 'file', 'Read the unified request JSON from a file.', { exclusive_group: 'request_source' }),
      option('--request-stdin', 'boolean', 'Read the unified request JSON from stdin.', { exclusive_group: 'request_source' }),
      stateDir,
      configFile,
    ], 'may_send_prompt'),
    constraints: [{ type: 'exactly_one', options: ['--request', '--request-stdin'] }],
    request_schema: { command: 'schema request', id: `uagents://schema/request/${SCHEMA_VERSION}` },
  },
  run: {
    ...command('run', 'run <target> [--model <model>] [--mode <mode>] [--workspace <dir>] (-p <prompt> | --prompt-file <file> | --prompt-stdin) [--no-wait] [--timeout-ms <ms>] [--observation-timeout-ms <ms>] [--execution-timeout-ms <ms>] [--state-dir <dir>]', 'Register one task, wait for it, and return the same payload as result.', [target], [
      option('--model', 'string', 'Explicit model selector; omit to use the target default route.'),
      option('--mode', 'string', 'Task intent: analysis or implementation.'),
      option('--workspace', 'absolute_path', 'Task workspace; defaults to the current directory.'),
      option('--prompt', 'string', 'Prompt text in the command line; it is visible in process arguments.', { exclusive_group: 'prompt_source' }),
      option('--prompt-file', 'file', 'Read the prompt from a UTF-8 file.', { exclusive_group: 'prompt_source' }),
      option('--prompt-stdin', 'boolean', 'Read the prompt from stdin.', { exclusive_group: 'prompt_source' }),
      option('--no-wait', 'boolean', 'Return right after registration with the task status.'),
      option('--timeout-ms', 'integer', 'Maximum wait for a terminal state; default 900000.', { minimum: 1 }),
      option('--observation-timeout-ms', 'integer', `How long the run observes the target before giving up. Default ${DEFAULT_OBSERVATION_TIMEOUT_MS}; longer tasks may raise it. Process-per-task targets are stopped at this deadline; a durable target (OpenCode V2) is only left unobserved and keeps running.`, { minimum: REQUEST_LIMITS.observation_timeout_min_ms, maximum: REQUEST_LIMITS.observation_timeout_max_ms, default: DEFAULT_OBSERVATION_TIMEOUT_MS }),
      option('--execution-timeout-ms', 'integer', 'Native execution deadline forwarded in the request: the owned process tree is terminated when it elapses. Only targets that can enforce it accept it.', { minimum: REQUEST_LIMITS.execution_timeout_min_ms, maximum: REQUEST_LIMITS.execution_timeout_max_ms }),
      stateDir,
      configFile,
    ], 'may_send_prompt'),
    constraints: [{ type: 'exactly_one', options: ['--prompt', '--prompt-file', '--prompt-stdin'] }],
    request_schema: { command: 'schema request', id: `uagents://schema/request/${SCHEMA_VERSION}` },
  },
  skills: command('skills', 'skills (install --dir <dir> | path) [--force] [--dry-run]', 'Show or install the bundled agent-dispatch skill for host Agents.', [positional('action', 'enum', false, ['install', 'path'])], [
    option('--dir', 'absolute_path', 'Skills directory to install into; the skill lands in <dir>/agent-dispatch.'),
    option('--force', 'boolean', 'Replace an existing agent-dispatch directory.'),
    option('--dry-run', 'boolean', 'List what would be copied without writing anything.'),
  ], 'local_state_change'),
  'council-submit': {
    ...command('council-submit', 'council-submit (--request <file> | --request-stdin) [--config <file>] [--state-dir <dir>]', 'Register a fan-out Council; implementation members can use isolated Git worktrees.', [], [
      option('--request', 'file', 'Read the council request JSON from a file.', { exclusive_group: 'request_source' }),
      option('--request-stdin', 'boolean', 'Read the council request JSON from stdin.', { exclusive_group: 'request_source' }),
      stateDir,
      configFile,
    ], 'may_send_prompt'),
    constraints: [{ type: 'exactly_one', options: ['--request', '--request-stdin'] }],
    request_schema: { command: 'schema council', id: `uagents://schema/council/${SCHEMA_VERSION}` },
  },
  'council-status': command('council-status', 'council-status <council-id> [--state-dir <dir>]', 'Aggregate persisted member Task status without contacting native Agents.', [positional('council_id', 'uuid', true)], [stateDir], 'local_only'),
  'council-result': command('council-result', 'council-result <council-id> [--state-dir <dir>]', 'Aggregate member Task results, usage and artifacts without model synthesis.', [positional('council_id', 'uuid', true)], [stateDir], 'local_only'),
  'council-diff': command('council-diff', 'council-diff <council-id> [--state-dir <dir>]', 'Compare git-worktree Council candidates, including tracked patch and untracked files, without modifying any worktree.', [positional('council_id', 'uuid', true)], [stateDir], 'local_only'),
  'council-adopt': command('council-adopt', 'council-adopt <council-id> --member <member-id> --workspace <dir> [--state-dir <dir>]', 'Apply one explicitly selected git-worktree Council candidate to a destination workspace without committing or merging.', [positional('council_id', 'uuid', true)], [
    option('--member', 'string', 'Council member_id to adopt.'),
    option('--workspace', 'absolute_path', 'Destination Git workspace. Its HEAD must equal the Council base HEAD.'),
    stateDir,
  ], 'local_state_change'),
  'council-validate': {
    ...command('council-validate', 'council-validate <council-id> (--member <member-id> | --all) (--validation <file> | --profile <name>) [--state-dir <dir>]', 'Run one explicit validation JSON or one named project validation profile in selected Council candidate worktrees and persist the latest evidence.', [positional('council_id', 'uuid', true)], [
      option('--member', 'string', 'Validate one Council member.', { exclusive_group: 'validation_scope' }),
      option('--all', 'boolean', 'Validate every Council member.', { exclusive_group: 'validation_scope' }),
      option('--validation', 'file', 'Read the Council validation JSON from a file.', { exclusive_group: 'validation_source' }),
      option('--profile', 'string', 'Load a named profile from the Council source workspace .uagents/validation-profiles.json.', { exclusive_group: 'validation_source' }),
      stateDir,
    ], 'local_execution'),
    constraints: [
      { type: 'exactly_one', options: ['--member', '--all'] },
      { type: 'exactly_one', options: ['--validation', '--profile'] },
    ],
    request_schema: { command: 'schema council-validation', id: `uagents://schema/council-validation/${SCHEMA_VERSION}` },
  },
  'council-cleanup': {
    ...command('council-cleanup', 'council-cleanup <council-id> (--member <member-id> | --all) [--force] [--state-dir <dir>]', 'Explicitly remove selected Council worktrees and dedicated branches while preserving Council and Task history.', [positional('council_id', 'uuid', true)], [
      option('--member', 'string', 'Clean up one Council member.', { exclusive_group: 'cleanup_scope' }),
      option('--all', 'boolean', 'Clean up every Council member.', { exclusive_group: 'cleanup_scope' }),
      option('--force', 'boolean', 'Discard dirty or diverged candidate worktrees.'),
      stateDir,
    ], 'local_state_change'),
    constraints: [{ type: 'exactly_one', options: ['--member', '--all'] }],
  },
  status: command('status', 'status <task-id> [--state-dir <dir>]', 'Read persisted task status only.', [taskId], [stateDir], 'local_only'),
  result: command('result', 'result <task-id> [--state-dir <dir>]', 'Read persisted task result, usage and artifacts.', [taskId], [stateDir], 'local_only'),
  cancel: command('cancel', 'cancel <task-id> [--state-dir <dir>]', 'Persist cancellation intent for a task.', [taskId], [stateDir], 'local_state_change'),
  list: command('list', 'list [--target <target> ...] [--has-response] [--cursor <cursor>] [--limit <n>] [--state-dir <dir>]', 'List persisted tasks, optionally filtered by target or by having a persisted response.', [], [
    option('--target', 'string', 'Filter to one or more targets; repeat to select several.'),
    option('--has-response', 'boolean', 'Only tasks with a persisted non-empty response.'),
    option('--cursor', 'string', 'Opaque pagination cursor.'),
    option('--limit', 'integer', 'Page size.', { minimum: 1, maximum: 200, default: 50 }),
    stateDir,
  ], 'local_only'),
  sessions: command('sessions', 'sessions [--target <target> ...] [--cursor <cursor>] [--limit <n>] [--state-dir <dir>]', 'Group persisted tasks by native session ID to list the registered conversations of each target.', [], [
    option('--target', 'string', 'Filter to one or more targets; repeat to select several.'),
    option('--cursor', 'string', 'Opaque pagination cursor.'),
    option('--limit', 'integer', 'Page size.', { minimum: 1, maximum: 200, default: 50 }),
    stateDir,
  ], 'local_only'),
  reconcile: command('reconcile', 'reconcile <task-id> [--state-dir <dir>]', 'Observe the stored native identity without resubmitting the original prompt.', [taskId], [stateDir], 'native_no_new_prompt'),
  ensure: command('ensure', 'ensure <target> [--refresh] [--profile personal|isolated] [--state-dir <dir>]', 'Discover/verify a target and prepare its managed lifecycle when applicable.', [target], [option('--refresh', 'boolean', 'Force installation rediscovery.'), option('--profile', 'string', 'TRAE only: launch with the existing personal profile or an isolated profile.'), stateDir], 'native_no_prompt'),
  resume: command('resume', 'resume <task-id> [--state-dir <dir>]', 'Recover or observe the same existing Task/Attempt; never creates a new prompt turn.', [taskId], [stateDir], 'native_no_new_prompt'),
  stop: command('stop', 'stop <target> [--state-dir <dir>]', 'Stop only an ownership-proven managed target instance.', [target], [stateDir], 'native_lifecycle_change'),
});

export function describeCli(commandName = null) {
  if (commandName === null || commandName === undefined) {
    return {
      interface: 'uagents-cli',
      schema_version: SCHEMA_VERSION,
      executable: 'uagents',
      default_format: 'json',
      commands: Object.values(CLI_COMMANDS).map(summary),
    };
  }
  const descriptor = CLI_COMMANDS[commandName];
  if (!descriptor) fail('usage', `Unknown command for describe: ${commandName}`);
  return structuredClone(descriptor);
}

export function isKnownCliCommand(commandName) {
  return Object.hasOwn(CLI_COMMANDS, commandName);
}

function command(name, usage, description, positionals, options, effect) {
  return Object.freeze({ name, usage, description, positionals, options, effect });
}

function positional(name, type, required, values = undefined) {
  return Object.freeze({ name, type, required, ...(values ? { values } : {}) });
}

function option(name, type, description, extra = {}) {
  return Object.freeze({ name, type, description, ...extra });
}

function summary(descriptor) {
  return { name: descriptor.name, usage: descriptor.usage, description: descriptor.description, effect: descriptor.effect };
}
