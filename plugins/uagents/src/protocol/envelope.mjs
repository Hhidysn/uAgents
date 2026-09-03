import { errorRecord } from './errors.mjs';

export function ok(data, warnings = []) {
  return { ok: true, data, error: null, warnings: [...warnings] };
}

export function notOk(error, warnings = [], schemaVersion = '1.0') {
  return { ok: false, data: null, error: errorRecord(error, schemaVersion), warnings: [...warnings] };
}
