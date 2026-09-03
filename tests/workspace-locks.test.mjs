import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { ControlDatabase } from '../plugins/uagents/src/store/database.mjs';
import { acquireExecutionLeases, assertFencing, releaseLeases } from '../plugins/uagents/src/runtime/leases.mjs';
import { workspacesOverlap } from '../plugins/uagents/src/runtime/workspace-key.mjs';

const root = path.resolve('.local', 'test-runs', randomUUID(), 'lease store');
const parent = path.join(root, 'Repo');
const child = path.join(parent, 'src');
fs.mkdirSync(child, { recursive: true });

test('parent and child workspaces conflict across owners', () => {
  assert.equal(workspacesOverlap(parent, child), true);
  const control = new ControlDatabase(path.join(root, 'control'));
  try {
    const first = acquireExecutionLeases(control, { target: 'agy', workspace: parent, ownerNonce: 'owner-a', now: 1000 });
    assert.deepEqual(first.map(lease => lease.resource_type), ['global', 'target', 'workspace']);
    assert.throws(() => acquireExecutionLeases(control, { target: 'agy', workspace: child, ownerNonce: 'owner-b', now: 1001 }), { code: 'lease_conflict' });
    releaseLeases(control, first);
    const second = acquireExecutionLeases(control, { target: 'agy', workspace: child, ownerNonce: 'owner-b', now: 1002 });
    releaseLeases(control, second);
  } finally { control.close(); }
});

test('expired lease takeover fences the old owner', () => {
  const control = new ControlDatabase(path.join(root, 'fencing'));
  try {
    const oldLeases = acquireExecutionLeases(control, { target: 'opencode', workspace: parent, ownerNonce: 'old', ttlMs: 10, now: 1000 });
    const newer = acquireExecutionLeases(control, { target: 'opencode', workspace: parent, ownerNonce: 'new', ttlMs: 1000, now: 1011 });
    assert.throws(() => assertFencing(control.raw, oldLeases[0], 1011), { code: 'lease_conflict' });
    assert.equal(assertFencing(control.raw, newer[0], 1011), true);
    releaseLeases(control, newer);
  } finally { control.close(); }
});
