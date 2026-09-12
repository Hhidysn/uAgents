import fs from 'node:fs';
import path from 'node:path';
import { fail } from './errors.mjs';
import { SCHEMA_VERSION } from './schema.mjs';
import { councilValidationJsonSchema, parseCouncilValidation } from './council-validation-schema.mjs';

export const COUNCIL_VALIDATION_PROFILES_FILE = '.uagents/validation-profiles.json';
export const COUNCIL_VALIDATION_PROFILE_LIMITS = Object.freeze({ profiles: 32, profile_name_bytes: 64 });

const PROFILE_FILE_FIELDS = new Set(['schema_version', 'profiles']);
const PROFILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function parseCouncilValidationProfiles(input) {
  if (!isPlainObject(input)) fail('invalid_request', 'Validation profiles file must be a plain object.');
  for (const key of Object.keys(input)) if (!PROFILE_FILE_FIELDS.has(key)) fail('unsupported_field', `Unsupported validation profiles field: ${key}`);
  if (input.schema_version !== SCHEMA_VERSION) fail('unsupported_schema_version', `schema_version must be ${SCHEMA_VERSION}.`);
  if (!isPlainObject(input.profiles)) fail('invalid_request', 'validation profiles must contain a profiles object.');
  const entries = Object.entries(input.profiles);
  if (entries.length < 1 || entries.length > COUNCIL_VALIDATION_PROFILE_LIMITS.profiles) {
    fail('invalid_request', `validation profiles must contain 1-${COUNCIL_VALIDATION_PROFILE_LIMITS.profiles} profiles.`);
  }
  const profiles = {};
  for (const [name, body] of entries) {
    validateProfileName(name);
    if (!isPlainObject(body)) fail('invalid_request', `Validation profile ${name} must be a plain object.`);
    if (Object.prototype.hasOwnProperty.call(body, 'schema_version')) {
      fail('unsupported_field', `Validation profile ${name} inherits the file schema_version.`);
    }
    profiles[name] = parseCouncilValidation({ ...body, schema_version: SCHEMA_VERSION });
  }
  return { schema_version: SCHEMA_VERSION, profiles };
}

export function loadCouncilValidationProfile(workspace, profileName) {
  validateProfileName(profileName);
  if (typeof workspace !== 'string' || !path.isAbsolute(workspace)) fail('invalid_workspace', 'Validation profiles require the Council source workspace.');
  const file = path.join(workspace, ...COUNCIL_VALIDATION_PROFILES_FILE.split('/'));
  let parsed;
  try { parsed = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) {
    if (error?.code === 'ENOENT') fail('invalid_request', `Validation profiles file not found: ${COUNCIL_VALIDATION_PROFILES_FILE}`);
    if (error instanceof SyntaxError) fail('invalid_request', `Validation profiles file must contain valid JSON: ${COUNCIL_VALIDATION_PROFILES_FILE}`);
    throw error;
  }
  const config = parseCouncilValidationProfiles(parsed);
  const validation = config.profiles[profileName];
  if (!validation) fail('invalid_request', `Unknown validation profile: ${profileName}`);
  return { profile_name: profileName, profile_file: COUNCIL_VALIDATION_PROFILES_FILE, validation };
}

export function councilValidationProfilesJsonSchema() {
  const body = structuredClone(councilValidationJsonSchema());
  delete body.$schema;
  delete body.$id;
  delete body.title;
  delete body['x-uagents-note'];
  body.required = [];
  delete body.properties.schema_version;
  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: `uagents://schema/council-validation-profiles/${SCHEMA_VERSION}`,
    title: `uAgents council validation profiles ${SCHEMA_VERSION}`,
    type: 'object', additionalProperties: false, required: ['schema_version', 'profiles'],
    properties: {
      schema_version: { const: SCHEMA_VERSION },
      profiles: {
        type: 'object', minProperties: 1, maxProperties: COUNCIL_VALIDATION_PROFILE_LIMITS.profiles,
        propertyNames: { pattern: '^[A-Za-z0-9][A-Za-z0-9._-]*$', 'x-uagents-max-bytes': COUNCIL_VALIDATION_PROFILE_LIMITS.profile_name_bytes },
        additionalProperties: body,
      },
    },
    'x-uagents-location': COUNCIL_VALIDATION_PROFILES_FILE,
    'x-uagents-note': 'Profiles are loaded from the original Council source workspace and expand to the existing council-validation contract.',
  };
}

function validateProfileName(name) {
  if (typeof name !== 'string' || !PROFILE_NAME.test(name) || Buffer.byteLength(name) > COUNCIL_VALIDATION_PROFILE_LIMITS.profile_name_bytes) {
    fail('invalid_request', 'Validation profile names must use letters, digits, dot, underscore, or hyphen and start with a letter or digit.');
  }
}

function isPlainObject(value) {
  return Boolean(value) && !Array.isArray(value) && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype;
}
