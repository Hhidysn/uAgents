import { setTimeout as delay } from 'node:timers/promises';
import { TraeGatewayClient } from '../../../mcp/trae/src/client.mjs';
import { fail, normalizeError, UAgentsError } from '../../protocol/errors.mjs';
import { BUILTIN_REGISTRY } from '../../registry/builtins.mjs';

// Known gateway client codes must surface as their own UAgentsError code
// (design §16): normalizeError alone would degrade them to internal_error.
// gateway_unavailable is intentionally excluded: it maps to target_not_ready
// through the protocol whitelist.
const GATEWAY_CLIENT_CODES = new Set([
  'gateway_identity_mismatch',
  'gateway_response_too_large',
  'gateway_invalid_json',
  'invalid_gateway_port',
]);

function normalizeGatewayClientError(error) {
  if (error instanceof UAgentsError) return error;
  const code = error?.code;
  if (typeof code === 'string' && (GATEWAY_CLIENT_CODES.has(code) || code.startsWith('gateway_http_'))) {
    return fail(code, error?.message ?? code, { submission: 'not_sent', details: { cause_code: code } });
  }
  return error;
}

export class TraeAdapter {
  constructor({ client = new TraeGatewayClient(), pollIntervalMs = 1_000, now = Date.now } = {}) {
    this.client = client;
    this.pollIntervalMs = pollIntervalMs;
    this.now = now;
    // Set by prepare() when a managed instance context is present; used by
    // dispatch/observe/reconcile so the whole task lifecycle talks to the
    // gateway the supervisor launched (port, token in memory, nonce check).
    this.activeClient = null;
  }

  // Managed instances run on supervisor-assigned ports with a capability
  // token that never touches disk outside the host secrets file. Without a
  // managed context the legacy environment-configured client is kept.
  #clientFor(context) {
    const managed = context?.managed;
    if (!managed || !Number.isInteger(managed.gateway_port)) return this.client;
    if (managed.instance_nonce === null || managed.instance_nonce === undefined) return this.client;
    return new TraeGatewayClient({
      port: managed.gateway_port,
      token: typeof managed.capability_token === 'string' && managed.capability_token.length > 0 ? managed.capability_token : '',
      expectedInstanceNonce: managed.instance_nonce,
      fetchImpl: this.client.fetchImpl,
    });
  }

  descriptor() {
    return {
      target: 'trae',
      ...structuredClone(BUILTIN_REGISTRY.targets.trae),
      model_identity: { reported: false, verification: 'unsupported' },
    };
  }

  async discoverModels() {
    return { models: [{ id: null, route_id: 'trae-default', provider: 'trae', kind: 'backend_default' }], discovery: 'configured' };
  }

  async probe() {
    try { return publicProbe(await this.client.status()); }
    catch (error) { throw normalizeError(error); }
  }

  async prepare(request, context = {}) {
    this.activeClient = this.#clientFor(context);
    let probe;
    try { probe = publicProbe(await this.activeClient.status()); }
    catch (error) { throw normalizeError(normalizeGatewayClientError(error)); }
    if (!probe.identity_confirmed) fail('trae_identity_unconfirmed', probe.next_action, { submission: 'not_sent' });
    return { request, probe };
  }

  async dispatch(prepared, context) {
    const client = this.activeClient ?? this.client;
    await context.checkpoint('possibly_sent');
    let native;
    try {
      native = await client.submit({
        message: prepared.request.prompt,
        mode: 'solo',
        newConversation: true,
        autoContinue: false,
        autoApproveDialog: false,
        ...(prepared.request.workspace ? { workspace: prepared.request.workspace } : {}),
      }, prepared.request.request_id);
    } catch (error) {
      if (/quota|credit|balance|insufficient|积分|额度/i.test(`${error.code ?? ''} ${error.message ?? ''}`)) {
        fail('quota_exhausted', 'TRAE reported insufficient quota.', { cause_code: error.code ?? null, submission: 'may_have_been_sent' });
      }
      throw error;
    }
    if (typeof native?.taskId !== 'string' || !native.taskId) fail('native_task_identity_missing', 'TRAE gateway accepted no stable task identity.', { submission: 'may_have_been_sent' });
    const handle = {
      session_id: native.taskId,
      task_id: native.taskId,
      status: native.status ?? 'accepted',
      deadline_at_ms: this.now() + prepared.request.execution.observation_timeout_ms,
    };
    await context.checkpoint('accepted', { handle, evidence_ref: 'trae:gateway-task-id' });
    return { handle };
  }

  async *observe(handle, { signal } = {}) {
    const client = this.activeClient ?? this.client;
    const deadline = handle.deadline_at_ms ?? this.now() + 7_200_000;
    while (this.now() <= deadline) {
      let native;
      try {
        native = await client.task(handle.task_id);
      } catch (error) {
        yield nativeEvent('indeterminate', { error: error.code ?? 'result_inspection_failed', native_status: 'unknown' });
        return;
      }
      const event = mapTraeNative(native);
      yield event;
      if (event.type !== 'running') return;
      await delay(this.pollIntervalMs, undefined, { signal });
    }
    yield nativeEvent('indeterminate', { error: 'deadline_remote_state_unknown', native_status: 'running' });
  }

  async cancel() { return { confirmed: false }; }

  async reconcile(native) {
    const client = this.activeClient ?? this.client;
    try { return mapTraeNative(await client.task(native.task_id ?? native.session_id)); }
    catch (error) { return nativeEvent('indeterminate', { error: error.code ?? 'result_inspection_failed', native_status: 'unknown', evidence_strength: 3 }); }
  }
}

