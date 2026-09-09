import { redactText } from '../protocol/errors.mjs';
import { isSensitiveKeyName } from '../sensitive-fields.mjs';

function redactValue(value, seen = new WeakSet()) {
  if (typeof value === 'string') return redactText(value);
  if (value === null || typeof value !== 'object') return value;
  if (seen.has(value)) return '[CIRCULAR]';
  seen.add(value);
  if (Array.isArray(value)) return value.map(item => redactValue(item, seen));
  const result = {};
  for (const [key, item] of Object.entries(value)) result[key] = isSensitiveKeyName(key) ? '[REDACTED]' : redactValue(item, seen);
  return result;
}
