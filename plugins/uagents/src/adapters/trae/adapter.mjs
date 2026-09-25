import { setTimeout as delay } from 'node:timers/promises';
import { TraeGatewayClient } from '../../../mcp/trae/src/client.mjs';
import { fail, normalizeError, UAgentsError } from '../../protocol/errors.mjs';
import { BUILTIN_REGISTRY } from '../../registry/builtins.mjs';
import { readTraeLocalModelCache } from './local-model-cache.mjs';

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
  constructor({ client = new TraeGatewayClient(), pollIntervalMs = 1_000, now = Date.now,
    readLocalModels = readTraeLocalModelCache } = {}) {
    this.client = client;
    this.pollIntervalMs = pollIntervalMs;
    this.now = now;
    this.readLocalModels = readLocalModels;
  }

  // Managed instances run on supervisor-assigned ports with a capability
  // token that never touches disk outside the host secrets file. Without a
  // managed context the legacy environment-configured client is kept.
  #clientFor(context) {
    const managed = context?.managed;
    if (managed === null || managed === undefined) return this.client;
    if (!Number.isInteger(managed.gateway_port) || managed.gateway_port < 1024 || managed.gateway_port > 65535) {
      fail('managed_instance_identity_mismatch', 'The managed TRAE instance has no valid gateway port.', {
        submission: 'may_have_been_sent',
        details: { cause_code: 'managed_gateway_port_missing' },
      });
    }
    if (managed.instance_nonce === null || managed.instance_nonce === undefined || String(managed.instance_nonce).length === 0) {
      fail('managed_instance_identity_mismatch', 'The managed TRAE instance has no gateway nonce.', {
        submission: 'may_have_been_sent',
        details: { cause_code: 'managed_instance_nonce_missing' },
      });
    }
    if (typeof managed.capability_token !== 'string' || managed.capability_token.length === 0) {
      fail('gateway_identity_mismatch', 'The managed TRAE gateway capability is unavailable.', {
        submission: 'may_have_been_sent',
        details: { cause_code: 'capability_token_missing' },
      });
    }
    if (typeof this.client.forManagedContext === 'function') return this.client.forManagedContext(managed);
    return new TraeGatewayClient({
      port: managed.gateway_port,
      token: managed.capability_token,
      expectedInstanceNonce: managed.instance_nonce,
      fetchImpl: typeof this.client.fetchImpl === 'function' ? this.client.fetchImpl : fetch,
    });
  }

  descriptor() {
    return {
      target: 'trae',
      ...structuredClone(BUILTIN_REGISTRY.targets.trae),
      model_identity: { reported: false, verification: 'unsupported' },
    };
  }

  discoverLocalModels({ errorCode = 'trae_identity_unconfirmed' } = {}) {
    const cached = this.readLocalModels();
    if (!cached?.models?.length) return null;
    return {
      status: 'cache_only', models: cached.models, discovery: 'native_profile_cache',
      error_code: errorCode, snapshot_file_mtime_ms: cached.snapshot_file_mtime_ms,
    };
  }

  async discoverModels({ managed = null } = {}) {
    const client = this.#clientFor({ managed });
    const probe = publicProbe(await client.status());
    if (!probe.identity_confirmed) {
      const cached = this.discoverLocalModels();
      if (cached) return cached;
      fail('trae_identity_unconfirmed', probe.next_action, { submission: 'not_sent' });
    }
    const catalog = await client.models();
    if (!Array.isArray(catalog?.models)) fail('model_discovery_parse_failed', 'TRAE gateway returned no model list.', { submission: 'not_sent' });
    const models = [...new Set(catalog.models.filter(name => typeof name === 'string')
      .map(name => name.trim()).filter(name => name && Buffer.byteLength(name) <= 256 && !/[\x00-\x1f\x7f]/.test(name)))]
      .map(id => ({ id, route_id: `trae/${id}`, provider: 'trae', kind: 'native_catalog' }));
    if (!models.length) fail('model_discovery_parse_failed', 'TRAE model picker has no readable model labels.', { submission: 'not_sent' });
    return { status: 'ok', models, discovery: 'native_gateway_picker' };
  }

  async probe(request, context = {}) {
    try { return publicProbe(await this.#clientFor(context).status()); }
    catch (error) { throw normalizeError(normalizeGatewayClientError(error)); }
  }

  async prepare(request, context = {}) {
    const client = this.#clientFor(context);
    let probe;
    try { probe = publicProbe(await client.status()); }
    catch (error) { throw normalizeError(normalizeGatewayClientError(error)); }
    if (!probe.identity_confirmed) fail('trae_identity_unconfirmed', probe.next_action, { submission: 'not_sent' });
    return { request, probe };
  }

  async dispatch(prepared, context = {}) {
    const client = this.#clientFor(context);
    await context.checkpoint('possibly_sent');
    let native;
    try {
      native = await client.submit({
        message: prepared.request.prompt,
        mode: 'solo',
        newConversation: true,
        autoContinue: false,
        autoApproveDialog: false,
        ...(prepared.request.model_resolved ? { model: prepared.request.model_resolved } : {}),
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

  async *observe(handle, context = {}) {
    const { signal } = context;
    let client;
    try {
      client = this.#clientFor(context);
      // A worker has already performed prepare() immediately before observe,
      // but checking the nonce here keeps the observation path safe when a
      // caller supplies a reconstructed context after a process restart.
      if (context?.managed) await client.status();
    } catch (error) {
      if (!error?.code) throw error;
      yield nativeEvent('indeterminate', { error: error.code, native_status: 'unknown', evidence_strength: 1 });
      return;
    }
    const deadline = handle.deadline_at_ms ?? this.now() + 7_200_000;
    while (this.now() <= deadline) {
      let native;
      try {
        native = await client.task(handle.task_id);
      } catch (error) {
        if (!error?.code) throw error;
        yield nativeEvent('indeterminate', { error: error.code, native_status: 'unknown' });
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

  async reconcile(native, context = {}) {
    let client;
    try {
      client = this.#clientFor(context);
      // task() is authenticated, but the task endpoint does not carry the
      // gateway nonce. Verify the original managed gateway before querying a
      // persisted native task identity.
      if (context?.managed) await client.status();
      return mapTraeNative(await client.task(native.task_id ?? native.session_id));
    }
    catch (error) {
      // A failed read leaves the native state unknown; it is intentionally
      // weaker than a later stable result from the same identity.
      if (!error?.code) throw error;
      return nativeEvent('indeterminate', { error: error.code, native_status: 'unknown', evidence_strength: 1 });
    }
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

function mapTraeNative(native) {
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
