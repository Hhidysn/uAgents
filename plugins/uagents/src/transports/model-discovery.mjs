import { BUILTIN_REGISTRY } from '../registry/builtins.mjs';
import { childEnvironment } from '../runtime/child-environment.mjs';
import { locateCli } from './cli-process.mjs';
import { openCodeMajorVersion } from './opencode-driver.mjs';
import { runNoPromptCommand } from './no-prompt-command.mjs';

const DISCOVERY_TIMEOUT_MS = 10_000;
const AGY_DISCOVERY_TIMEOUT_MS = 30_000;
const DISCOVERY_MAX_BUFFER = 2 * 1024 * 1024;

export async function discoverCliModelCatalog(target, {
  entryOverride = null,
  registry = BUILTIN_REGISTRY,
  runner = runNoPromptCommand,
  env = process.env,
} = {}) {
  const entry = locateCli(target, env, entryOverride);
  if (target === 'agy') {
    const result = await run(runner, entry, ['models'], env, AGY_DISCOVERY_TIMEOUT_MS);
    const models = parseAgyModelList(result.stdout);
    if (hasUnrecognizedAgyOutput(result.stdout)) {
      const error = new Error('Native agy model catalog format was not recognized.');
      error.code = 'model_discovery_parse_failed';
      throw error;
    }
    return { status: 'ok', discovery: 'native_cli_catalog', models };
  }
  if (target === 'workbuddy') {
    const result = await run(runner, process.execPath, [entry, '--help'], env);
    const models = parseWorkBuddyModelHelp(result.stdout);
    if (!models.length) {
      const error = new Error('Native WorkBuddy model help format was not recognized.');
      error.code = 'model_discovery_parse_failed';
      throw error;
    }
    return {
      status: 'ok',
      discovery: 'native_cli_help',
      models,
    };
  }
  if (target === 'pi') {
    const result = await run(runner, process.execPath, [entry, '--list-models'], env);
    const models = parsePiModelList(result.stdout);
    if (!models.length) {
      const error = new Error('Native pi model catalog format was not recognized.');
      error.code = 'model_discovery_parse_failed';
      throw error;
    }
    return { status: 'ok', discovery: 'native_cli_catalog', models };
  }
  if (target === 'opencode') {
    const major = await openCodeMajorVersion(entry, { runner, env });
    // Ask the native CLI for its complete catalog; built-ins do not limit providers.
    const result = await run(runner, entry, major >= 2 ? ['models'] : ['models', '--pure'], env);
    return { status: 'ok', discovery: 'native_cli_catalog', models: parseOpenCodeModelList(result.stdout) };
  }
  return { status: 'unsupported', discovery: 'unsupported', models: [] };
}

export function modelDiscoveryScope(target, registry = BUILTIN_REGISTRY) {
  if (target === 'agy') return { version: 1, method: 'native_cli_catalog', argv: ['models'] };
  if (target === 'workbuddy') return { version: 1, method: 'native_cli_help', argv: ['--help'] };
  if (target === 'pi') return { version: 2, method: 'native_cli_catalog', argv: ['--list-models'] };
  if (target === 'opencode') {
    return { version: 2, method: 'native_cli_catalog', providers: 'all' };
  }
  return null;
}

export function parseAgyModelList(text) {
  const models = [];
  for (const rawLine of stripAnsi(String(text)).split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || /^Fetching available models\.\.\.$/i.test(line)) continue;
    const parts = line.includes('\t') ? line.split(/\t+/) : line.split(/\s{2,}/);
    if (parts.length < 2) continue;
    const id = parts[0].trim();
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{1,127}$/.test(id)) continue;
    models.push({
      id,
      route_id: `agy/${id}`,
      provider: 'agy',
      kind: 'native_catalog',
    });
  }
  return dedupe(models, item => item.id);
}

export function parseWorkBuddyModelHelp(text) {
  const match = String(text).match(/Currently supported:\s*\(([^)]+)\)/s);
  if (!match) return [];
  return dedupe(match[1].split(',').map(value => value.trim()).filter(Boolean).map(id => ({
    id,
    route_id: null,
    provider: 'workbuddy',
    kind: 'native_catalog',
  })), item => item.id);
}

export function parsePiModelList(text) {
  const lines = stripAnsi(String(text)).split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  // The native table always starts with a `provider model ...` header. Without
  // it the output is a no-models/empty status message (e.g. "No models
  // available. Use /login ..."), which must not be mistaken for a catalog row.
  const headerIndex = lines.findIndex(line => {
    const parts = line.split(/\s+/);
    return parts.length >= 2 && parts[0] === 'provider' && parts[1] === 'model';
  });
  if (headerIndex === -1) return [];
  const models = [];
  for (const line of lines.slice(headerIndex + 1)) {
    const parts = line.split(/\s+/);
    if (parts.length < 2) continue;
    const [provider, id] = parts;
    if (!provider || !id) continue;
    models.push({
      id,
      route_id: `${provider}/${id}`,
      provider,
      kind: 'native_catalog',
    });
  }
  return dedupe(models, item => item.route_id);
}

export function parseOpenCodeModelList(text, provider) {
  const prefix = provider ? `${provider}/` : '';
  return dedupe(stripAnsi(String(text)).split(/\r?\n/).map(line => line.trim()).filter(line => line.startsWith(prefix) && /^[^\s/]+(?:\/[^\s/]+)+$/.test(line)).map(routeId => ({
    id: routeId.split('/').at(-1),
    route_id: routeId,
    provider: routeId.split('/').slice(0, -1).join('/'),
    kind: 'native_catalog',
  })), item => item.route_id);
}

async function run(runner, command, args, env, timeout = DISCOVERY_TIMEOUT_MS) {
  const result = await runner(command, args, {
    windowsHide: true,
    env: childEnvironment(env),
    timeout,
    maxBuffer: DISCOVERY_MAX_BUFFER,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const error = new Error('Native model discovery command failed.');
    error.code = 'model_discovery_failed';
    throw error;
  }
  return result;
}

function stripAnsi(value) {
  return value.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '');
}

function hasUnrecognizedAgyOutput(text) {
  return stripAnsi(String(text)).split(/\r?\n/).map(line => line.trim()).some(line => {
    if (!line || /^Fetching available models\.\.\.$/i.test(line)) return false;
    const parts = line.includes('\t') ? line.split(/\t+/) : line.split(/\s{2,}/);
    return parts.length < 2 || !/^[A-Za-z0-9][A-Za-z0-9._-]{1,127}$/.test(parts[0].trim());
  });
}

function dedupe(items, key) {
  const seen = new Set();
  return items.filter(item => {
    const value = key(item);
    if (seen.has(value)) return false;
    seen.add(value);
    return true;
  });
}
