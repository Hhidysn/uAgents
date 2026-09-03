import { createHash } from 'node:crypto';
import { fail } from './errors.mjs';

export function canonicalize(value) {
  return encode(value, new Set());
}

export function canonicalJson(value) {
  return JSON.stringify(canonicalize(value));
}

export function canonicalHash(value) {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

function encode(value, stack) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail('invalid_request', 'Non-finite numbers are not valid JSON values.');
    return Object.is(value, -0) ? 0 : value;
  }
  if (Array.isArray(value)) {
    if (stack.has(value)) fail('invalid_request', 'Cyclic values cannot be canonicalized.');
    stack.add(value);
    const result = value.map(item => encode(item, stack));
    stack.delete(value);
    return result;
  }
  if (typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    if (stack.has(value)) fail('invalid_request', 'Cyclic values cannot be canonicalized.');
    stack.add(value);
    const result = {};
    for (const key of Object.keys(value).sort()) {
      const item = value[key];
      if (item === undefined || typeof item === 'function' || typeof item === 'symbol' || typeof item === 'bigint') {
        fail('invalid_request', `Unsupported JSON value at key: ${key}`);
      }
      result[key] = encode(item, stack);
    }
    stack.delete(value);
    return result;
  }
  fail('invalid_request', 'Only plain JSON objects can be canonicalized.');
}
