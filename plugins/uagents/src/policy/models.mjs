import { fail } from '../protocol/errors.mjs';

export function resolveModel(registry, target, requested) {
  let route = requested;
  let requestedKind = 'exact';
  if (requested === 'default') {
    route = registry.defaults[target];
    requestedKind = 'alias';
    if (!route) fail('model_unavailable', `Target ${target} has no approved default model.`, { category: 'policy', submission: 'not_sent' });
  }

  let record = Object.hasOwn(registry.models, route) ? registry.models[route] : null;
  if ((!record || record.target !== target) && requested !== 'default') {
    record = nativeRoute(target, route);
    if (record && Object.values(registry.models).some(model => model.target === target &&
        model.enabled === false && (model.route_id === route || model.route_id === record.route_id ||
          model.model === record.model))) {
      record = null;
    }
  }
  if (!record || record.enabled === false || record.target !== target) {
    fail('model_unavailable', `Model route is not enabled for ${target}: ${route}`, { category: 'policy', submission: 'not_sent' });
  }
  return {
    model_requested: requested,
    model_resolved: record.model,
    provider: record.provider,
    route_id: record.route_id,
    inputs: record.inputs ?? null,
    model_resolution: {
      kind: requested === 'default' ? (record.kind === 'backend_default' ? 'backend_default' : requestedKind) : record.kind,
      registry_version: registry.version,
    },
    opt_in: Boolean(record.opt_in),
  };
}

// Native selectors are passed to the target as data. The native CLI/gateway
// decides whether the model exists; this registry does not maintain an allowlist.
function nativeRoute(target, selector) {
  const nativeId = value => typeof value === 'string' && value && value === value.trim() &&
    !value.startsWith('-') && Buffer.byteLength(value) <= 256 && !/[\x00-\x1f\x7f]/.test(value);
  let model = selector;
  let provider = target;
  if (target === 'claudeCode' && selector.startsWith('claudeCode/')) model = selector.slice('claudeCode/'.length);
  if (target === 'opencode' || target === 'dsh') {
    const parts = selector.split('/');
    if (parts.length < 2 || parts.some(part => !nativeId(part))) return null;
    model = parts.at(-1);
    provider = parts.slice(0, -1).join('/');
  } else if (target === 'trae') {
    if (typeof model !== 'string' || !model.trim() || model !== model.trim() ||
        Buffer.byteLength(model) > 256 || /[\x00-\x1f\x7f]/.test(model)) return null;
  } else if (!['agy', 'workbuddy', 'codex', 'claudeCode'].includes(target) || !nativeId(model)) {
    return null;
  }
  return {
    target, model, provider,
    route_id: target === 'opencode' || target === 'dsh' ? selector : `${target}/${model}`,
    kind: 'native_selected', enabled: true, opt_in: false,
    inputs: { files: false, images: false },
  };
}
