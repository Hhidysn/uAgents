import { fail } from '../protocol/errors.mjs';

export function resolveModel(registry, target, requested) {
  let route = requested;
  let requestedKind = 'exact';
  if (requested === 'default') {
    route = registry.defaults[target];
    requestedKind = 'alias';
    if (!route) fail('model_unavailable', `Target ${target} has no approved default model.`, { category: 'policy', submission: 'not_sent' });
  }

  let record = registry.models[route];
  if (!record && target === 'agy' && /^gemini-[a-z0-9.-]+$/.test(route)) {
    record = { target: 'agy', model: route, provider: 'agy', route_id: `agy/${route}`, kind: 'exact', enabled: true, opt_in: false };
  }
  if (!record || record.enabled === false || record.target !== target) {
    fail('model_unavailable', `Model route is not enabled for ${target}: ${route}`, { category: 'policy', submission: 'not_sent' });
  }
  return {
    model_requested: requested,
    model_resolved: record.model,
    provider: record.provider,
    route_id: record.route_id,
    model_resolution: {
      kind: requested === 'default' ? (record.kind === 'backend_default' ? 'backend_default' : requestedKind) : record.kind,
      registry_version: registry.version,
    },
    opt_in: Boolean(record.opt_in),
  };
}
