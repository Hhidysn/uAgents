import { fail } from '../protocol/errors.mjs';

const AVAILABILITY = new Set(['available', 'unavailable', 'unknown']);

export class HealthCache {
  #clock;
  #values = new Map();

  constructor({ clock = () => Date.now() } = {}) {
    this.#clock = clock;
  }

  set(key, snapshot) {
    if (!AVAILABILITY.has(snapshot?.availability)) fail('invalid_request', 'Health availability is invalid.');
    if (typeof snapshot.source !== 'string' || !snapshot.source) fail('invalid_request', 'Health source is required.');
    const observed = timestamp(snapshot.observed_at, 'observed_at');
    const expires = timestamp(snapshot.expires_at, 'expires_at');
    if (expires < observed) fail('invalid_request', 'Health expiry cannot precede observation time.');
    const value = Object.freeze({ availability: snapshot.availability, source: snapshot.source, observed_at: new Date(observed).toISOString(), expires_at: new Date(expires).toISOString(), details: snapshot.details ?? {} });
    this.#values.set(key, value);
    return value;
  }

  get(key) {
    const value = this.#values.get(key);
    if (!value) return null;
    if (Date.parse(value.expires_at) <= this.#clock()) return { ...value, availability: 'unknown', stale: true };
    return value;
  }

  delete(key) { return this.#values.delete(key); }
}

function timestamp(value, label) {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) fail('invalid_request', `Health ${label} must be an RFC3339 timestamp.`);
  return parsed;
}
