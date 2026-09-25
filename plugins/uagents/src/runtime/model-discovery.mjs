import { adapterFor } from '../adapters/index.mjs';
import { resolveModel } from '../policy/models.mjs';
import { canonicalHash } from '../protocol/canonical-json.mjs';
import { targetDescriptor } from '../registry/registry.mjs';
import { modelDiscoveryScope } from '../transports/model-discovery.mjs';

export const MODEL_DISCOVERY_TTL_MS = 10 * 60 * 1000;

const NATIVE_DISCOVERY_TARGETS = new Set(['agy', 'workbuddy', 'opencode']);

export async function discoverModelsForTarget(target, {
  registry,
  adapterFactory = adapterFor,
  refresh = false,
  clock = Date.now,
  cacheStore = null,
  resolveInstallation = null,
  ttlMs = MODEL_DISCOVERY_TTL_MS,
} = {}) {
  targetDescriptor(registry, target);
  const configured = Object.entries(registry.models).filter(([, model]) => model.target === target && model.enabled);
  const adapter = adapterFactory(target);
  const nowMs = clock();

  if (!NATIVE_DISCOVERY_TARGETS.has(target)) {
    let native;
    try {
      native = normalizeDiscovery(await adapter.discoverModels({ registry }));
    } catch (error) {
      native = failedDiscovery(error);
    }
    const evidence = native.status === 'configured_only'
      ? { status: 'configured_only', method: native.discovery, source: 'configured', stale: false }
      : failureEvidence(native, nowMs);
    return mergeRows({ target, registry, configured, native, evidence, stale: false });
  }

  const scope = modelDiscoveryScope(target, registry);
  const scopeKey = canonicalHash(scope);
  let installation = null;
  let identityFingerprint = null;
  let cacheKey = null;
  let cached = null;
  let cacheErrorCode = null;

  if (cacheStore && typeof resolveInstallation === 'function') {
    try {
      installation = await resolveInstallation(target);
      identityFingerprint = installationFingerprint(installation);
      cacheKey = canonicalHash({ version: 1, target, identity_fingerprint: identityFingerprint, scope_key: scopeKey });
    } catch (error) {
      const native = failedDiscovery(error);
      return mergeRows({
        target,
        registry,
        configured,
        native,
        evidence: failureEvidence(native, nowMs, { stage: 'installation' }),
        stale: false,
      });
    }
    try {
      cached = cacheStore.getModelDiscovery(cacheKey);
    } catch (error) {
      cacheErrorCode = errorCode(error, 'model_cache_read_failed');
    }
    if (cached && !refresh && isFresh(cached, nowMs, ttlMs)) {
      const native = cachedDiscovery(cached);
      return mergeRows({
        target,
        registry,
        configured,
        native,
        evidence: cacheEvidence(cached, nowMs, ttlMs, { cacheErrorCode }),
        stale: false,
      });
    }
  }

  const attemptStartedAtMs = nowMs;
  let native;
  try {
    native = normalizeDiscovery(await adapter.discoverModels({
      registry,
      verifiedEntry: installation?.canonical_path ?? null,
    }));
  } catch (error) {
    native = failedDiscovery(error);
  }

  if (native.status === 'ok') {
    const observedAtMs = clock();
    if (cacheStore && cacheKey) {
      try {
        cacheStore.upsertModelDiscovery(cacheKey, {
          target,
          identity_fingerprint: identityFingerprint,
          scope_key: scopeKey,
          observed_at_ms: observedAtMs,
          attempt_started_at_ms: attemptStartedAtMs,
          discovery_method: native.discovery,
          models: native.models,
        });
      } catch (error) {
        cacheErrorCode = errorCode(error, 'model_cache_write_failed');
      }
    }
    return mergeRows({
      target,
      registry,
      configured,
      native,
      evidence: nativeEvidence(native, observedAtMs, ttlMs, attemptStartedAtMs, { cacheErrorCode }),
      stale: false,
    });
  }

  if (cached) {
    const staleNative = cachedDiscovery(cached);
    return mergeRows({
      target,
      registry,
      configured,
      native: staleNative,
      evidence: cacheEvidence(cached, nowMs, ttlMs, {
        stale: true,
        lastAttemptAtMs: attemptStartedAtMs,
        refreshError: {
          code: native.error_code ?? 'model_discovery_failed',
          stage: 'native_discovery',
          retryable: true,
        },
        cacheErrorCode,
      }),
      stale: true,
    });
  }

  return mergeRows({
    target,
    registry,
    configured,
    native,
    evidence: failureEvidence(native, attemptStartedAtMs, { cacheErrorCode }),
    stale: false,
  });
}

