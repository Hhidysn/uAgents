import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { ControlDatabase } from '../plugins/uagents/src/store/database.mjs';
import { TaskService } from '../plugins/uagents/src/runtime/task-service.mjs';
import { persistCheckpoint } from '../plugins/uagents/src/runtime/checkpoints.mjs';

const base = path.resolve('.local', 'test-runs', randomUUID(), 'durable checkpoints');
fs.mkdirSync(base, { recursive: true });

test('accepted checkpoint persists one identity and exact replay is idempotent', () => {
  fixture('accepted-replay', ({ control, service, taskId, attemptId }) => {
    persistCheckpoint(control, { taskId, attemptId, kind: 'possibly_sent', payload: { target: 'opencode' }, now: 100 });
    const payload = {
      target: 'opencode',
      handle: { session_id: 'ses-fixture', task_id: null, status: 'accepted' },
      evidence_ref: 'fixture:session',
    };
    const first = persistCheckpoint(control, { taskId, attemptId, kind: 'accepted', payload, now: 110 });
    const replay = persistCheckpoint(control, { taskId, attemptId, kind: 'accepted', payload, now: 120 });

    assert.equal(first.replayed, undefined);
    assert.equal(replay.replayed, true);
    assert.equal(replay.sequence, first.sequence);
    assert.equal(service.status(taskId).status, 'running');
    assert.equal(service.status(taskId).attempt.submission, 'sent');
    assert.equal(Number(control.raw.prepare('SELECT count(*) AS count FROM native_sessions WHERE attempt_id = ?').get(attemptId).count), 1);
    assert.equal(service.events(taskId).filter(event => event.type === 'dispatch.accepted').length, 1);
  });
});

test('accepted replay with conflicting native identity fails closed', () => {
  fixture('accepted-conflict', ({ control, taskId, attemptId }) => {
    persistCheckpoint(control, { taskId, attemptId, kind: 'possibly_sent', payload: { target: 'opencode' } });
    persistCheckpoint(control, {
      taskId, attemptId, kind: 'accepted',
      payload: { target: 'opencode', handle: { session_id: 'ses-one', task_id: null } },
    });
    assert.throws(() => persistCheckpoint(control, {
      taskId, attemptId, kind: 'accepted',
      payload: { target: 'opencode', handle: { session_id: 'ses-two', task_id: null } },
    }), { code: 'native_session_mismatch', submission: 'sent' });
    assert.equal(Number(control.raw.prepare('SELECT count(*) AS count FROM native_sessions WHERE attempt_id = ?').get(attemptId).count), 1);
  });
});

test('accepted checkpoint cannot bind a native identity from another target', () => {
  fixture('accepted-target-conflict', ({ control, service, taskId, attemptId }) => {
    persistCheckpoint(control, { taskId, attemptId, kind: 'possibly_sent', payload: { target: 'opencode' } });
    assert.throws(() => persistCheckpoint(control, {
      taskId, attemptId, kind: 'accepted',
      payload: { target: 'trae', handle: { session_id: 'foreign-session', task_id: null } },
    }), { code: 'native_session_mismatch', submission: 'may_have_been_sent' });
    assert.equal(service.status(taskId).attempt.submission, 'may_have_been_sent');
    assert.equal(service.status(taskId).native, null);
  });
});

test('first accepted identity discovered during recovery does not overwrite indeterminate task state', () => {
  fixture('accepted-indeterminate', ({ control, service, taskId, attemptId }) => {
    persistCheckpoint(control, { taskId, attemptId, kind: 'possibly_sent', payload: { target: 'opencode' } });
    service.transition(taskId, 'indeterminate', { attemptId, evidenceStrength: 1 });
    const before = service.status(taskId);
    assert.equal(before.status, 'indeterminate');
    assert.equal(before.attempt.submission, 'may_have_been_sent');

    persistCheckpoint(control, {
      taskId, attemptId, kind: 'accepted',
      payload: { target: 'opencode', handle: { session_id: 'ses-recovered', task_id: null } },
    });
    const after = service.status(taskId);
    assert.equal(after.status, 'indeterminate');
    assert.equal(after.attempt.submission, 'sent');
    assert.equal(after.native.session_id, 'ses-recovered');
  });
});

test('possibly_sent remains an irreversible one-shot checkpoint', () => {
  fixture('possibly-sent-once', ({ control, service, taskId, attemptId }) => {
    persistCheckpoint(control, { taskId, attemptId, kind: 'possibly_sent', payload: { target: 'opencode' } });
    assert.throws(() => persistCheckpoint(control, {
      taskId, attemptId, kind: 'possibly_sent', payload: { target: 'opencode' },
    }), { code: 'invalid_state_transition' });
    assert.equal(service.status(taskId).attempt.submission, 'may_have_been_sent');
  });
});

function fixture(name, operation) {
  const control = new ControlDatabase(path.join(base, `${name}-${randomUUID()}`));
  try {
    const service = new TaskService(control);
    const registered = service.submit({
      schema_version: '1.0', request_id: randomUUID(), target: 'opencode',
      model: 'commandcode-goat/deepseek/deepseek-v4-flash', mode: 'implementation', prompt: 'fixture',
      execution: { observation_timeout_ms: 10_000, effort: 'medium', permission: 'native' },
      policy: { fallback: 'none', max_cost_usd: null },
    }, { adapterVersion: 'fixture-adapter' });
    const taskId = registered.task_id;
    const attemptId = registered.attempt.attempt_id;
    service.transition(taskId, 'queued', { attemptId });
    service.transition(taskId, 'starting', { attemptId });
    operation({ control, service, taskId, attemptId });
  } finally {
    control.close();
  }
}
