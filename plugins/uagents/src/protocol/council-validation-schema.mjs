import { fail } from './errors.mjs';
import { SCHEMA_VERSION } from './schema.mjs';

export const COUNCIL_VALIDATION_LIMITS = Object.freeze({
  command_args: 64,
  arg_bytes: 4096,
  timeout_ms_min: 100,
  timeout_ms_max: 60 * 60 * 1000,
  timeout_ms_default: 120_000,
});

const FIELDS = new Set(['schema_version', 'command', 'timeout_ms']);

export function parseCouncilValidation(input) {
  if (!input || Array.isArray(input) || typeof input !== 'object' || Object.getPrototypeOf(input) !== Object.prototype) {
    fail('invalid_request', 'Council validation must be a plain object.');
  }
  for (const key of Object.keys(input)) if (!FIELDS.has(key)) fail('unsupported_field', `Unsupported Council validation field: ${key}`);
  if (input.schema_version !== SCHEMA_VERSION) fail('unsupported_schema_version', `schema_version must be ${SCHEMA_VERSION}.`);
  if (!Array.isArray(input.command) || input.command.length < 1 || input.command.length > COUNCIL_VALIDATION_LIMITS.command_args) {
    fail('invalid_request', `validation.command must contain 1-${COUNCIL_VALIDATION_LIMITS.command_args} argv items.`);
  }
  const command = input.command.map((value, index) => {
    if (typeof value !== 'string' || value.length === 0 || Buffer.byteLength(value) > COUNCIL_VALIDATION_LIMITS.arg_bytes) {
      fail('invalid_request', `validation.command[${index}] must be a non-empty string up to ${COUNCIL_VALIDATION_LIMITS.arg_bytes} bytes.`);
    }
    return value;
  });
  const timeout = input.timeout_ms ?? COUNCIL_VALIDATION_LIMITS.timeout_ms_default;
  if (!Number.isInteger(timeout) || timeout < COUNCIL_VALIDATION_LIMITS.timeout_ms_min || timeout > COUNCIL_VALIDATION_LIMITS.timeout_ms_max) {
    fail('invalid_request', `validation.timeout_ms must be an integer between ${COUNCIL_VALIDATION_LIMITS.timeout_ms_min} and ${COUNCIL_VALIDATION_LIMITS.timeout_ms_max}.`);
  }
  return { schema_version: SCHEMA_VERSION, command, timeout_ms: timeout };
}

export function councilValidationJsonSchema() {
  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: `uagents://schema/council-validation/${SCHEMA_VERSION}`,
    title: `uAgents council validation ${SCHEMA_VERSION}`,
    type: 'object',
    additionalProperties: false,
    required: ['schema_version', 'command'],
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
    },
    'x-uagents-note': 'Runs locally in each selected Council member effective worktree workspace. It does not contact Agent providers or select a winner.',
  };
}
