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

test('all states reject unspecified transitions', () => {
  assert.deepEqual(TASK_STATES, ['registered', 'queued', 'starting', 'running', 'waiting_user', 'indeterminate', 'succeeded', 'failed', 'cancelled']);
  assert.throws(() => transitionState({ status: 'registered' }, 'running'), { code: 'invalid_state_transition' });
  assert.throws(() => transitionState({ status: 'queued' }, 'succeeded'), { code: 'invalid_state_transition' });
  assert.equal(transitionState({ status: 'starting' }, 'failed').status, 'failed');
});
