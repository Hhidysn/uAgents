const SENSITIVE_KEY_PATTERN = /^(authorization|cookie|set-cookie|api[-_]?key|token|access[-_]?token|refresh[-_]?token|client[-_]?secret|password|private[-_]?key)$/i;
const HOST_FORBIDDEN_KEY_PATTERN = /prompt|token|secret|password|cookie|authorization/i;

export function isSensitiveKeyName(key) {
  return typeof key === 'string' && SENSITIVE_KEY_PATTERN.test(key);
}

export function isHostForbiddenKeyName(key) {
  return isSensitiveKeyName(key) || (typeof key === 'string' && HOST_FORBIDDEN_KEY_PATTERN.test(key));
}
