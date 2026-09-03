import { fail } from '../protocol/errors.mjs';

const REQUIRED_METHODS = ['descriptor', 'discoverModels', 'probe', 'prepare', 'dispatch', 'observe'];

export function validateAdapter(adapter) {
  for (const method of REQUIRED_METHODS) if (typeof adapter?.[method] !== 'function') fail('invalid_adapter', `Adapter must implement ${method}().`);
  const descriptor = adapter.descriptor();
  if (!descriptor || typeof descriptor !== 'object' || typeof descriptor.target !== 'string') fail('invalid_adapter', 'Adapter descriptor must identify its target.');
  if ('available' in descriptor) fail('invalid_adapter', 'Static descriptor cannot contain dynamic availability.');
  if (!Array.isArray(descriptor.modes) || !descriptor.permissions || !descriptor.model_identity) fail('invalid_adapter', 'Adapter descriptor is incomplete.');
  return descriptor;
}

export async function assertPrepareHasNoSend(adapter, request, context = {}) {
  const before = Number(adapter.sendCount ?? 0);
  const prepared = await adapter.prepare(request, context);
  if (Number(adapter.sendCount ?? 0) !== before) fail('adapter_contract_violation', 'prepare() performed an external send.');
  return prepared;
}
