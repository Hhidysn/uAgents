import { DatabaseSync } from 'node:sqlite';
import { statSync } from 'node:fs';
import path from 'node:path';

const MODEL_KEY_SUFFIX = 'AI.agent.model.model_list_map';

// TRAE's own user-profile cache is only a hint about the personal session.
// Read one specific record and retain only model identifiers and labels;
// the record also contains provider credentials and must never be returned.
export function readTraeLocalModelCache({
  env = process.env,
  databasePath = env.APPDATA ? path.join(env.APPDATA, 'Trae CN', 'User', 'globalStorage', 'state.vscdb') : null,
} = {}) {
  if (!databasePath) return null;
  let database;
  try {
    const snapshotFileMtimeMs = Math.trunc(statSync(databasePath).mtimeMs);
    database = new DatabaseSync(databasePath, { readOnly: true });
    const matches = database.prepare('SELECT key, value FROM ItemTable WHERE key GLOB ? LIMIT 2')
      .all(`*${MODEL_KEY_SUFFIX}`);
    // Multiple account-qualified records cannot be attributed to the active
    // user without a verified native identity.
    if (matches.length !== 1 || typeof matches[0].value !== 'string' ||
        Buffer.byteLength(matches[0].value) > 2_000_000) return null;
    const catalog = JSON.parse(matches[0].value);
    if (!Array.isArray(catalog?.solo_agent)) return null;
    const seen = new Set();
    const models = [];
    for (const entry of catalog.solo_agent) {
      if (entry?.status !== true || entry?.selectable !== true) continue;
      const id = entry.name;
      const selector = entry.display_name;
      if (!validLabel(id) || !validLabel(selector) || seen.has(selector)) continue;
      seen.add(selector);
      models.push({ id, selector, route_id: `trae/${selector}`, provider: 'trae', kind: 'native_profile_cache' });
    }
    return models.length ? { models, snapshot_file_mtime_ms: snapshotFileMtimeMs } : null;
  } catch {
    return null;
  } finally {
    database?.close();
  }
}

function validLabel(value) {
  return typeof value === 'string' && value === value.trim() && value.length > 0 &&
    Buffer.byteLength(value) <= 256 && !/[\x00-\x1f\x7f]/.test(value);
}
