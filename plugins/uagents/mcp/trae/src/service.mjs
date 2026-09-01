import fs from 'node:fs';
import path from 'node:path';
import { TraeGatewayClient, fail } from './client.mjs';
import { TaskStore, digest, terminal } from './store.mjs';

function normalize(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('invalid_request', 'Expected an object.');
  for (const key of Object.keys(input)) if (!['request_id', 'prompt', 'workspace', 'timeout_ms'].includes(key)) fail('unsupported_field', `Unsupported field: ${key}`);
  if (typeof input.prompt !== 'string' || !input.prompt.trim() || Buffer.byteLength(input.prompt) > 65536) fail('invalid_prompt', 'prompt must contain 1–65536 UTF-8 bytes.');
  const timeout = input.timeout_ms ?? 1200000;
  if (!Number.isInteger(timeout) || timeout < 10000 || timeout > 7200000) fail('invalid_timeout', 'timeout_ms must be 10000–7200000.');
  let workspace = null;
  if (input.workspace !== undefined) {
    if (typeof input.workspace !== 'string' || !path.isAbsolute(input.workspace)) fail('invalid_workspace', 'workspace must be an existing absolute directory.');
    try { workspace = fs.realpathSync(input.workspace); }
    catch { fail('invalid_workspace', 'workspace must be an existing absolute directory.'); }
    if (!fs.statSync(workspace).isDirectory()) fail('invalid_workspace', 'workspace must be an existing absolute directory.');
  }
  return { request_id: input.request_id?.toLowerCase(), prompt: input.prompt, workspace, timeout_ms: timeout };
}

function identity(status) {
  const surface = status?.surface;
  const url = String(surface?.url ?? '').toLowerCase();
  const kind = surface?.kind ?? 'none';
  const looksLikeWorkbench = kind === 'workspace' && (url.includes('workbench') || /trae\s*cn/i.test(String(surface?.title ?? '')));
  return status?.traeRunning === true && looksLikeWorkbench && !url.startsWith('doubaowork:');
}

function publicProbe(status) {
  const confirmed = identity(status);
  return {
    status: confirmed ? 'available' : 'unavailable',
    scope: 'connection_only',
    gateway_version: status?.version ?? null,
    gateway_status: status?.status ?? null,
    cdp_reachable: status?.cdpReachable === true,
    trae_running: status?.traeRunning === true,
    identity_confirmed: confirmed,
    surface_kind: status?.surface?.kind ?? null,
    adapter_id: status?.traeAdapter?.id ?? status?.traeAdapter?.adapterId ?? status?.traeAdapter?.adapter ?? null,
    durability_degraded: status?.durability?.durabilityDegraded === true,
    submission: 'not_sent',
    next_action: confirmed ? null : 'Start TRAE CN on the dedicated CDP port and run the bundled TRAE gateway launcher.',
  };
}

function mapNative(native) {
  const status = String(native?.status ?? '').toLowerCase();
  if (['accepted', 'queued', 'executing'].includes(status)) return { status: 'running', native_status: status };
  if (['approval_required', 'awaiting_review'].includes(status)) {
    return {
      status: 'needs_user',
      native_status: status,
      error: status,
      interaction: native?.result ? {
        question: native.result.question ?? null,
        dialog_type: native.result.dialogType ?? null,
        buttons: Array.isArray(native.result.buttons) ? native.result.buttons.slice(0, 8) : [],
        command: native.result.command ?? null,
        command_risk: native.result.commandRisk ?? null,
      } : null,
    };
  }
  if (status === 'done') {
    const response = typeof native?.result?.text === 'string' ? native.result.text : '';
    if (!response || native?.result?.stable === false || Buffer.byteLength(response) > 1048576) {
      return { status: 'unknown', native_status: status, error: response ? 'native_result_unstable_or_large' : 'native_result_missing', retry_safe: false };
    }
    return {
      status: 'succeeded',
      native_status: status,
      response,
      evidence: {
        stable: native.result.stable !== false,
        elapsed_ms: native.result.elapsedMs ?? native.elapsed ?? null,
        from_history: native.fromHistory === true,
        detail_level: native.detailLevel ?? 'result',
      },
    };
  }
  if (['error', 'queue_timeout', 'review_rejected'].includes(status)) return { status: 'failed', native_status: status, error: String(native?.error ?? status).slice(0, 500), retry_safe: false };
  if (status === 'cancelled') return { status: 'unknown', native_status: status, error: 'native_cancel_not_confirmed', retry_safe: false };
  return { status: 'unknown', native_status: status || 'unknown', error: 'native_status_unknown', retry_safe: false };
}

export class TraeTaskService {
  constructor({ store = new TaskStore(), client = new TraeGatewayClient() } = {}) { this.store = store; this.client = client; }
  async probe() { return publicProbe(await this.client.status()); }
  async submit(input) {
    const request = normalize(input);
    const requestDigest = digest(request);
    const registration = this.store.register(request.request_id, requestDigest, request.timeout_ms);
    if (registration.duplicate) return { ...registration.state, duplicate: true };
    let state = registration.state;
    try {
      const probe = publicProbe(await this.client.status());
      if (!probe.identity_confirmed) fail('trae_identity_unconfirmed', probe.next_action);
      state = { ...state, status: 'running', submission: 'may_have_been_sent' };
      this.store.write(state);
      const native = await this.client.submit({
        message: request.prompt,
        mode: 'solo',
        newConversation: true,
        autoContinue: false,
        autoApproveDialog: false,
        ...(request.workspace ? { workspace: request.workspace } : {}),
      }, request.request_id);
      if (typeof native?.taskId !== 'string' || !native.taskId) fail('native_task_identity_missing', 'TRAE gateway accepted no stable task identity.', { transportUnknown: true });
      state = {
        ...state,
        status: 'running',
        submission: 'sent',
        native_task_id: native.taskId,
        native_status: native.status ?? 'accepted',
        deadline_at_ms: Date.now() + request.timeout_ms,
      };
      this.store.write(state);
      return state;
    } catch (error) {
      const current = this.store.read(request.request_id);
      const unknown = current.submission === 'may_have_been_sent' && error.gatewayRejected !== true;
      state = { ...current, status: unknown ? 'unknown' : 'failed', error: error.code ?? 'submission_failed', retry_safe: false };
      this.store.write(state);
      return state;
    }
  }
  async status(id) {
    let state = this.store.read(id);
    if (terminal.has(state.status)) return state;
    if (!state.native_task_id) return state;
    if (Date.now() > state.deadline_at_ms) {
      state = { ...state, status: 'unknown', error: 'deadline_remote_state_unknown', retry_safe: false };
      this.store.write(state);
      return state;
    }
    let mapped;
    try { mapped = mapNative(await this.client.task(state.native_task_id)); }
    catch (error) { mapped = { status: 'unknown', error: error.code ?? 'result_inspection_failed', retry_safe: false }; }
    if (mapped.status === 'running') return { ...state, ...mapped };
    state = { ...state, ...mapped };
    this.store.write(state);
    return state;
  }
  async result(id) {
    const state = await this.status(id);
    return {
      ...state,
      result: state.status === 'succeeded' ? {
        native_task_id: state.native_task_id,
        response: state.response,
        evidence: state.evidence,
      } : null,
    };
  }
}
