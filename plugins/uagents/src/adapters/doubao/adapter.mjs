import { setTimeout as delay } from 'node:timers/promises';
import { DoubaoDesktopBridge } from '../../../mcp/doubao/src/cdp.mjs';
import { fail, normalizeError } from '../../protocol/errors.mjs';
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
    return { status: 'configured_only', models: [], discovery: 'configured' };
  }

  // Managed instances run on a supervisor-assigned loopback port; the bridge
  // must target that port instead of the process-environment default.
  #bridgeFor(context) {
    const managed = context?.managed;
    // A missing managed context is the explicit legacy path used by old task
    // records and direct adapter callers. Once a managed context is supplied,
    // however, silently falling back to the environment-configured bridge can
    // query or mutate a different desktop instance.
    if (managed === null || managed === undefined) return this.bridge;
    const port = managed?.port;
    if (!Number.isInteger(port) || port < 1024 || port > 65535) {
      fail('managed_instance_identity_mismatch', 'The managed Doubao instance has no valid CDP port.', {
        submission: 'may_have_been_sent',
        details: { cause_code: 'managed_port_missing' },
      });
    }
    if (port === this.bridge.port) return this.bridge;
    if (this.bridge instanceof DoubaoDesktopBridge) {
      return new DoubaoDesktopBridge({
        port,
        fetchImpl: this.bridge.fetchImpl,
        websocketFactory: this.bridge.websocketFactory,
      });
    }
    if (typeof this.bridge.forPort === 'function') return this.bridge.forPort(port);
    // Constructor-injected test transports may not expose a port at all. Keep
    // that explicit injection usable, while refusing a custom transport that
    // declares a different concrete port (which would be a real fallback).
    if (Number.isInteger(this.bridge.port) && this.bridge.port !== port) {
      fail('managed_instance_identity_mismatch', 'The Doubao bridge cannot bind to the managed CDP port.', {
        submission: 'may_have_been_sent',
        details: { cause_code: 'managed_bridge_unavailable' },
      });
    }
    return this.bridge;
  }

  async probe(request, context) {
    try { return await this.#bridgeFor(context).probe(); }
    catch (error) { throw normalizeError(error); }
  }

  async prepare(request, context = {}) {
    try { await this.#bridgeFor(context).probe(); }
    catch (error) { throw normalizeError(error); }
    return { request };
  }

  async dispatch(prepared, context) {
    const native = await this.#bridgeFor(context).prepareAndSubmit(prepared.request.prompt, async patch => {
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

  async *observe(handle, context = {}) {
    const { signal } = context;
    const bridge = this.#bridgeFor(context);
    const deadline = handle.deadline_at_ms ?? this.now() + 1_200_000;
    while (this.now() <= deadline) {
      let observed;
      try {
        observed = await bridge.inspect(handle.target_id, handle.native_conversation_id, handle.user_message_index);
      } catch (error) {
        if (!error?.code) throw error;
        yield nativeEvent('indeterminate', { error: error.code, native_status: 'unknown' });
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

  async reconcile(native, context = {}) {
    let bridge;
    try {
      bridge = this.#bridgeFor(context);
    } catch (error) {
      if (!error?.code) throw error;
      return nativeEvent('indeterminate', {
        error: error.code,
        native_status: 'unknown',
        evidence_strength: 1,
      });
    }
    try {
      return mapDoubaoObservation(await bridge.inspect(
        native.task_id,
        native.session_id,
        Number.isInteger(native.user_message_index) ? native.user_message_index : 0,
      ));
    } catch (error) {
      // A failed read leaves the native state unknown; it is intentionally
      // weaker than a later stable result from the same identity.
      if (!error?.code) throw error;
      return nativeEvent('indeterminate', { error: error.code, native_status: 'unknown', evidence_strength: 1 });
    }
  }
}

function mapDoubaoObservation(observed) {
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
