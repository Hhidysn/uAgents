import { setTimeout as delay } from 'node:timers/promises';
import { TraeGatewayClient } from '../../../mcp/trae/src/client.mjs';
import { fail } from '../../protocol/errors.mjs';
import { BUILTIN_REGISTRY } from '../../registry/builtins.mjs';

export class TraeAdapter {
  constructor({ client = new TraeGatewayClient(), pollIntervalMs = 1_000, now = Date.now } = {}) {
    this.client = client;
    this.pollIntervalMs = pollIntervalMs;
    this.now = now;
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

  async probe() { return publicProbe(await this.client.status()); }

  async prepare(request) {
    const probe = publicProbe(await this.client.status());
    if (!probe.identity_confirmed) fail('trae_identity_unconfirmed', probe.next_action, { submission: 'not_sent' });
    return { request, probe };
  }

  async dispatch(prepared, context) {
    await context.checkpoint('possibly_sent');
    const native = await this.client.submit({
      message: prepared.request.prompt,
      mode: 'solo',
      newConversation: true,
      autoContinue: false,
      autoApproveDialog: false,
      ...(prepared.request.workspace ? { workspace: prepared.request.workspace } : {}),
    }, prepared.request.request_id);
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
    const deadline = handle.deadline_at_ms ?? this.now() + 7_200_000;
    while (this.now() <= deadline) {
      let native;
      try {
        native = await this.client.task(handle.task_id);
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
