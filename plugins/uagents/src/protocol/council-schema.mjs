import { createHash } from 'node:crypto';
import { parseRequest, REQUEST_LIMITS, SCHEMA_VERSION, uuidPattern } from './schema.mjs';
import { requestJsonSchema } from './request-json-schema.mjs';
import { fail } from './errors.mjs';

export const COUNCIL_LIMITS = Object.freeze({ members: 16, member_id_bytes: 64 });

const COUNCIL_FIELDS = new Set(['schema_version', 'council_id', 'strategy', 'prompt', 'workspace', 'inputs', 'execution', 'members']);
const MEMBER_FIELDS = new Set(['member_id', 'target', 'model', 'instruction', 'session']);
const EXECUTION_FIELDS = new Set(['observation_timeout_ms', 'effort', 'permission']);

export function parseCouncilRequest(input) {
  const value = plainObject(input, 'council');
  exactFields(value, COUNCIL_FIELDS, 'council');
  if (value.schema_version !== SCHEMA_VERSION) fail('unsupported_schema_version', `schema_version must be ${SCHEMA_VERSION}.`);
  if (!uuidPattern.test(value.council_id ?? '')) fail('invalid_request_id', 'council_id must be a canonical UUID.');
  if ((value.strategy ?? 'fanout') !== 'fanout') fail('invalid_request', 'council.strategy must be fanout.');
  if (!Array.isArray(value.members) || value.members.length < 2 || value.members.length > COUNCIL_LIMITS.members) {
    fail('invalid_request', `council.members must contain 2–${COUNCIL_LIMITS.members} members.`);
  }
  const execution = plainObject(value.execution ?? {}, 'council.execution');
  exactFields(execution, EXECUTION_FIELDS, 'council.execution');

  const seen = new Set();
  const councilId = value.council_id.toLowerCase();
  const parsedTasks = value.members.map((raw, index) => {
    const member = plainObject(raw, `council.members[${index}]`);
    exactFields(member, MEMBER_FIELDS, `council.members[${index}]`);
    requiredString(member.member_id, `council.members[${index}].member_id`, COUNCIL_LIMITS.member_id_bytes);
    if (seen.has(member.member_id)) fail('invalid_request', `Duplicate council member_id: ${member.member_id}`);
    seen.add(member.member_id);
    if (member.instruction === null || member.session === null) fail('invalid_request', `council.members[${index}] optional fields must be omitted rather than null.`);
    const instruction = member.instruction ?? null;
    if (instruction !== null) requiredString(instruction, `council.members[${index}].instruction`, REQUEST_LIMITS.prompt_bytes);
    return {
      member_id: member.member_id,
      instruction,
      task: parseRequest({
        schema_version: SCHEMA_VERSION,
        request_id: councilMemberTaskId(councilId, member.member_id),
        target: member.target,
        model: member.model,
        mode: 'analysis',
        prompt: memberPrompt(value.prompt, instruction),
        ...(value.workspace === undefined ? {} : { workspace: value.workspace }),
        ...(value.inputs === undefined ? {} : { inputs: value.inputs }),
        execution: {
          ...(execution.observation_timeout_ms === undefined ? {} : { observation_timeout_ms: execution.observation_timeout_ms }),
          ...(execution.effort === undefined ? {} : { effort: execution.effort }),
          permission: execution.permission ?? 'advisory-read-only',
        },
        policy: { fallback: 'none', max_cost_usd: null },
        ...(member.session === undefined ? {} : { session: member.session }),
      }),
    };
  });
  const first = parsedTasks[0].task;
  return {
    schema_version: SCHEMA_VERSION,
    council_id: councilId,
    strategy: 'fanout',
    prompt: value.prompt,
    workspace: first.workspace,
    inputs: first.inputs,
    execution: {
      observation_timeout_ms: first.execution.observation_timeout_ms,
      effort: first.execution.effort,
      permission: first.execution.permission,
    },
    members: parsedTasks.map(({ member_id, instruction, task }) => ({
      member_id,
      target: task.target,
      model: task.model,
      instruction,
      session: task.session,
      task_id: task.request_id,
    })),
  };
}

export function buildCouncilMemberRequests(council) {
  return council.members.map(member => parseRequest({
    schema_version: council.schema_version,
    request_id: member.task_id,
    target: member.target,
    model: member.model,
    mode: 'analysis',
    prompt: memberPrompt(council.prompt, member.instruction),
    ...(council.workspace === null ? {} : { workspace: council.workspace }),
    inputs: council.inputs,
    execution: council.execution,
    policy: { fallback: 'none', max_cost_usd: null },
    ...(member.session === null ? {} : { session: member.session }),
  }));
}

export function councilJsonSchema() {
  const task = requestJsonSchema();
  const session = task.properties.session.anyOf[0];
  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: `uagents://schema/council/${SCHEMA_VERSION}`,
    title: `uAgents council ${SCHEMA_VERSION}`,
    type: 'object',
    additionalProperties: false,
    required: ['schema_version', 'council_id', 'prompt', 'members'],
    properties: {
      schema_version: { const: SCHEMA_VERSION },
      council_id: { ...task.properties.request_id, description: 'Canonical UUID for this intentionally new Council.' },
      strategy: { const: 'fanout', default: 'fanout' },
      prompt: task.properties.prompt,
      workspace: task.properties.workspace,
      inputs: task.properties.inputs,
      execution: {
        type: 'object', additionalProperties: false, default: {},
        properties: {
          observation_timeout_ms: task.properties.execution.properties.observation_timeout_ms,
          effort: task.properties.execution.properties.effort,
          permission: { ...task.properties.execution.properties.permission, default: 'advisory-read-only' },
        },
      },
      members: {
        type: 'array', minItems: 2, maxItems: COUNCIL_LIMITS.members,
        items: {
          type: 'object', additionalProperties: false, required: ['member_id', 'target', 'model'],
          properties: {
            member_id: { type: 'string', minLength: 1, 'x-uagents-max-bytes': COUNCIL_LIMITS.member_id_bytes },
            target: task.properties.target,
            model: task.properties.model,
            instruction: task.properties.prompt,
            session,
          },
        },
      },
    },
    'x-uagents-mode': 'analysis',
    'x-uagents-member-task-id': 'deterministic UUIDv8 derived from council_id and member_id',
    'x-uagents-note': 'fanout registers member Tasks without waiting; existing workspace leases may serialize overlapping workspace execution.',
  };
}

export function councilMemberTaskId(councilId, memberId) {
  const bytes = createHash('sha256').update(`uagents-council-v1\0${councilId.toLowerCase()}\0${memberId}`).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x80;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function memberPrompt(prompt, instruction) {
  return instruction ? `${prompt}\n\nCouncil member focus:\n${instruction}` : prompt;
}

function plainObject(value, label) {
  if (!value || Array.isArray(value) || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype) fail('invalid_request', `${label} must be a plain object.`);
  return value;
}

function exactFields(value, allowed, label) {
  for (const key of Object.keys(value)) if (!allowed.has(key)) fail('unsupported_field', `Unsupported ${label} field: ${key}`);
}

function requiredString(value, label, maximumBytes) {
  if (typeof value !== 'string' || !value.trim() || Buffer.byteLength(value) > maximumBytes) fail('invalid_request', `${label} must be a non-empty string of at most ${maximumBytes} bytes.`);
}
