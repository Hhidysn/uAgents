import path from 'node:path';
import { fail } from './errors.mjs';

export const SCHEMA_VERSION = '1.0';
export const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const REQUEST_FIELD_NAMES = Object.freeze(['schema_version', 'request_id', 'target', 'model', 'mode', 'prompt', 'workspace', 'inputs', 'expected_outputs', 'execution', 'policy', 'session']);
export const EXECUTION_FIELD_NAMES = Object.freeze(['observation_timeout_ms', 'execution_timeout_ms', 'effort', 'permission', 'native_args']);
export const POLICY_FIELD_NAMES = Object.freeze(['fallback', 'max_cost_usd']);
export const SESSION_FIELD_NAMES = Object.freeze(['continue_from_task_id']);
export const INPUT_FIELD_NAMES = Object.freeze(['type', 'path', 'source']);
export const OUTPUT_FIELD_NAMES = Object.freeze(['path', 'type', 'required', 'max_bytes']);
export const REQUEST_MODES = Object.freeze(['analysis', 'implementation']);
export const EXECUTION_PERMISSIONS = Object.freeze(['native', 'advisory-read-only', 'enforced-read-only', 'workspace-write', 'full-access']);
export const EXECUTION_EFFORTS = Object.freeze(['low', 'medium', 'high', 'max']);
export const INPUT_TYPES = Object.freeze(['file', 'image']);
export const REQUEST_LIMITS = Object.freeze({
  target_bytes: 64,
  model_bytes: 256,
  prompt_bytes: 65_536,
  workspace_bytes: 32_767,
  inputs: 64,
  expected_outputs: 64,
  native_args: 64,
  native_arg_bytes: 4_096,
  relative_path_bytes: 1_024,
  observation_timeout_min_ms: 1_000,
  observation_timeout_max_ms: 1_200_000,
  execution_timeout_min_ms: 1_000,
  execution_timeout_max_ms: 86_400_000,
  output_default_max_bytes: 10_485_760,
  output_max_bytes: 1_073_741_824,
});

const REQUEST_FIELDS = new Set(REQUEST_FIELD_NAMES);
const EXECUTION_FIELDS = new Set(EXECUTION_FIELD_NAMES);
const POLICY_FIELDS = new Set(POLICY_FIELD_NAMES);
const SESSION_FIELDS = new Set(SESSION_FIELD_NAMES);
const INPUT_FIELDS = new Set(INPUT_FIELD_NAMES);
const OUTPUT_FIELDS = new Set(OUTPUT_FIELD_NAMES);
const MODES = new Set(REQUEST_MODES);
const PERMISSIONS = new Set(EXECUTION_PERMISSIONS);
const EFFORTS = new Set(EXECUTION_EFFORTS);

export function parseRequest(input) {
  const value = plainObject(input, 'request');
  exactFields(value, REQUEST_FIELDS, 'request');
  if (value.schema_version !== SCHEMA_VERSION) fail('unsupported_schema_version', `schema_version must be ${SCHEMA_VERSION}.`);
  if (!uuidPattern.test(value.request_id ?? '')) fail('invalid_request_id', 'request_id must be a canonical UUID.');
  requiredString(value.target, 'target', REQUEST_LIMITS.target_bytes);
  requiredString(value.model, 'model', REQUEST_LIMITS.model_bytes);
  if (!MODES.has(value.mode)) fail('invalid_request', 'mode must be analysis or implementation.');
  requiredString(value.prompt, 'prompt', REQUEST_LIMITS.prompt_bytes);

  let workspace = null;
  if (value.workspace !== undefined && value.workspace !== null) {
    requiredString(value.workspace, 'workspace', REQUEST_LIMITS.workspace_bytes);
    if (!path.isAbsolute(value.workspace)) fail('invalid_workspace', 'workspace must be an absolute path.');
    workspace = path.resolve(value.workspace);
  }

  const inputs = arrayOf(value.inputs ?? [], 'inputs', REQUEST_LIMITS.inputs, parseInput);
  const expectedOutputs = arrayOf(value.expected_outputs ?? [], 'expected_outputs', REQUEST_LIMITS.expected_outputs, parseOutput);
  ensureUniqueInputLocations(inputs);
  ensureUniquePaths(expectedOutputs, 'expected_outputs');

  const execution = parseExecution(value.execution ?? {});
  const policy = parsePolicy(value.policy ?? {});
  const session = parseSession(value.session ?? null, value.request_id);
  return {
    schema_version: SCHEMA_VERSION,
    request_id: value.request_id.toLowerCase(),
    target: value.target,
    model: value.model,
    mode: value.mode,
    prompt: value.prompt,
    workspace,
    inputs,
    expected_outputs: expectedOutputs,
    execution,
    policy,
    session,
  };
}

