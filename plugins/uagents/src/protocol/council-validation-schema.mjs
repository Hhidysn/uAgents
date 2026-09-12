import { fail } from './errors.mjs';
import { SCHEMA_VERSION } from './schema.mjs';

export const COUNCIL_VALIDATION_LIMITS = Object.freeze({
  command_args: 64,
  arg_bytes: 4096,
  checks: 16,
  check_name_bytes: 64,
  timeout_ms_min: 100,
  timeout_ms_max: 60 * 60 * 1000,
  timeout_ms_default: 120_000,
});

const FIELDS = new Set(['schema_version', 'command', 'checks', 'timeout_ms', 'on_failure']);
const CHECK_FIELDS = new Set(['name', 'command', 'timeout_ms']);
const ON_FAILURE = new Set(['continue', 'stop']);

export function parseCouncilValidation(input) {
  if (!input || Array.isArray(input) || typeof input !== 'object' || Object.getPrototypeOf(input) !== Object.prototype) {
    fail('invalid_request', 'Council validation must be a plain object.');
  }
  for (const key of Object.keys(input)) if (!FIELDS.has(key)) fail('unsupported_field', `Unsupported Council validation field: ${key}`);
  if (input.schema_version !== SCHEMA_VERSION) fail('unsupported_schema_version', `schema_version must be ${SCHEMA_VERSION}.`);
  const hasCommand = input.command !== undefined;
  const hasChecks = input.checks !== undefined;
  if (hasCommand === hasChecks) fail('invalid_request', 'Council validation must contain exactly one of command or checks.');
  const timeout = parseTimeout(input.timeout_ms, 'validation.timeout_ms');

  if (hasCommand) {
    if (input.on_failure !== undefined) fail('invalid_request', 'validation.on_failure is only valid with checks.');
    return {
      schema_version: SCHEMA_VERSION,
      command: parseCommand(input.command, 'validation.command'),
      timeout_ms: timeout,
    };
  }

  if (!Array.isArray(input.checks) || input.checks.length < 1 || input.checks.length > COUNCIL_VALIDATION_LIMITS.checks) {
    fail('invalid_request', `validation.checks must contain 1-${COUNCIL_VALIDATION_LIMITS.checks} checks.`);
  }
  const onFailure = input.on_failure ?? 'continue';
  if (!ON_FAILURE.has(onFailure)) fail('invalid_request', 'validation.on_failure must be continue or stop.');
  const checks = input.checks.map((item, index) => parseCheck(item, index, timeout));
  const names = checks.map(check => check.name.normalize('NFC').toLocaleLowerCase('en-US'));
  if (new Set(names).size !== names.length) fail('invalid_request', 'validation.checks contains duplicate names.');
  return { schema_version: SCHEMA_VERSION, checks, timeout_ms: timeout, on_failure: onFailure };
}

function parseCheck(input, index, defaultTimeout) {
  if (!input || Array.isArray(input) || typeof input !== 'object' || Object.getPrototypeOf(input) !== Object.prototype) {
    fail('invalid_request', `validation.checks[${index}] must be a plain object.`);
  }
  for (const key of Object.keys(input)) if (!CHECK_FIELDS.has(key)) fail('unsupported_field', `Unsupported validation.checks[${index}] field: ${key}`);
  if (typeof input.name !== 'string' || !input.name.trim() || Buffer.byteLength(input.name) > COUNCIL_VALIDATION_LIMITS.check_name_bytes) {
    fail('invalid_request', `validation.checks[${index}].name must be a non-empty string up to ${COUNCIL_VALIDATION_LIMITS.check_name_bytes} bytes.`);
  }
  return {
    name: input.name.trim(),
    command: parseCommand(input.command, `validation.checks[${index}].command`),
    timeout_ms: input.timeout_ms === undefined ? defaultTimeout : parseTimeout(input.timeout_ms, `validation.checks[${index}].timeout_ms`),
  };
}

function parseCommand(input, label) {
  if (!Array.isArray(input) || input.length < 1 || input.length > COUNCIL_VALIDATION_LIMITS.command_args) {
    fail('invalid_request', `${label} must contain 1-${COUNCIL_VALIDATION_LIMITS.command_args} argv items.`);
  }
  return input.map((value, index) => {
    if (typeof value !== 'string' || value.length === 0 || Buffer.byteLength(value) > COUNCIL_VALIDATION_LIMITS.arg_bytes) {
      fail('invalid_request', `${label}[${index}] must be a non-empty string up to ${COUNCIL_VALIDATION_LIMITS.arg_bytes} bytes.`);
    }
    return value;
  });
}

function parseTimeout(value, label) {
  const timeout = value ?? COUNCIL_VALIDATION_LIMITS.timeout_ms_default;
  if (!Number.isInteger(timeout) || timeout < COUNCIL_VALIDATION_LIMITS.timeout_ms_min || timeout > COUNCIL_VALIDATION_LIMITS.timeout_ms_max) {
    fail('invalid_request', `${label} must be an integer between ${COUNCIL_VALIDATION_LIMITS.timeout_ms_min} and ${COUNCIL_VALIDATION_LIMITS.timeout_ms_max}.`);
  }
  return timeout;
}

export function councilValidationJsonSchema() {
  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: `uagents://schema/council-validation/${SCHEMA_VERSION}`,
    title: `uAgents council validation ${SCHEMA_VERSION}`,
    type: 'object',
    additionalProperties: false,
    required: ['schema_version'],
    properties: {
      schema_version: { const: SCHEMA_VERSION },
      command: {
        type: 'array', minItems: 1, maxItems: COUNCIL_VALIDATION_LIMITS.command_args,
        items: { type: 'string', minLength: 1, 'x-uagents-max-bytes': COUNCIL_VALIDATION_LIMITS.arg_bytes },
        description: 'Executable argv. The first item is launched directly without a shell; remaining items are passed unchanged.',
      },
      timeout_ms: {
        type: 'integer',
        minimum: COUNCIL_VALIDATION_LIMITS.timeout_ms_min,
        maximum: COUNCIL_VALIDATION_LIMITS.timeout_ms_max,
        default: COUNCIL_VALIDATION_LIMITS.timeout_ms_default,
      },
      checks: {
        type: 'array', minItems: 1, maxItems: COUNCIL_VALIDATION_LIMITS.checks,
        items: {
          type: 'object', additionalProperties: false, required: ['name', 'command'],
          properties: {
            name: { type: 'string', minLength: 1, 'x-uagents-max-bytes': COUNCIL_VALIDATION_LIMITS.check_name_bytes },
            command: {
              type: 'array', minItems: 1, maxItems: COUNCIL_VALIDATION_LIMITS.command_args,
              items: { type: 'string', minLength: 1, 'x-uagents-max-bytes': COUNCIL_VALIDATION_LIMITS.arg_bytes },
              description: 'Executable argv for this check. Launched directly without a shell.',
            },
            timeout_ms: {
              type: 'integer', minimum: COUNCIL_VALIDATION_LIMITS.timeout_ms_min, maximum: COUNCIL_VALIDATION_LIMITS.timeout_ms_max,
            },
          },
        },
      },
      on_failure: { type: 'string', enum: ['continue', 'stop'], default: 'continue' },
    },
    oneOf: [
      { required: ['command'], not: { anyOf: [{ required: ['checks'] }, { required: ['on_failure'] }] } },
      { required: ['checks'], not: { required: ['command'] } },
    ],
    'x-uagents-note': 'Legacy command remains supported. checks runs named argv validations in order; on_failure controls whether later checks continue or are recorded as skipped. Runs locally and never contacts Agent providers or selects a winner.',
  };
}
