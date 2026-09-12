import { fail } from '../protocol/errors.mjs';
import { SCHEMA_VERSION } from '../protocol/schema.mjs';

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
  all: Object.freeze({ type: 'boolean' }),
  force: Object.freeze({ type: 'boolean' }),
  validation: Object.freeze({ type: 'string' }),
  profile: Object.freeze({ type: 'string' }),
});

const stateDir = option('--state-dir', 'absolute_path', 'Use one explicit task-state directory for this command.');
const taskId = positional('task_id', 'uuid', true);
const target = positional('target', 'target_id', true);

export const CLI_COMMANDS = Object.freeze({
  targets: command('targets', 'targets', 'List enabled target IDs.', [], [], 'local_only'),
  capabilities: command('capabilities', 'capabilities <target>', 'Read the static capability descriptor for one target.', [target], [], 'local_only'),
  models: command('models', 'models <target>', 'Merge approved model routes with local no-prompt native model discovery.', [target], [], 'native_no_prompt'),
  probe: command('probe', 'probe <target> [--model <model>]', 'Run the target-specific non-prompt probe.', [target], [option('--model', 'string', 'Model selector for the probe.')], 'native_no_prompt'),
  describe: command('describe', 'describe [command]', 'Return the machine-readable CLI contract.', [positional('command', 'command_name', false)], [], 'local_only'),
  schema: command('schema', 'schema <request|council|council-validation|council-validation-profiles>', 'Return a machine-readable protocol JSON Schema.', [positional('subject', 'enum', true, ['request', 'council', 'council-validation', 'council-validation-profiles'])], [], 'local_only'),
  config: command('config', 'config validate [--config <file>]', 'Validate user registry tightening configuration.', [positional('action', 'enum', true, ['validate'])], [option('--config', 'file', 'JSON configuration file.')], 'local_only'),
  submit: {
    ...command('submit', 'submit (--request <file> | --request-stdin) [--state-dir <dir>]', 'Register one idempotent task; a detached worker may send the prompt after registration.', [], [
      option('--request', 'file', 'Read the unified request JSON from a file.', { exclusive_group: 'request_source' }),
      option('--request-stdin', 'boolean', 'Read the unified request JSON from stdin.', { exclusive_group: 'request_source' }),
      stateDir,
    ], 'may_send_prompt'),
    constraints: [{ type: 'exactly_one', options: ['--request', '--request-stdin'] }],
    request_schema: { command: 'schema request', id: `uagents://schema/request/${SCHEMA_VERSION}` },
  },
  'council-submit': {
    ...command('council-submit', 'council-submit (--request <file> | --request-stdin) [--state-dir <dir>]', 'Register a fan-out Council; implementation members can use isolated Git worktrees.', [], [
      option('--request', 'file', 'Read the council request JSON from a file.', { exclusive_group: 'request_source' }),
      option('--request-stdin', 'boolean', 'Read the council request JSON from stdin.', { exclusive_group: 'request_source' }),
      stateDir,
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
  list: command('list', 'list [--cursor <cursor>] [--limit <n>] [--state-dir <dir>]', 'List persisted tasks.', [], [
    option('--cursor', 'string', 'Opaque pagination cursor.'),
    option('--limit', 'integer', 'Page size.', { minimum: 1, maximum: 200, default: 50 }),
    stateDir,
  ], 'local_only'),
  reconcile: command('reconcile', 'reconcile <task-id> [--state-dir <dir>]', 'Observe the stored native identity without resubmitting the original prompt.', [taskId], [stateDir], 'native_no_new_prompt'),
  ensure: command('ensure', 'ensure <target> [--refresh] [--state-dir <dir>]', 'Discover/verify a target and prepare its managed lifecycle when applicable.', [target], [option('--refresh', 'boolean', 'Force installation rediscovery.'), stateDir], 'native_no_prompt'),
  resume: command('resume', 'resume <task-id> [--state-dir <dir>]', 'Recover or observe the same existing Task/Attempt; never creates a new prompt turn.', [taskId], [stateDir], 'native_no_new_prompt'),
  stop: command('stop', 'stop <target> [--state-dir <dir>]', 'Stop only an ownership-proven managed target instance.', [target], [stateDir], 'native_lifecycle_change'),
});

export function describeCli(commandName = null) {
  if (commandName === null || commandName === undefined) {
    return {
      interface: 'uagents-cli',
      schema_version: SCHEMA_VERSION,
      executable: 'node <plugin-root>/bin/uagents.mjs',
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
