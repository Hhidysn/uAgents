import { randomUUID } from 'node:crypto';
import { fail } from '../protocol/errors.mjs';
import { canonicalWorkspace, canonicalWorkspacesOverlap } from './workspace-key.mjs';

const DEFAULT_TARGET_LIMITS = Object.freeze({ agy: 2, opencode: 2, workbuddy: 1, doubao: 1, trae: 1 });

export function acquireExecutionLeases(control, { target, workspace, ownerNonce = randomUUID(), ttlMs = 30_000, now = Date.now(), globalLimit = 4, targetLimits = DEFAULT_TARGET_LIMITS }) {
  return control.transaction(database => {
    const leases = [];
    leases.push(acquireSlot(database, 'global', 'global', globalLimit, ownerNonce, ttlMs, now));
    leases.push(acquireSlot(database, `target:${target}`, 'target', targetLimits[target] ?? 1, ownerNonce, ttlMs, now));
    if (workspace) {
      const canonical = canonicalWorkspace(workspace);
      const rows = database.prepare('SELECT * FROM leases WHERE resource_type = ? AND expires_at_ms > ?').all('workspace', now);
      const conflict = rows.find(row => canonicalWorkspacesOverlap(JSON.parse(row.metadata_json).workspace, canonical) && row.owner_nonce !== ownerNonce);
      if (conflict) fail('lease_conflict', 'An overlapping workspace is already leased.', { category: 'conflict', submission: 'not_sent', details: { resource_key: conflict.resource_key } });
      leases.push(acquireLeaseRow(database, `workspace:${canonical}`, 'workspace', ownerNonce, ttlMs, now, { workspace: canonical }));
    }
    return leases;
  });
}

export function renewLeases(control, leases, { ttlMs = 30_000, now = Date.now() } = {}) {
  return control.transaction(database => leases.map(lease => {
    const result = database.prepare('UPDATE leases SET expires_at_ms = ? WHERE resource_key = ? AND owner_nonce = ? AND fencing_token = ? AND epoch = ?')
      .run(now + ttlMs, lease.resource_key, lease.owner_nonce, lease.fencing_token, lease.epoch);
    if (Number(result.changes) !== 1) fail('lease_conflict', `Lease ownership was lost: ${lease.resource_key}`, { category: 'conflict', submission: 'may_have_been_sent' });
    return { ...lease, expires_at_ms: now + ttlMs };
  }));
}

export function releaseLeases(control, leases) {
  return control.transaction(database => {
    for (const lease of [...leases].reverse()) {
      database.prepare('DELETE FROM leases WHERE resource_key = ? AND owner_nonce = ? AND fencing_token = ? AND epoch = ?')
        .run(lease.resource_key, lease.owner_nonce, lease.fencing_token, lease.epoch);
    }
  });
}

export function assertFencing(database, lease, now = Date.now()) {
  const row = database.prepare('SELECT owner_nonce, epoch, fencing_token, expires_at_ms FROM leases WHERE resource_key = ?').get(lease.resource_key);
  if (!row || row.owner_nonce !== lease.owner_nonce || Number(row.epoch) !== lease.epoch || row.fencing_token !== lease.fencing_token || Number(row.expires_at_ms) <= now) {
    fail('lease_conflict', `Stale fencing token for ${lease.resource_key}.`, { category: 'conflict', submission: 'may_have_been_sent' });
  }
  return true;
}

function acquireSlot(database, prefix, resourceType, limit, ownerNonce, ttlMs, now) {
  for (let slot = 1; slot <= limit; slot++) {
    const key = `${prefix}:${slot}`;
    const row = database.prepare('SELECT owner_nonce, expires_at_ms FROM leases WHERE resource_key = ?').get(key);
    if (!row || row.owner_nonce === ownerNonce || Number(row.expires_at_ms) <= now) return acquireLeaseRow(database, key, resourceType, ownerNonce, ttlMs, now, { slot });
  }
  fail('lease_conflict', `No ${resourceType} concurrency slot is available.`, { category: 'conflict', submission: 'not_sent' });
}

export function acquireLeaseRow(database, resourceKey, resourceType, ownerNonce, ttlMs, now, metadata) {
  const current = database.prepare('SELECT epoch, owner_nonce, expires_at_ms FROM leases WHERE resource_key = ?').get(resourceKey);
  if (current && current.owner_nonce !== ownerNonce && Number(current.expires_at_ms) > now) {
    fail('lease_conflict', `Resource is already leased: ${resourceKey}`, { category: 'conflict', submission: 'not_sent' });
  }
  const epoch = Number(current?.epoch ?? 0) + 1;
  const fencingToken = randomUUID();
  database.prepare(`
    INSERT INTO leases(resource_key, resource_type, owner_nonce, epoch, fencing_token, expires_at_ms, metadata_json)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(resource_key) DO UPDATE SET
      resource_type=excluded.resource_type, owner_nonce=excluded.owner_nonce, epoch=excluded.epoch,
      fencing_token=excluded.fencing_token, expires_at_ms=excluded.expires_at_ms, metadata_json=excluded.metadata_json
  `).run(resourceKey, resourceType, ownerNonce, epoch, fencingToken, now + ttlMs, JSON.stringify(metadata));
  return { resource_key: resourceKey, resource_type: resourceType, owner_nonce: ownerNonce, epoch, fencing_token: fencingToken, expires_at_ms: now + ttlMs };
}
