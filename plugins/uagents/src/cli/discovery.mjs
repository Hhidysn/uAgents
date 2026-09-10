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
});

const stateDir = option('--state-dir', 'absolute_path', 'Use one explicit task-state directory for this command.');
const taskId = positional('task_id', 'uuid', true);
const target = positional('target', 'target_id', true);

export const CLI_COMMANDS = Object.freeze({
  targets: command('targets', 'targets', 'List enabled target IDs.', [], [], 'local_only'),
  capabilities: command('capabilities', 'capabilities <target>', 'Read the static capability descriptor for one target.', [target], [], 'local_only'),
  models: command('models', 'models <target>', 'List approved model routes for one target.', [target], [], 'local_only'),
  probe: command('probe', 'probe <target> [--model <model>]', 'Run the target-specific non-prompt probe.', [target], [option('--model', 'string', 'Model selector for the probe.')], 'native_no_prompt'),
  describe: command('describe', 'describe [command]', 'Return the machine-readable CLI contract.', [positional('command', 'command_name', false)], [], 'local_only'),
  schema: command('schema', 'schema request', 'Return a machine-readable protocol JSON Schema.', [positional('subject', 'enum', true, ['request'])], [], 'local_only'),
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
