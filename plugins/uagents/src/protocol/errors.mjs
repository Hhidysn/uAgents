const CATEGORY_BY_CODE = new Map([
  ['invalid_request', 'user'],
  ['unsupported_field', 'user'],
  ['unsupported_schema_version', 'user'],
  ['invalid_request_id', 'user'],
  ['invalid_target', 'user'],
  ['invalid_model', 'user'],
  ['invalid_workspace', 'user'],
  ['invalid_input', 'user'],
  ['invalid_output', 'user'],
  ['unsupported_capability', 'policy'],
  ['model_unavailable', 'policy'],
  ['permission_required', 'policy'],
  ['request_conflict', 'conflict'],
  ['input_changed', 'conflict'],
  ['lease_conflict', 'conflict'],
  ['target_not_ready', 'target'],
  ['authentication_required', 'target'],
  ['quota_exhausted', 'target'],
  ['submission_unknown', 'transport'],
  ['native_session_mismatch', 'transport'],
  ['output_verification_failed', 'runtime'],
  ['incompatible_store_version', 'runtime'],
  ['store_migration_blocked', 'runtime'],
  ['installation_not_found', 'target'],
  ['installation_untrusted', 'target'],
  ['installation_changed', 'target'],
  ['launch_failed', 'target'],
  ['launch_timeout', 'target'],
  ['profile_locked', 'target'],
  ['port_unavailable', 'target'],
  ['port_identity_mismatch', 'target'],
  ['managed_instance_identity_mismatch', 'target'],
  ['target_login_required', 'user'],
  ['gateway_launch_failed', 'target'],
  ['gateway_identity_mismatch', 'target'],
  ['resume_not_allowed', 'conflict'],
  ['stop_not_owned', 'conflict'],
]);

const RETRYABLE_BY_CODE = new Map([
  ['installation_not_found', true],
  ['installation_untrusted', false],
  ['installation_changed', true],
  ['launch_failed', true],
  ['launch_timeout', true],
  ['profile_locked', true],
  ['port_unavailable', true],
  ['port_identity_mismatch', true],
  ['managed_instance_identity_mismatch', true],
  ['target_login_required', true],
  ['gateway_launch_failed', true],
  ['gateway_identity_mismatch', true],
  ['resume_not_allowed', false],
  ['stop_not_owned', false],
  ['store_migration_blocked', true],
]);

const TRANSPORT_CODE_MAP = new Map([
  ['cdp_unavailable', 'target_not_ready'],
  ['gateway_unavailable', 'target_not_ready'],
]);

const SECRET_PATTERNS = [
  /(authorization\s*[:=]\s*)(?:bearer\s+)?[^\s,;]+/gi,
  /((?:api[-_]?key|token|cookie|client[-_]?secret|password)\s*[:=]\s*)[^\s,;]+/gi,
  /-----BEGIN [^-]+ PRIVATE KEY-----[\s\S]*?-----END [^-]+ PRIVATE KEY-----/g,
];

export class UAgentsError extends Error {
  constructor(code, message, options = {}) {
    super(message, options.cause ? { cause: options.cause } : undefined);
    this.name = 'UAgentsError';
    this.code = code;
    this.category = options.category ?? CATEGORY_BY_CODE.get(code) ?? 'runtime';
    this.retryable = options.retryable ?? RETRYABLE_BY_CODE.get(code) ?? false;
    this.submission = options.submission ?? 'not_sent';
    this.details = options.details ?? null;
  }
}

export function fail(code, message, options) {
  throw new UAgentsError(code, message, options);
}

export function redactText(value) {
  let text = String(value ?? '');
  for (const pattern of SECRET_PATTERNS) text = text.replace(pattern, match => {
    const separator = match.match(/^.*?[:=]\s*/)?.[0] ?? '';
    return `${separator}[REDACTED]`;
  });
  return text;
}

export function normalizeError(error) {
  if (error instanceof UAgentsError) return error;
  const mapped = TRANSPORT_CODE_MAP.get(error?.code);
  if (mapped) {
    return new UAgentsError(mapped, error?.message || 'The target is not ready.', {
      category: 'target',
      retryable: false,
      submission: error?.submission ?? 'not_sent',
      details: { cause_code: error.code },
    });
  }
  return new UAgentsError('internal_error', 'The operation failed.', {
    category: 'runtime',
    retryable: false,
    submission: error?.submission ?? 'not_sent',
  });
}

export function errorRecord(error, schemaVersion = '1.0') {
  const normalized = normalizeError(error);
  return {
    code: normalized.code,
    category: normalized.category,
    message: redactText(normalized.message),
    retryable: Boolean(normalized.retryable),
    schema_version: schemaVersion,
    submission: normalized.submission,
    details: normalized.details,
  };
}