export function modelIdentity(fields = {}) {
  const verification = plainObject(fields.model_verification ?? {}, 'model_verification');
  exactFields(verification, new Set(['status', 'assurance', 'match', 'method', 'evidence_ref']), 'model_verification');
  return {
    model_requested: nullableString(fields.model_requested),
    model_resolved: nullableString(fields.model_resolved),
    model_reported: nullableString(fields.model_reported),
    model_verified: fields.model_verified === true,
    provider: nullableString(fields.provider),
    route_id: nullableString(fields.route_id),
    model_resolution: fields.model_resolution ?? null,
    model_verification: {
      status: verification.status ?? 'unknown',
      assurance: verification.assurance ?? 'none',
      match: verification.match === true ? true : verification.match === false ? false : null,
      method: verification.method ?? null,
      evidence_ref: verification.evidence_ref ?? null,
    },
  };
}

function parseExecution(input) {
  const value = plainObject(input, 'execution');
  exactFields(value, EXECUTION_FIELDS, 'execution');
  const observation = value.observation_timeout_ms ?? 120_000;
  integerRange(observation, 'observation_timeout_ms', REQUEST_LIMITS.observation_timeout_min_ms, REQUEST_LIMITS.observation_timeout_max_ms);
  if (value.execution_timeout_ms !== undefined && value.execution_timeout_ms !== null) integerRange(value.execution_timeout_ms, 'execution_timeout_ms', REQUEST_LIMITS.execution_timeout_min_ms, REQUEST_LIMITS.execution_timeout_max_ms);
  const effort = value.effort ?? 'medium';
  const permission = value.permission ?? 'native';
  const nativeArgs = arrayOf(value.native_args ?? [], 'execution.native_args', REQUEST_LIMITS.native_args, parseNativeArg);
  if (!EFFORTS.has(effort)) fail('invalid_request', 'execution.effort is invalid.');
  if (!PERMISSIONS.has(permission)) fail('invalid_request', 'execution.permission is invalid.');
  return { observation_timeout_ms: observation, execution_timeout_ms: value.execution_timeout_ms ?? null, effort, permission, native_args: nativeArgs };
}

function parseNativeArg(value, index) {
  if (typeof value !== 'string' || !value.trim() || Buffer.byteLength(value) > REQUEST_LIMITS.native_arg_bytes) {
    fail('invalid_request', `execution.native_args[${index}] must be a non-empty string of at most ${REQUEST_LIMITS.native_arg_bytes} bytes.`);
  }
  return value;
}

function parsePolicy(input) {
  const value = plainObject(input, 'policy');
  exactFields(value, POLICY_FIELDS, 'policy');
  const fallback = value.fallback ?? 'none';
  requiredString(fallback, 'policy.fallback', 64);
  if (value.max_cost_usd !== undefined && value.max_cost_usd !== null && (typeof value.max_cost_usd !== 'number' || !Number.isFinite(value.max_cost_usd) || value.max_cost_usd < 0)) {
    fail('invalid_request', 'policy.max_cost_usd must be null or a non-negative finite number.');
  }
  return { fallback, max_cost_usd: value.max_cost_usd ?? null };
}

function parseSession(input, requestId) {
  if (input === null) return null;
  const value = plainObject(input, 'session');
  exactFields(value, SESSION_FIELDS, 'session');
  if (!uuidPattern.test(value.continue_from_task_id ?? '')) {
    fail('invalid_request', 'session.continue_from_task_id must be a canonical UUID.');
  }
  const source = value.continue_from_task_id.toLowerCase();
  if (source === String(requestId).toLowerCase()) fail('invalid_request', 'A task cannot continue from itself.');
  return { continue_from_task_id: source };
}

