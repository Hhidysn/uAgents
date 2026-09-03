import { parseRequest } from '../protocol/schema.mjs';
import { fail } from '../protocol/errors.mjs';
import { createRegistry, targetDescriptor } from '../registry/registry.mjs';
import { resolveModel } from './models.mjs';
import { requirePermission } from './permissions.mjs';

export function evaluateRequest(input, options = {}) {
  const request = parseRequest(input);
  const registry = options.registry ?? createRegistry();
  const descriptor = targetDescriptor(registry, request.target);
  validateTargetCapabilities(request, descriptor);
  const model = resolveModel(registry, request.target, request.model);
  validateRouteHealth(model, options.health ?? null);
  requirePermission(descriptor, request.execution.permission);
  validatePolicy(request, descriptor);
  validateWorkspace(request);

  const warnings = [];
  const health = options.health?.get?.(model.route_id) ?? options.health?.[model.route_id] ?? null;
  if (!health || health.availability === 'unknown' || health.stale) warnings.push('model_availability_unconfirmed');
  return {
    allowed: true,
    request: {
      ...request,
      model_requested: model.model_requested,
      model_resolved: model.model_resolved,
      model_reported: null,
      model_verified: false,
      provider: model.provider,
      route_id: model.route_id,
      model_resolution: model.model_resolution,
      model_verification: { status: 'unverified', assurance: 'none', match: null, method: null, evidence_ref: null },
    },
    decision: {
      schema_version: request.schema_version,
      target: request.target,
      route_id: model.route_id,
      registry_version: registry.version,
      permission: request.execution.permission,
      fallback: request.policy.fallback,
      warnings,
    },
  };
}

function validateTargetCapabilities(request, descriptor) {
  if (!descriptor.modes.includes(request.mode)) fail('unsupported_capability', `Target ${request.target} does not support mode ${request.mode}.`, { category: 'policy', submission: 'not_sent' });
  if (!descriptor.inputs.text) fail('unsupported_capability', 'Target does not support text input.', { category: 'policy', submission: 'not_sent' });
  if (request.inputs.length && !descriptor.inputs.files) fail('unsupported_capability', 'Target does not support file inputs.', { category: 'policy', submission: 'not_sent' });
  if (request.expected_outputs.length && !descriptor.outputs.files) fail('unsupported_capability', 'Target does not support file outputs.', { category: 'policy', submission: 'not_sent' });
}

function validateRouteHealth(model, source) {
  const health = source?.get?.(model.route_id) ?? source?.[model.route_id] ?? null;
  if (health?.availability === 'unavailable' && health.stale !== true) {
    fail('model_unavailable', `Model route is currently unavailable: ${model.route_id}`, { category: 'policy', submission: 'not_sent' });
  }
}

function validatePolicy(request, descriptor) {
  if (request.policy.fallback !== 'none') fail('unsupported_capability', 'Only fallback=none is supported.', { category: 'policy', submission: 'not_sent' });
  if (request.policy.max_cost_usd !== null) fail('unsupported_capability', 'max_cost_usd cannot be enforced by this release.', { category: 'policy', submission: 'not_sent' });
  if (request.execution.execution_timeout_ms !== null && descriptor.execution_timeout !== true) {
    fail('unsupported_capability', 'The target cannot enforce a native execution timeout.', { category: 'policy', submission: 'not_sent' });
  }
}

function validateWorkspace(request) {
  if (request.inputs.length && !request.workspace) {
    fail('invalid_workspace', 'workspace is required for file inputs.', { category: 'user', submission: 'not_sent' });
  }
}
