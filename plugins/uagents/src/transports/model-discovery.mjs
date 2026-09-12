import { spawnSync } from 'node:child_process';
import { BUILTIN_REGISTRY } from '../registry/builtins.mjs';
import { childEnvironment } from '../runtime/child-environment.mjs';
import { locateCli } from './cli-process.mjs';

const DISCOVERY_TIMEOUT_MS = 10_000;
const DISCOVERY_MAX_BUFFER = 2 * 1024 * 1024;

export function discoverCliModelCatalog(target, {
  entryOverride = null,
  registry = BUILTIN_REGISTRY,
  runner = spawnSync,
  env = process.env,
} = {}) {
  const entry = locateCli(target, env, entryOverride);
  if (target === 'workbuddy') {
    const result = run(runner, process.execPath, [entry, '--help'], env);
    return {
      status: 'ok',
      discovery: 'native_cli_help',
      models: parseWorkBuddyModelHelp(result.stdout),
    };
  }
  if (target === 'opencode') {
    const providers = [...new Set(Object.values(registry.models)
      .filter(model => model.target === 'opencode' && model.enabled && typeof model.route_id === 'string')
      .map(model => model.route_id.split('/')[0])
      .filter(Boolean))];
    const models = [];
    for (const provider of providers) {
      const result = run(runner, entry, ['models', provider, '--pure'], env);
      models.push(...parseOpenCodeModelList(result.stdout, provider));
    }
    return { status: 'ok', discovery: 'native_cli_catalog', models: dedupe(models, item => item.route_id) };
  }
  return { status: 'unsupported', discovery: 'unsupported', models: [] };
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

function run(runner, command, args, env) {
  const result = runner(command, args, {
    encoding: 'utf8',
    windowsHide: true,
    env: childEnvironment(env),
    timeout: DISCOVERY_TIMEOUT_MS,
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

function dedupe(items, key) {
  const seen = new Set();
  return items.filter(item => {
    const value = key(item);
    if (seen.has(value)) return false;
    seen.add(value);
    return true;
  });
}
