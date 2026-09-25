import { canonicalHash } from '../protocol/canonical-json.mjs';
import { fail } from '../protocol/errors.mjs';
import { BUILTIN_REGISTRY } from './builtins.mjs';

export function createRegistry(userConfig = {}) {
  const config = validateConfig(userConfig);
  const targets = structuredClone(BUILTIN_REGISTRY.targets);
  const models = structuredClone(BUILTIN_REGISTRY.models);
  const defaults = { ...BUILTIN_REGISTRY.defaults };

  for (const [id, restriction] of sectionEntries(config, 'targets')) {
    const current = targets[id];
    if (!Object.hasOwn(targets, id)) fail('invalid_target', `Cannot configure unknown target: ${id}`);
    applyRestrictions(current, restriction, `targets.${id}`);
  }
  for (const [selector, route] of sectionEntries(config, 'routes')) {
    if (Object.hasOwn(models, selector)) fail('invalid_model', `Model route already exists: ${selector}`);
    models[selector] = userRoute(selector, route, targets);
  }
  for (const [route, restriction] of sectionEntries(config, 'models')) {
    const current = models[route];
    if (!Object.hasOwn(models, route)) fail('invalid_model', `Cannot configure unknown model route: ${route}`);
    if (!restriction || Array.isArray(restriction) || typeof restriction !== 'object' ||
        Object.keys(restriction).some(key => key !== 'enabled')) {
      fail('invalid_request', `models.${route} may only contain enabled.`);
    }
    if (restriction.enabled === false) current.enabled = false;
    else if (restriction.enabled !== undefined && restriction.enabled !== true) fail('invalid_request', `models.${route}.enabled must be boolean.`);
  }
  for (const [id, route] of sectionEntries(config, 'defaults')) {
    if (!Object.hasOwn(targets, id) || !targets[id].enabled || !Object.hasOwn(models, route) ||
        !models[route].enabled || models[route].target !== id) fail('invalid_model', `Invalid default route for target ${id}.`);
    defaults[id] = route;
  }
  for (const [id, route] of Object.entries(defaults)) {
    if (!targets[id]?.enabled || !models[route]?.enabled) delete defaults[id];
  }

  const registry = { version: '', targets, models, defaults };
  registry.version = canonicalHash(registry);
  return deepFreeze(registry);
}

export function targetDescriptor(registry, target) {
  const descriptor = registry.targets[target];
  if (!Object.hasOwn(registry.targets, target) || descriptor.enabled === false) fail('invalid_target', `Target is not enabled: ${target}`);
  return descriptor;
}

function applyRestrictions(target, restriction, label) {
  if (!restriction || Array.isArray(restriction) || typeof restriction !== 'object') fail('invalid_request', `${label} must be an object.`);
  const allowed = new Set(['enabled', 'modes', 'inputs', 'outputs', 'permissions', 'execution_timeout']);
  for (const key of Object.keys(restriction)) if (!allowed.has(key)) fail('unsupported_field', `Unsupported registry restriction: ${label}.${key}`);
  if (restriction.enabled !== undefined) {
    if (restriction.enabled !== false && restriction.enabled !== true) fail('invalid_request', `${label}.enabled must be boolean.`);
    target.enabled = target.enabled && restriction.enabled;
  }
  if (restriction.modes !== undefined) target.modes = intersection(target.modes, restriction.modes, `${label}.modes`);
  if (restriction.execution_timeout !== undefined) {
    if (typeof restriction.execution_timeout !== 'boolean') fail('invalid_request', `${label}.execution_timeout must be boolean.`);
    target.execution_timeout = target.execution_timeout === true && restriction.execution_timeout;
  }
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
  const allowed = new Set(['targets', 'models', 'routes', 'defaults']);
  for (const key of Object.keys(value)) if (!allowed.has(key)) fail('unsupported_field', `Unsupported registry config field: ${key}`);
  return value;
}

function sectionEntries(config, name) {
  const section = config[name];
  if (section === undefined) return [];
  if (!section || Array.isArray(section) || typeof section !== 'object') {
    fail('invalid_request', `${name} must be an object.`);
  }
  return Object.entries(section);
}

function userRoute(selector, value, targets) {
  if (!value || Array.isArray(value) || typeof value !== 'object') fail('invalid_request', `routes.${selector} must be an object.`);
  const fields = new Set(['target', 'model', 'provider', 'route_id']);
  if (Object.keys(value).some(key => !fields.has(key))) fail('unsupported_field', `Unsupported route field: ${selector}`);
  const { target, model, provider, route_id: routeId } = value;
  if (typeof target !== 'string' || !Object.hasOwn(targets, target) || !targets[target].enabled ||
      !['explicit', 'mixed'].includes(targets[target].model_selection)) {
    fail('invalid_target', `Cannot add a model route for target ${target}.`);
  }
  for (const [label, item] of Object.entries({ selector, model, provider, route_id: routeId })) {
    const displayName = target === 'trae' && (label === 'model' || label === 'route_id');
    if (typeof item !== 'string' || !item || Buffer.byteLength(item) > 256 ||
        item.startsWith('-') || (displayName ? item !== item.trim() : /\s/.test(item)) ||
        /[\x00-\x1f\x7f]/.test(item)) {
      fail('invalid_model', `routes.${selector}.${label} must be a nonempty model identifier.`);
    }
  }
  if (!selector.startsWith(`${target}/`) || selector === `${target}/` || model === 'default') {
    fail('invalid_model', `Route selector must be target-prefixed and concrete: ${selector}`);
  }
  if (target === 'opencode' && routeId !== `${provider}/${model}`) {
    fail('invalid_model', `OpenCode route_id must match provider/model: ${selector}`);
  }
  return { target, model, provider, route_id: routeId, kind: 'exact', enabled: true, opt_in: false,
    inputs: { files: false, images: false } };
}

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const item of Object.values(value)) deepFreeze(item);
  }
  return value;
}
