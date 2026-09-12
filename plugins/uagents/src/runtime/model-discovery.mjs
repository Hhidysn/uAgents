import { adapterFor } from '../adapters/index.mjs';
import { targetDescriptor } from '../registry/registry.mjs';

export async function discoverModelsForTarget(target, {
  registry,
  adapterFactory = adapterFor,
} = {}) {
  targetDescriptor(registry, target);
  const configured = Object.values(registry.models).filter(model => model.target === target && model.enabled);
  let native = { status: 'unsupported', discovery: 'unsupported', models: [] };
  try {
    const result = await adapterFactory(target).discoverModels({ registry });
    native = normalizeDiscovery(result);
  } catch (error) {
    native = {
      status: 'failed',
      discovery: 'native_cli',
      error_code: typeof error?.code === 'string' ? error.code : 'model_discovery_failed',
      models: [],
    };
  }

  const matched = new Set();
  const rows = configured.map(model => {
    const matchIndex = native.status === 'ok' ? findNativeModel(native.models, model) : -1;
    if (matchIndex >= 0) matched.add(matchIndex);
    const discovered = native.status === 'ok' ? matchIndex >= 0 : null;
    return {
      ...model,
      configured: true,
      admission_allowed: true,
      discovered,
      usable: discovered === null ? null : discovered,
      provider_availability: 'unconfirmed',
      discovery: discoveryEvidence(native),
    };
  });

  native.models.forEach((model, index) => {
    if (matched.has(index)) return;
    rows.push({
      target,
      model: model.id ?? null,
      route_id: model.route_id ?? null,
      provider: model.provider ?? target,
      kind: 'native_discovered',
      enabled: false,
      opt_in: false,
      configured: false,
      admission_allowed: false,
      discovered: true,
      usable: false,
      provider_availability: 'unconfirmed',
      discovery: discoveryEvidence(native),
    });
  });
  return rows;
}

function normalizeDiscovery(value) {
  if (!value || typeof value !== 'object') return { status: 'failed', discovery: 'unknown', error_code: 'invalid_discovery_result', models: [] };
  const status = value.status ?? (value.discovery === 'configured' ? 'configured_only' : 'ok');
  return {
    status,
    discovery: value.discovery ?? 'unknown',
    ...(value.error_code ? { error_code: value.error_code } : {}),
    models: Array.isArray(value.models) ? value.models : [],
  };
}

function findNativeModel(models, configured) {
  if (configured.kind === 'backend_default') {
    return models.findIndex(model => model.id === 'auto' || model.route_id === configured.route_id);
  }
  return models.findIndex(model => model.route_id === configured.route_id ||
    (model.id === configured.model && model.provider === configured.provider));
}

function discoveryEvidence(native) {
  return {
    status: native.status,
    method: native.discovery,
    ...(native.error_code ? { error_code: native.error_code } : {}),
  };
}
