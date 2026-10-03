import fs from 'node:fs';
import path from 'node:path';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { fail } from '../protocol/errors.mjs';
import { canonicalWorkspace } from '../runtime/workspace-key.mjs';
import { childEnvironment } from '../runtime/child-environment.mjs';
import { BUILTIN_REGISTRY } from '../registry/builtins.mjs';
import { runNoPromptCommand } from '../transports/no-prompt-command.mjs';

export const SERVICE_TOOLS = Object.freeze([
  'uagents_list_targets', 'uagents_get_capabilities', 'uagents_list_models', 'uagents_probe',
  'uagents_submit', 'uagents_status', 'uagents_result', 'uagents_cancel', 'uagents_list_tasks',
  'uagents_reconcile', 'uagents_ensure', 'uagents_resume', 'uagents_stop',
  'uagents_council_submit', 'uagents_council_status', 'uagents_council_result', 'uagents_council_diff',
  'uagents_council_validate', 'uagents_council_adopt', 'uagents_council_cleanup',
]);

const integerSchema = (minimum, maximum, defaultValue) => ({ type: 'integer', minimum, maximum, default: defaultValue });
export const SERVICE_CONFIG_SCHEMA = Object.freeze({
  $schema: 'https://json-schema.org/draft/2020-12/schema', type: 'object', additionalProperties: false,
  required: ['schema_version', 'state_dir', 'token_file', 'workspace_roots', 'targets'],
  properties: {
    schema_version: { const: '1.0' }, host: { const: '127.0.0.1', default: '127.0.0.1' }, port: integerSchema(0, 65535, 4319),
    state_dir: { type: 'string', description: 'Absolute shared Core state directory.' },
    token_file: { type: 'string', description: 'Absolute private Bearer credential file.' },
    registry_config: { type: ['string', 'null'], description: 'Absolute Core registry configuration file, or null.', default: null },
    workspace_roots: { type: 'array', minItems: 1, items: { type: 'string', description: 'Absolute existing directory; realpaths constrain admission.' } },
    targets: { type: 'array', minItems: 1, items: { enum: Object.keys(BUILTIN_REGISTRY.targets) } },
    tools: { type: 'array', minItems: 1, items: { enum: SERVICE_TOOLS }, default: SERVICE_TOOLS },
    poll_interval_ms: integerSchema(100, 60000, 1000), max_workers: integerSchema(1, 32, 4),
    max_tool_children: integerSchema(1, 32, 4), tool_timeout_ms: integerSchema(1000, 3600000, 300000),
    max_request_bytes: integerSchema(1024, 128 * 1024 * 1024, 16 * 1024 * 1024),
  },
});

export function validateServiceConfig(value) {
  const fields = new Set(['schema_version', 'host', 'port', 'state_dir', 'registry_config', 'token_file',
    'workspace_roots', 'targets', 'tools', 'poll_interval_ms', 'max_workers', 'max_tool_children',
    'tool_timeout_ms', 'max_request_bytes']);
  if (!value || Array.isArray(value) || typeof value !== 'object' || Object.keys(value).some(key => !fields.has(key))) {
    fail('invalid_request', 'Service configuration contains invalid or unsupported fields.');
  }
  if (value.schema_version !== '1.0' || (value.host ?? '127.0.0.1') !== '127.0.0.1') {
    fail('invalid_request', 'Service schema_version must be 1.0 and host must be 127.0.0.1.');
  }
  for (const field of ['state_dir', 'token_file']) absolute(value[field], field);
  if (value.registry_config != null) absolute(value.registry_config, 'registry_config');
  if (!Array.isArray(value.workspace_roots) || !value.workspace_roots.length) fail('invalid_request', 'Service requires workspace_roots.');
  const roots = [...new Set(value.workspace_roots.map(canonicalWorkspace))];
  const targets = strings(value.targets, 'targets', Object.keys(BUILTIN_REGISTRY.targets));
  const tools = strings(value.tools ?? SERVICE_TOOLS, 'tools', SERVICE_TOOLS);
  return {
    schema_version: '1.0', host: '127.0.0.1', port: integer(value.port ?? 4319, 'port', 0, 65535),
    state_dir: path.resolve(value.state_dir), token_file: path.resolve(value.token_file),
    registry_config: value.registry_config == null ? null : path.resolve(value.registry_config),
    workspace_roots: roots, targets, tools,
    poll_interval_ms: integer(value.poll_interval_ms ?? 1000, 'poll_interval_ms', 100, 60000),
    max_workers: integer(value.max_workers ?? 4, 'max_workers', 1, 32),
    max_tool_children: integer(value.max_tool_children ?? 4, 'max_tool_children', 1, 32),
    tool_timeout_ms: integer(value.tool_timeout_ms ?? 300000, 'tool_timeout_ms', 1000, 3600000),
    max_request_bytes: integer(value.max_request_bytes ?? 16 * 1024 * 1024, 'max_request_bytes', 1024, 128 * 1024 * 1024),
  };
}

export function readServiceConfig(file) {
  absolute(file, 'config');
  try { return validateServiceConfig(JSON.parse(fs.readFileSync(file, 'utf8'))); }
  catch (error) { if (error.code === 'invalid_request' || error.code === 'invalid_workspace') throw error; fail('invalid_request', 'Service configuration could not be read.'); }
}

