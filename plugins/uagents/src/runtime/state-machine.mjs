import { fail } from '../protocol/errors.mjs';

export const TASK_STATES = Object.freeze(['registered', 'queued', 'starting', 'running', 'waiting_user', 'indeterminate', 'succeeded', 'failed', 'cancelled']);
export const TERMINAL_STATES = new Set(['succeeded', 'failed', 'cancelled']);

const NORMAL_TRANSITIONS = new Map([
  ['registered', new Set(['queued', 'cancelled'])],
  ['queued', new Set(['starting', 'cancelled'])],
  ['starting', new Set(['running', 'waiting_user', 'cancelled', 'indeterminate', 'failed'])],
  ['running', new Set(['waiting_user', 'succeeded', 'failed', 'cancelled', 'indeterminate'])],
  ['waiting_user', new Set(['queued', 'running', 'succeeded', 'failed', 'cancelled', 'indeterminate'])],
  ['indeterminate', new Set(['running', 'waiting_user', 'succeeded', 'failed', 'cancelled'])],
]);

export function transitionState(current, next, context = {}) {
  if (!TASK_STATES.includes(current.status) || !TASK_STATES.includes(next)) fail('invalid_state_transition', `Unknown state transition: ${current.status} -> ${next}`);
  if (current.status === next) return { ...current };
  if (TERMINAL_STATES.has(current.status)) fail('invalid_state_transition', `Terminal state cannot change: ${current.status}`);
  if (!NORMAL_TRANSITIONS.get(current.status)?.has(next)) fail('invalid_state_transition', `Illegal state transition: ${current.status} -> ${next}`);
  if (current.status === 'indeterminate') {
    if (!context.same_native_identity) fail('native_session_mismatch', 'Indeterminate state requires evidence from the same native identity.', { submission: 'may_have_been_sent' });
    const previousStrength = Number(current.evidence_strength ?? 0);
    const nextStrength = Number(context.evidence_strength ?? 0);
    if (nextStrength <= previousStrength) fail('insufficient_evidence', 'Indeterminate state requires stronger native evidence.', { submission: 'may_have_been_sent' });
  }
  return {
    ...current,
    status: next,
    evidence_strength: Math.max(Number(current.evidence_strength ?? 0), Number(context.evidence_strength ?? 0)),
  };
}

export function statusFromNativeEvent(event) {
  const type = event?.type;
  if (type === 'running') return 'running';
  if (type === 'waiting_user') return 'waiting_user';
  if (type === 'succeeded') return 'succeeded';
  if (type === 'failed') return 'failed';
  if (type === 'cancelled') return 'cancelled';
  if (type === 'indeterminate') return 'indeterminate';
  fail('invalid_native_event', `Unsupported native event: ${type}`);
}
