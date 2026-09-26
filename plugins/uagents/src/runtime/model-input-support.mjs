import { BUILTIN_REGISTRY } from '../registry/builtins.mjs';

// This is evidence about uAgents' native attachment route, not a provider
// model catalog. A newly discovered model inherits only its transport mapping.
const RECORDS = {
  codex: {
    images: { verification: 'transport_mapping', observed_on: '2026-09-26', evidence_ref: 'docs/verification/2026-09-26-native-attachment-input.md' },
  },
  claudeCode: {
    files: { verification: 'transport_mapping', observed_on: '2026-09-26', evidence_ref: 'docs/verification/2026-09-26-native-attachment-input.md' },
    images: { verification: 'transport_mapping', observed_on: '2026-09-26', evidence_ref: 'docs/verification/2026-09-26-native-attachment-input.md' },
  },
  workbuddy: {
    images: { verification: 'transport_mapping', observed_on: '2026-09-13', evidence_ref: 'docs/verification/2026-09-13-real-workbuddy-image-attachment-e2e.md' },
  },
  dsh: {
    images: { verification: 'transport_mapping', observed_on: '2026-09-26', evidence_ref: 'docs/verification/2026-09-26-native-attachment-input.md' },
  },
  opencode: {
    files: { verification: 'transport_mapping', observed_on: '2026-09-09', evidence_ref: 'docs/verification/2026-09-09-universal-attachment-input.md' },
    images: { verification: 'transport_mapping', observed_on: '2026-09-09', evidence_ref: 'docs/verification/2026-09-09-universal-attachment-input.md' },
  },
};

const ROUTE_RECORDS = {
  'codex/gpt-5.6-luna': {
    images: { verification: 'native_delivery', observed_on: '2026-09-26', evidence_ref: 'docs/verification/2026-09-26-native-attachment-input.md' },
  },
  'claudeCode/deepseek-v4-flash': {
    files: { verification: 'model_response', observed_on: '2026-09-26', evidence_ref: 'docs/verification/2026-09-26-native-attachment-input.md' },
    images: { verification: 'model_response', observed_on: '2026-09-26', evidence_ref: 'docs/verification/2026-09-26-native-attachment-input.md' },
  },
  'workbuddy-default': {
    files: { verification: 'native_rejection', observed_on: '2026-09-13', evidence_ref: 'docs/verification/2026-09-13-real-workbuddy-file-attachment-e2e.md' },
    images: { verification: 'native_rejection', observed_on: '2026-09-13', evidence_ref: 'docs/verification/2026-09-13-real-workbuddy-image-attachment-e2e.md' },
  },
  'workbuddy/deepseek-v4.1-flash': {
    images: { verification: 'model_response', observed_on: '2026-09-13', evidence_ref: 'docs/verification/2026-09-13-real-workbuddy-image-attachment-e2e.md' },
  },
  'deepseek-official/deepseek-flash': {
    images: { verification: 'indeterminate', observed_on: '2026-09-26', evidence_ref: 'docs/verification/2026-09-26-native-attachment-input.md' },
  },
};

export function modelInputSupport(target, descriptor, route) {
  const builtInIdentity = Object.values(BUILTIN_REGISTRY.models).some(model =>
    model.target === target && model.route_id === route?.route_id &&
    model.model === route?.model_resolved && model.provider === route?.provider);
  return Object.fromEntries(['files', 'images'].map(kind => {
    const allowed = Boolean(route && descriptor.inputs[kind] && (route.inputs?.[kind] ?? true));
    const evidence = (builtInIdentity ? ROUTE_RECORDS[route.route_id]?.[kind] : null) ?? RECORDS[target]?.[kind] ?? null;
    let verification = evidence?.verification ?? 'unmapped';
    let source = evidence ? 'verification_record' : 'registry';
    if (!route) { verification = 'model_unavailable'; source = 'registry'; }
    else if (!descriptor.inputs[kind] && BUILTIN_REGISTRY.targets[target].inputs[kind]) {
      verification = 'target_restriction'; source = 'registry';
    } else if (!descriptor.inputs[kind] && verification !== 'native_rejection') {
      verification = 'unmapped'; source = 'registry';
    } else if (descriptor.inputs[kind] && route.inputs?.[kind] === false && verification !== 'native_rejection') {
      verification = 'route_restriction'; source = 'registry';
    }
    const record = source === 'verification_record' ? evidence : null;
    return [kind, {
      allowed,
      verification,
      source,
      observed_on: record?.observed_on ?? null,
      evidence_ref: record?.evidence_ref ?? null,
      ...(allowed && descriptor.attachment_formats?.[kind] ? { formats: descriptor.attachment_formats[kind] } : {}),
    }];
  }));
}
