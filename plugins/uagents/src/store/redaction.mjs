import { redactText } from '../protocol/errors.mjs';

const SENSITIVE_KEYS = /^(authorization|cookie|set-cookie|api[-_]?key|token|access[-_]?token|refresh[-_]?token|client[-_]?secret|password|private[-_]?key)$/i;

export function redactValue(value, seen = new WeakSet()) {
  if (typeof value === 'string') return redactText(value);
  if (value === null || typeof value !== 'object') return value;
  if (seen.has(value)) return '[CIRCULAR]';
  seen.add(value);
  if (Array.isArray(value)) return value.map(item => redactValue(item, seen));
  const result = {};
  for (const [key, item] of Object.entries(value)) result[key] = SENSITIVE_KEYS.test(key) ? '[REDACTED]' : redactValue(item, seen);
  return result;
}
