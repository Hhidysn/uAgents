import {
  EXECUTION_EFFORTS,
  EXECUTION_PERMISSIONS,
  INPUT_TYPES,
  REQUEST_FIELD_NAMES,
  REQUEST_LIMITS,
  REQUEST_MODES,
  SCHEMA_VERSION,
  uuidPattern,
} from './schema.mjs';

const uuidPatternSource = uuidPattern.source.replace(/^\^|\$$/g, '');

export function requestJsonSchema() {
  const schema = {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: `uagents://schema/request/${SCHEMA_VERSION}`,
    title: `uAgents request ${SCHEMA_VERSION}`,
    type: 'object',
    additionalProperties: false,
    required: ['schema_version', 'request_id', 'target', 'mode', 'prompt'],
    properties: {
      schema_version: { const: SCHEMA_VERSION },
      request_id: { type: 'string', pattern: uuidPatternSource, description: 'Canonical UUID for this intentionally new task.' },
      target: byteString(REQUEST_LIMITS.target_bytes),
      model: { ...byteString(REQUEST_LIMITS.model_bytes), default: 'default' },
      mode: { type: 'string', enum: [...REQUEST_MODES] },
      prompt: byteString(REQUEST_LIMITS.prompt_bytes),
      workspace: nullable({ type: 'string', 'x-uagents-path': 'absolute-local', 'x-uagents-max-bytes': REQUEST_LIMITS.workspace_bytes }),
      session: nullable({
        type: 'object', additionalProperties: false,
        properties: {
          continue_from_task_id: { type: 'string', pattern: uuidPatternSource },
          fork_from_task_id: { type: 'string', pattern: uuidPatternSource },
        },
        oneOf: [{ required: ['continue_from_task_id'] }, { required: ['fork_from_task_id'] }],
      }),
      inputs: {
        type: 'array', maxItems: REQUEST_LIMITS.inputs, default: [],
        items: {
          type: 'object', additionalProperties: false, required: ['type'],
          properties: {
            type: { type: 'string', enum: [...INPUT_TYPES] },
            path: { type: 'string', 'x-uagents-path': 'workspace-relative-forward-slash', 'x-uagents-max-bytes': REQUEST_LIMITS.relative_path_bytes },
            source: { type: 'string', 'x-uagents-path': 'absolute-local', 'x-uagents-max-bytes': REQUEST_LIMITS.workspace_bytes },
            blob: {
              type: 'object', additionalProperties: false, required: ['name', 'data_base64'],
              properties: {
                name: byteString(REQUEST_LIMITS.attachment_name_bytes),
                data_base64: { type: 'string', 'x-uagents-encoding': 'base64', 'x-uagents-max-bytes': REQUEST_LIMITS.attachment_blob_base64_bytes },
              },
            },
          },
          oneOf: [{ required: ['path'] }, { required: ['source'] }, { required: ['blob'] }],
        },
      },
      expected_outputs: {
        type: 'array', maxItems: REQUEST_LIMITS.expected_outputs, default: [],
        items: {
          type: 'object', additionalProperties: false, required: ['path', 'type'],
          properties: {
            path: { type: 'string', 'x-uagents-path': 'workspace-relative-forward-slash', 'x-uagents-max-bytes': REQUEST_LIMITS.relative_path_bytes },
            type: { const: 'file' },
            required: { type: 'boolean', default: true },
            max_bytes: { type: 'integer', minimum: 1, maximum: REQUEST_LIMITS.output_max_bytes, default: REQUEST_LIMITS.output_default_max_bytes },
          },
        },
      },
      execution: {
        type: 'object', additionalProperties: false, default: {},
        properties: {
          observation_timeout_ms: { type: 'integer', minimum: REQUEST_LIMITS.observation_timeout_min_ms, maximum: REQUEST_LIMITS.observation_timeout_max_ms, default: 120_000 },
          execution_timeout_ms: nullable({ type: 'integer', minimum: REQUEST_LIMITS.execution_timeout_min_ms, maximum: REQUEST_LIMITS.execution_timeout_max_ms }),
          effort: { type: 'string', enum: [...EXECUTION_EFFORTS], default: 'medium' },
          permission: { type: 'string', enum: [...EXECUTION_PERMISSIONS], default: 'native' },
          native_args: { type: 'array', maxItems: REQUEST_LIMITS.native_args, default: [], items: byteString(REQUEST_LIMITS.native_arg_bytes) },
          codex_transport: { const: 'app-server', description: 'Explicit Windows/Astra Codex app-server preview; omitted requests keep exec.' },
        },
      },
      policy: {
        type: 'object', additionalProperties: false, default: {},
        properties: {
          fallback: { type: 'string', minLength: 1, 'x-uagents-max-bytes': 64, default: 'none' },
          max_cost_usd: nullable({ type: 'number', minimum: 0 }),
        },
      },
    },
    'x-uagents-authoritative-validator': 'src/protocol/schema.mjs',
    'x-uagents-field-order': [...REQUEST_FIELD_NAMES],
    'x-uagents-note': 'x-uagents-max-bytes and x-uagents-path are enforced by the Core parser; standard JSON Schema string length is not used as a byte-count substitute.',
  };
  return schema;
}

function byteString(maximumBytes) {
  return { type: 'string', minLength: 1, 'x-uagents-max-bytes': maximumBytes };
}

function nullable(schema) {
  return { anyOf: [schema, { type: 'null' }] };
}
