import test from 'node:test';
import assert from 'node:assert/strict';
import { TASK_STATES, TERMINAL_STATES, transitionState } from '../plugins/uagents/src/runtime/state-machine.mjs';

test('normal lifecycle and waiting-user recovery are explicit', () => {
  let state = { status: 'registered' };
  for (const next of ['queued', 'starting', 'running', 'waiting_user', 'running', 'succeeded']) state = transitionState(state, next);
  assert.equal(state.status, 'succeeded');
  assert.equal(TERMINAL_STATES.has(state.status), true);
  assert.throws(() => transitionState(state, 'running'), { code: 'invalid_state_transition' });
});

test('indeterminate refinement requires the same identity and stronger evidence', () => {
  const uncertain = transitionState({ status: 'running', evidence_strength: 1 }, 'indeterminate');
  assert.throws(() => transitionState(uncertain, 'succeeded', { same_native_identity: false, evidence_strength: 3 }), { code: 'native_session_mismatch' });
  assert.throws(() => transitionState(uncertain, 'succeeded', { same_native_identity: true, evidence_strength: 1 }), { code: 'insufficient_evidence' });
  assert.equal(transitionState(uncertain, 'succeeded', { same_native_identity: true, evidence_strength: 3 }).status, 'succeeded');
});

test('preflight waiting edges allow starting to wait and waiting to requeue', () => {
  let state = transitionState({ status: 'registered' }, 'queued');
  state = transitionState(state, 'starting');
  state = transitionState(state, 'waiting_user');
  assert.equal(state.status, 'waiting_user');
  state = transitionState(state, 'queued');
  assert.equal(state.status, 'queued');
  assert.equal(transitionState(state, 'starting').status, 'starting');
});

test('starting keeps its existing edges and rejects direct dispatch or success', () => {
  assert.throws(() => transitionState({ status: 'starting' }, 'queued'), { code: 'invalid_state_transition' });
  assert.throws(() => transitionState({ status: 'starting' }, 'succeeded'), { code: 'invalid_state_transition' });
  assert.throws(() => transitionState({ status: 'registered' }, 'waiting_user'), { code: 'invalid_state_transition' });
  assert.throws(() => transitionState({ status: 'queued' }, 'waiting_user'), { code: 'invalid_state_transition' });
});

test('all states reject unspecified transitions', () => {
  assert.deepEqual(TASK_STATES, ['registered', 'queued', 'starting', 'running', 'waiting_user', 'indeterminate', 'succeeded', 'failed', 'cancelled']);
  assert.throws(() => transitionState({ status: 'registered' }, 'running'), { code: 'invalid_state_transition' });
  assert.throws(() => transitionState({ status: 'queued' }, 'succeeded'), { code: 'invalid_state_transition' });
  assert.equal(transitionState({ status: 'starting' }, 'failed').status, 'failed');
});
