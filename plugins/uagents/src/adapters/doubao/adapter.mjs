import { setTimeout as delay } from 'node:timers/promises';
import { DoubaoDesktopBridge } from '../../../mcp/doubao/src/cdp.mjs';
import { BUILTIN_REGISTRY } from '../../registry/builtins.mjs';

export class DoubaoAdapter {
  constructor({ bridge = new DoubaoDesktopBridge(), pollIntervalMs = 1_000, now = Date.now } = {}) {
    this.bridge = bridge;
    this.pollIntervalMs = pollIntervalMs;
    this.now = now;
  }

  descriptor() {
    return {
      target: 'doubao',
      ...structuredClone(BUILTIN_REGISTRY.targets.doubao),
      model_identity: { reported: false, verification: 'unsupported' },
    };
  }

  async discoverModels() {
    return { models: [{ id: null, route_id: 'doubao-default', provider: 'doubao', kind: 'backend_default' }], discovery: 'configured' };
  }

  async probe() { return this.bridge.probe(); }

  async prepare(request) { return { request }; }

  async dispatch(prepared, context) {
    const native = await this.bridge.prepareAndSubmit(prepared.request.prompt, async patch => {
      if (patch.submission === 'may_have_been_sent') await context.checkpoint('possibly_sent');
    });
    const handle = {
      session_id: native.native_conversation_id,
      task_id: native.target_id,
      target_id: native.target_id,
      native_conversation_id: native.native_conversation_id,
      user_message_index: native.user_message_index ?? 0,
      deadline_at_ms: this.now() + prepared.request.execution.observation_timeout_ms,
    };
    await context.checkpoint('accepted', { handle, evidence_ref: 'doubao:conversation-url-and-first-message' });
    return { handle };
  }

  async *observe(handle, { signal } = {}) {
    const deadline = handle.deadline_at_ms ?? this.now() + 1_200_000;
    while (this.now() <= deadline) {
      let observed;
      try {
        observed = await this.bridge.inspect(handle.target_id, handle.native_conversation_id, handle.user_message_index);
      } catch (error) {
        yield nativeEvent('indeterminate', { error: error.code ?? 'result_inspection_failed', native_status: 'unknown' });
        return;
      }
      const event = mapDoubaoObservation(observed);
      yield event;
      if (event.type !== 'running') return;
      await delay(this.pollIntervalMs, undefined, { signal });
    }
    yield nativeEvent('indeterminate', { error: 'deadline_remote_state_unknown', native_status: 'running' });
  }

  async cancel() { return { confirmed: false }; }
}

export function mapDoubaoObservation(observed) {
  if (observed?.status === 'running') return nativeEvent('running', { response: observed.response ?? '', native_status: 'running' });
  if (observed?.status === 'needs_user') return nativeEvent('waiting_user', { error: observed.error ?? 'native_approval_required', native_status: 'needs_user', interaction: observed.interaction ?? null });
  if (observed?.status === 'succeeded') return nativeEvent('succeeded', { response: observed.response ?? '', native_status: 'succeeded', evidence: observed.evidence ?? null });
  if (observed?.status === 'failed') return nativeEvent('failed', { error: observed.error ?? 'native_failed', native_status: 'failed' });
  return nativeEvent('indeterminate', { error: observed?.error ?? 'native_status_unknown', native_status: observed?.status ?? 'unknown' });
}

function nativeEvent(type, extra = {}) {
  return {
    type,
    same_native_identity: true,
    evidence_strength: type === 'indeterminate' ? 1 : 2,
    model_reported: null,
    model_verified: false,
    model_verification: { status: 'unverified', assurance: 'none', match: null, method: null, evidence_ref: null },
    ...extra,
  };
}