export function publicProbe(status) {
  const surface = status?.surface;
  const url = String(surface?.url ?? '').toLowerCase();
  const kind = surface?.kind ?? 'none';
  const confirmed = status?.traeRunning === true && kind === 'workspace'
    && (url.includes('workbench') || /trae\s*cn/i.test(String(surface?.title ?? '')))
    && !url.startsWith('doubaowork:');
  return {
    status: confirmed ? 'available' : 'unavailable',
    scope: 'connection_only',
    gateway_version: status?.version ?? null,
    gateway_status: status?.status ?? null,
    cdp_reachable: status?.cdpReachable === true,
    trae_running: status?.traeRunning === true,
    identity_confirmed: confirmed,
    surface_kind: kind,
    adapter_id: status?.traeAdapter?.id ?? status?.traeAdapter?.adapterId ?? status?.traeAdapter?.adapter ?? null,
    durability_degraded: status?.durability?.durabilityDegraded === true,
    submission: 'not_sent',
    next_action: confirmed ? null : 'Start TRAE CN on the dedicated CDP port and run the bundled TRAE gateway launcher.',
  };
}

export function mapTraeNative(native) {
  const status = String(native?.status ?? '').toLowerCase();
  if (['accepted', 'queued', 'executing'].includes(status)) return nativeEvent('running', { native_status: status });
  if (['approval_required', 'awaiting_review'].includes(status)) return nativeEvent('waiting_user', {
    native_status: status,
    error: status,
    interaction: native?.result ? {
      question: native.result.question ?? null,
      dialog_type: native.result.dialogType ?? null,
      buttons: Array.isArray(native.result.buttons) ? native.result.buttons.slice(0, 8) : [],
      command: native.result.command ?? null,
      command_risk: native.result.commandRisk ?? null,
    } : null,
  });
  if (status === 'done') {
    const response = typeof native?.result?.text === 'string' ? native.result.text : '';
    if (!response || native?.result?.stable === false || Buffer.byteLength(response) > 1_048_576) return nativeEvent('indeterminate', {
      native_status: status,
      error: response ? 'native_result_unstable_or_large' : 'native_result_missing',
    });
    return nativeEvent('succeeded', {
      native_status: status,
      response,
      evidence: {
        stable: true,
        elapsed_ms: native.result.elapsedMs ?? native.elapsed ?? null,
        from_history: native.fromHistory === true,
        detail_level: native.detailLevel ?? 'result',
      },
    });
  }
  if (['error', 'queue_timeout', 'review_rejected'].includes(status)) return nativeEvent('failed', { native_status: status, error: String(native?.error ?? status).slice(0, 500) });
  if (status === 'cancelled') return nativeEvent('indeterminate', { native_status: status, error: 'native_cancel_not_confirmed' });
  return nativeEvent('indeterminate', { native_status: status || 'unknown', error: 'native_status_unknown' });
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
