import { canonicalHash } from '../protocol/canonical-json.mjs';
import { fail } from '../protocol/errors.mjs';
import { BUILTIN_REGISTRY } from './builtins.mjs';

export function createRegistry(userConfig = {}) {
  const config = validateConfig(userConfig);
  const targets = structuredClone(BUILTIN_REGISTRY.targets);
  const models = structuredClone(BUILTIN_REGISTRY.models);
  const defaults = { ...BUILTIN_REGISTRY.defaults };

  for (const [id, restriction] of Object.entries(config.targets ?? {})) {
    const current = targets[id];
    if (!current) fail('invalid_target', `Cannot configure unknown target: ${id}`);
    applyRestrictions(current, restriction, `targets.${id}`);
  }
  for (const [route, restriction] of Object.entries(config.models ?? {})) {
    const current = models[route];
    if (!current) fail('invalid_model', `Cannot configure unknown model route: ${route}`);
    if (restriction.enabled === false) current.enabled = false;
    else if (restriction.enabled !== undefined && restriction.enabled !== true) fail('invalid_request', `models.${route}.enabled must be boolean.`);
  }
  for (const [id, route] of Object.entries(config.defaults ?? {})) {
    if (!targets[id] || !models[route] || models[route].target !== id) fail('invalid_model', `Invalid default route for target ${id}.`);
    defaults[id] = route;
  }

  const registry = { version: '', targets, models, defaults };
  registry.version = canonicalHash(registry);
  return deepFreeze(registry);
}

export function targetDescriptor(registry, target) {
  const descriptor = registry.targets[target];
  if (!descriptor || descriptor.enabled === false) fail('invalid_target', `Target is not enabled: ${target}`);
  return descriptor;
}

function applyRestrictions(target, restriction, label) {
  if (!restriction || Array.isArray(restriction) || typeof restriction !== 'object') fail('invalid_request', `${label} must be an object.`);
  const allowed = new Set(['enabled', 'modes', 'inputs', 'outputs', 'permissions']);
  for (const key of Object.keys(restriction)) if (!allowed.has(key)) fail('unsupported_field', `Unsupported registry restriction: ${label}.${key}`);
  if (restriction.enabled !== undefined) {
    if (restriction.enabled !== false && restriction.enabled !== true) fail('invalid_request', `${label}.enabled must be boolean.`);
    target.enabled = target.enabled && restriction.enabled;
  }
  if (restriction.modes !== undefined) target.modes = intersection(target.modes, restriction.modes, `${label}.modes`);
  for (const group of ['inputs', 'outputs', 'permissions']) {
    if (restriction[group] === undefined) continue;
    const values = restriction[group];
    if (!values || Array.isArray(values) || typeof values !== 'object') fail('invalid_request', `${label}.${group} must be an object.`);
    for (const [key, requested] of Object.entries(values)) {
      if (!(key in target[group]) || typeof requested !== 'boolean') fail('invalid_request', `Invalid ${label}.${group}.${key}.`);
      target[group][key] = target[group][key] && requested;
    }
  }
}

function intersection(builtin, requested, label) {
  if (!Array.isArray(requested) || requested.some(item => typeof item !== 'string')) fail('invalid_request', `${label} must be a string array.`);
  return builtin.filter(item => requested.includes(item));
}

function validateConfig(value) {
  if (!value || Array.isArray(value) || typeof value !== 'object') fail('invalid_request', 'Registry config must be an object.');
  const allowed = new Set(['targets', 'models', 'defaults']);
  for (const key of Object.keys(value)) if (!allowed.has(key)) fail('unsupported_field', `Unsupported registry config field: ${key}`);
  return value;
}

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const item of Object.values(value)) deepFreeze(item);
  }
  return value;
}