function mergeRows({ target, registry, configured, native, evidence, stale }) {
  const matched = new Set();
  const hasSnapshot = native.status === 'ok';
  const rows = configured.map(([selector, model]) => {
    const matchIndex = hasSnapshot ? findNativeModel(native.models, model) : -1;
    if (matchIndex >= 0) matched.add(matchIndex);
    const discovered = hasSnapshot ? matchIndex >= 0 : null;
    return {
      ...model,
      selector,
      default: registry.defaults[target] === selector,
      configured: true,
      admission_allowed: true,
      discovered,
      usable: discovered === null || stale ? null : discovered,
      provider_availability: 'unconfirmed',
      discovery: evidence,
    };
  });

  if (!hasSnapshot) return rows;
  native.models.forEach((model, index) => {
    if (matched.has(index)) return;
    const admissionAllowed = nativeAdmissionAllowed(registry, target, model);
    rows.push({
      target,
      model: model.id ?? null,
      route_id: model.route_id ?? null,
      selector: null,
      default: false,
      provider: model.provider ?? target,
      kind: 'native_discovered',
      enabled: false,
      opt_in: false,
      configured: false,
      admission_allowed: admissionAllowed,
      discovered: true,
      usable: stale ? null : admissionAllowed,
      provider_availability: 'unconfirmed',
      discovery: evidence,
    });
  });
  return rows;
}

function normalizeDiscovery(value) {
  if (!value || typeof value !== 'object') {
    return { status: 'failed', discovery: 'unknown', error_code: 'invalid_discovery_result', models: [] };
  }
  const status = value.status ?? (value.discovery === 'configured' ? 'configured_only' : 'ok');
  return {
    status,
    discovery: value.discovery ?? 'unknown',
    ...(value.error_code ? { error_code: value.error_code } : {}),
    models: Array.isArray(value.models) ? value.models : [],
  };
}

function failedDiscovery(error) {
  return {
    status: 'failed',
    discovery: 'native_cli',
    error_code: errorCode(error, 'model_discovery_failed'),
    models: [],
  };
}

function cachedDiscovery(cached) {
  return {
    status: 'ok',
    discovery: cached.discovery_method ?? 'native_cli',
    models: Array.isArray(cached.models) ? cached.models : [],
  };
}

function findNativeModel(models, configured) {
  if (configured.kind === 'backend_default') {
    return models.findIndex(model => model.id === 'auto' || model.route_id === configured.route_id);
  }
  return models.findIndex(model => model.route_id === configured.route_id ||
    (model.id === configured.model && model.provider === configured.provider));
}

function nativeAdmissionAllowed(registry, target, model) {
  const selector = target === 'opencode' ? model.route_id : model.id;
  if (typeof selector !== 'string' || !selector) return false;
  try {
    resolveModel(registry, target, selector);
    return true;
  } catch (error) {
    if (error?.code === 'model_unavailable') return false;
    throw error;
  }
}

function installationFingerprint(installation) {
  return canonicalHash({
    canonical_path: installation?.canonical_path ?? null,
    sha256: installation?.sha256 ?? null,
    size: installation?.size ?? null,
    mtime: installation?.mtime ?? null,
    file_version: installation?.file_version ?? null,
    verifier_version: installation?.verifier_version ?? null,
  });
}

function isFresh(cached, nowMs, ttlMs) {
  return Number.isSafeInteger(cached?.observed_at_ms) &&
    cached.observed_at_ms <= nowMs &&
    nowMs - cached.observed_at_ms < ttlMs;
}

function nativeEvidence(native, observedAtMs, ttlMs, lastAttemptAtMs, { cacheErrorCode = null } = {}) {
  return {
    status: 'ok',
    method: native.discovery,
    source: 'native',
    observed_at_ms: observedAtMs,
    expires_at_ms: observedAtMs + ttlMs,
    age_ms: 0,
    stale: false,
    last_attempt_at_ms: lastAttemptAtMs,
    ...(cacheErrorCode ? { cache_error_code: cacheErrorCode } : {}),
  };
}

function cacheEvidence(cached, nowMs, ttlMs, {
  stale = false,
  lastAttemptAtMs = null,
  refreshError = null,
  cacheErrorCode = null,
} = {}) {
  const observedAtMs = Number(cached.observed_at_ms);
  return {
    status: stale ? 'stale' : 'ok',
    method: cached.discovery_method ?? 'native_cli',
    source: 'cache',
    observed_at_ms: observedAtMs,
    expires_at_ms: observedAtMs + ttlMs,
    age_ms: Math.max(0, nowMs - observedAtMs),
    stale,
    ...(lastAttemptAtMs !== null ? { last_attempt_at_ms: lastAttemptAtMs } : {}),
    ...(refreshError ? { refresh_error: refreshError } : {}),
    ...(cacheErrorCode ? { cache_error_code: cacheErrorCode } : {}),
  };
}

function failureEvidence(native, lastAttemptAtMs, {
  stage = 'native_discovery',
  cacheErrorCode = null,
} = {}) {
  return {
    status: 'failed',
    method: native.discovery,
    source: 'native',
    stale: false,
    last_attempt_at_ms: lastAttemptAtMs,
    error_code: native.error_code ?? 'model_discovery_failed',
    error_stage: stage,
    ...(cacheErrorCode ? { cache_error_code: cacheErrorCode } : {}),
  };
}

function errorCode(error, fallback) {
  return typeof error?.code === 'string' && error.code ? error.code : fallback;
}