export async function initializeServiceConfig(file, options) {
  absolute(file, 'config');
  const config = validateServiceConfig(options);
  if (fs.existsSync(file) || fs.existsSync(config.token_file)) fail('request_conflict', 'Service configuration or credential already exists.');
  for (const directory of new Set([path.dirname(file), path.dirname(config.token_file)])) {
    if (!fs.existsSync(directory)) {
      fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
      await privatePermissions(directory, true, true);
    } else await privatePermissions(directory, true, false);
  }
  fs.writeFileSync(config.token_file, `${randomBytes(32).toString('base64url')}\n`, { flag: 'wx', mode: 0o600 });
  let wroteConfig = false;
  try {
    await privatePermissions(config.token_file, false, true);
    fs.writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    wroteConfig = true;
    await privatePermissions(file, false, true);
  } catch (error) { if (wroteConfig) fs.unlinkSync(file); fs.unlinkSync(config.token_file); throw error; }
  return config;
}

export async function verifyServiceFiles(configFile, tokenFile) {
  for (const file of [configFile, tokenFile].filter(Boolean)) {
    absolute(file, 'credential/config');
    await privatePermissions(path.dirname(file), true, false);
    await privatePermissions(file, false, false);
  }
}

async function privatePermissions(file, directory, protect) {
  const info = fs.lstatSync(file);
  if (info.isSymbolicLink() || (!directory && (!info.isFile() || info.nlink !== 1)) || (directory && !info.isDirectory())) {
    fail('service_credential_permissions_failed', 'Service configuration and credentials require private, regular files and directories.');
  }
  if (process.platform !== 'win32') {
    if (protect) fs.chmodSync(file, directory ? 0o700 : 0o600);
    const actual = fs.statSync(file);
    if (actual.uid !== process.getuid() || (actual.mode & 0o077)) fail('service_credential_permissions_failed', 'Service configuration and credential permissions are not private.');
    return;
  }
  const literal = file.replaceAll("'", "''");
  const type = directory ? 'Directory' : 'File';
  const rule = directory
    ? `[System.Security.AccessControl.FileSystemAccessRule]::new($sid,'FullControl','ContainerInherit, ObjectInherit','None','Allow')`
    : `[System.Security.AccessControl.FileSystemAccessRule]::new($sid,'FullControl','Allow')`;
  const script = `$ErrorActionPreference='Stop'; $sid=[System.Security.Principal.WindowsIdentity]::GetCurrent().User; ` +
    (protect ? `$acl=[System.IO.${type}]::GetAccessControl('${literal}'); $acl.SetAccessRuleProtection($true,$false); ` +
      `$acl.AddAccessRule(${rule}); [System.IO.${type}]::SetAccessControl('${literal}',$acl); ` : '') +
    `$acl=[System.IO.${type}]::GetAccessControl('${literal}'); ` +
    `if ($acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value -ne $sid.Value) { exit 2 }; ` +
    `$trusted=@($sid.Value,'S-1-5-18','S-1-5-32-544'); ` +
    `foreach ($r in $acl.GetAccessRules($true,$true,[System.Security.Principal.SecurityIdentifier])) { ` +
    `if ($r.AccessControlType -eq 'Allow' -and $r.IdentityReference.Value -notin $trusted) { exit 3 } }`;
  const executable = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const result = await runNoPromptCommand(executable, ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { timeout: 10000, maxBuffer: 8192, windowsHide: true });
  if (result.status !== 0) fail('service_credential_permissions_failed', 'Service configuration, credential and their parent directories must be private to the current user. Use a dedicated service directory.');
}

export function readServiceToken(file) {
  let value;
  try { if (fs.statSync(file).size > 1024) throw new Error(); value = fs.readFileSync(file, 'utf8').trim(); }
  catch { fail('service_authentication_failed', 'Service credential file could not be read.'); }
  if (!/^[A-Za-z0-9_-]{43,128}$/.test(value)) fail('service_authentication_failed', 'Service credential file is invalid.');
  return value;
}

export function tokenMatches(header, token) {
  const received = typeof header === 'string' && /^Bearer [A-Za-z0-9_-]+$/.test(header) ? header.slice(7) : '';
  const left = Buffer.from(received), right = Buffer.from(token);
  return left.length === right.length && timingSafeEqual(left, right);
}

export function executionConfig(config) {
  const { token_file, host, port, ...execution } = config;
  return { ...execution, protected_paths: [token_file] };
}

export function serviceChildEnvironment(config, source = process.env) {
  const env = childEnvironment(source);
  for (const key of Object.keys(env)) if (/^UAGENTS_(?:SERVICE_|TOKEN|ENDPOINT)/i.test(key)) delete env[key];
  env.UAGENTS_STATE_DIR = config.state_dir;
  if (config.registry_config) env.UAGENTS_CONFIG = config.registry_config;
  else delete env.UAGENTS_CONFIG;
  return env;
}

function absolute(value, field) {
  if (typeof value !== 'string' || !path.isAbsolute(value)) fail('invalid_request', `Service ${field} must be an absolute path.`);
}
function integer(value, field, min, max) {
  if (!Number.isSafeInteger(value) || value < min || value > max) fail('invalid_request', `Service ${field} must be ${min}-${max}.`);
  return value;
}
function strings(value, field, allowed) {
  if (!Array.isArray(value) || !value.length || value.some(item => typeof item !== 'string' || !allowed.includes(item))) fail('invalid_request', `Service ${field} contains unsupported values.`);
  return [...new Set(value)];
}
