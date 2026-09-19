import { spawnSync } from 'node:child_process';
import { BUILTIN_REGISTRY } from '../registry/builtins.mjs';
import { childEnvironment } from '../runtime/child-environment.mjs';
import { locateCli } from './cli-process.mjs';

const DISCOVERY_TIMEOUT_MS = 10_000;
const AGY_DISCOVERY_TIMEOUT_MS = 30_000;
const DISCOVERY_MAX_BUFFER = 2 * 1024 * 1024;

export function discoverCliModelCatalog(target, {
  entryOverride = null,
  registry = BUILTIN_REGISTRY,
  runner = spawnSync,
  env = process.env,
} = {}) {
  const entry = locateCli(target, env, entryOverride);
  if (target === 'agy') {
    const result = run(runner, entry, ['models'], env, AGY_DISCOVERY_TIMEOUT_MS);
    const models = parseAgyModelList(result.stdout);
    if (hasUnrecognizedAgyOutput(result.stdout)) {
      const error = new Error('Native agy model catalog format was not recognized.');
      error.code = 'model_discovery_parse_failed';
      throw error;
    }
    return { status: 'ok', discovery: 'native_cli_catalog', models };
  }
  if (target === 'workbuddy') {
    const result = run(runner, process.execPath, [entry, '--help'], env);
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
  if (target === 'opencode') {
    const providers = openCodeProviders(registry);
    const models = [];
    for (const provider of providers) {
      const result = run(runner, entry, ['models', provider, '--pure'], env);
      models.push(...parseOpenCodeModelList(result.stdout, provider));
    }
    return { status: 'ok', discovery: 'native_cli_catalog', models: dedupe(models, item => item.route_id) };
  }
  return { status: 'unsupported', discovery: 'unsupported', models: [] };
}

export function modelDiscoveryScope(target, registry = BUILTIN_REGISTRY) {
  if (target === 'agy') return { version: 1, method: 'native_cli_catalog', argv: ['models'] };
  if (target === 'workbuddy') return { version: 1, method: 'native_cli_help', argv: ['--help'] };
  if (target === 'opencode') {
    return { version: 1, method: 'native_cli_catalog', providers: openCodeProviders(registry) };
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

export function parseOpenCodeModelList(text, provider) {
  const prefix = `${provider}/`;
  return dedupe(String(text).split(/\r?\n/).map(line => line.trim()).filter(line => line.startsWith(prefix)).map(routeId => ({
    id: routeId.split('/').at(-1),
    route_id: routeId,
    provider: routeId.split('/').slice(0, -1).join('/'),
    kind: 'native_catalog',
  })), item => item.route_id);
}

function run(runner, command, args, env, timeout = DISCOVERY_TIMEOUT_MS) {
  const result = runner(command, args, {
    encoding: 'utf8',
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

function openCodeProviders(registry) {
  return [...new Set(Object.values(registry.models)
    .filter(model => model.target === 'opencode' && model.enabled && typeof model.route_id === 'string')
    .map(model => model.route_id.split('/')[0])
    .filter(Boolean))].sort();
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