function parseInput(item, index) {
  const value = plainObject(item, `inputs[${index}]`);
  exactFields(value, INPUT_FIELDS, `inputs[${index}]`);
  if (value.type !== 'file' && value.type !== 'image') fail('invalid_input', 'Input type must be file or image.');
  const hasPath = value.path !== undefined;
  const hasSource = value.source !== undefined;
  if (hasPath === hasSource) fail('invalid_input', `inputs[${index}] must contain exactly one of path or source.`);
  if (hasPath) return { type: value.type, path: relativePath(value.path, `inputs[${index}].path`) };
  requiredString(value.source, `inputs[${index}].source`, REQUEST_LIMITS.workspace_bytes);
  if (!path.isAbsolute(value.source)) fail('invalid_input', `inputs[${index}].source must be an absolute local path.`);
  return { type: value.type, source: path.resolve(value.source) };
}

function parseOutput(item, index) {
  const value = plainObject(item, `expected_outputs[${index}]`);
  exactFields(value, OUTPUT_FIELDS, `expected_outputs[${index}]`);
  if (value.type !== 'file') fail('invalid_output', 'Only file outputs are supported.');
  const maxBytes = value.max_bytes ?? REQUEST_LIMITS.output_default_max_bytes;
  integerRange(maxBytes, `expected_outputs[${index}].max_bytes`, 1, REQUEST_LIMITS.output_max_bytes);
  return { path: relativePath(value.path, `expected_outputs[${index}].path`), type: 'file', required: value.required !== false, max_bytes: maxBytes };
}

function relativePath(value, label) {
  requiredString(value, label, REQUEST_LIMITS.relative_path_bytes);
  if (path.isAbsolute(value) || value.includes('\\') || value.split('/').some(part => !part || part === '.' || part === '..')) fail('invalid_request', `${label} must be a safe relative path using forward slashes.`);
  if (/^[a-z]:/i.test(value) || /[\x00-\x1f<>:"|?*]/.test(value)) fail('invalid_request', `${label} contains unsupported characters.`);
  return value;
}

function ensureUniquePaths(items, label) {
  const keys = items.map(item => item.path.toLocaleLowerCase('en-US'));
  if (new Set(keys).size !== keys.length) fail('invalid_request', `${label} contains duplicate paths.`);
}

function ensureUniqueInputLocations(inputs) {
  const keys = inputs.map(input => input.path !== undefined
    ? `path:${input.path.toLocaleLowerCase('en-US')}`
    : `source:${input.source.normalize('NFC').toLocaleLowerCase('en-US')}`);
  if (new Set(keys).size !== keys.length) fail('invalid_request', 'inputs contains duplicate paths or sources.');
}

function arrayOf(value, label, maximum, parser) {
  if (!Array.isArray(value) || value.length > maximum) fail('invalid_request', `${label} must contain at most ${maximum} entries.`);
  return value.map(parser);
}

function plainObject(value, label) {
  if (!value || Array.isArray(value) || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype) fail('invalid_request', `${label} must be a plain object.`);
  return value;
}

function exactFields(value, allowed, label) {
  for (const key of Object.keys(value)) if (!allowed.has(key)) fail('unsupported_field', `Unsupported ${label} field: ${key}`);
}

function requiredString(value, label, maximumBytes) {
  if (typeof value !== 'string' || !value.trim() || Buffer.byteLength(value) === 0 || Buffer.byteLength(value) > maximumBytes) {
    fail('invalid_request', `${label} must be a non-empty string of at most ${maximumBytes} bytes.`);
  }
}

function nullableString(value) {
  return typeof value === 'string' ? value : null;
}

function integerRange(value, label, minimum, maximum) {
  if (!Number.isInteger(value) || value < minimum || value > maximum) fail('invalid_request', `${label} must be an integer from ${minimum} to ${maximum}.`);
}
