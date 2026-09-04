import { BUILTIN_REGISTRY } from '../registry/builtins.mjs';
import { fail } from '../protocol/errors.mjs';
import { invokeCli, nativeDriver } from '../../skills/agent-dispatch/scripts/cli-adapters.mjs';
import { invokeAgy } from '../../skills/agent-dispatch/scripts/worker.mjs';

export class CliAdapter {
  #outcomes = new Map();

  constructor(target, { testDriver = null } = {}) {
    this.target = target;
    this.testDriver = testDriver;
  }

  descriptor() {
    const descriptor = structuredClone(BUILTIN_REGISTRY.targets[this.target]);
    return {
      target: this.target,
      ...descriptor,
      model_identity: this.target === 'agy'
        ? { reported: true, verification: 'runtime_self_report' }
        : this.target === 'workbuddy'
          ? { reported: true, verification: 'unverified_backend_default' }
          : { reported: false, verification: 'unsupported' },
    };
  }

  async discoverModels() {
    if (this.target === 'agy') return { models: [], discovery: 'explicit-pattern' };
    const models = Object.values(BUILTIN_REGISTRY.models).filter(model => model.target === this.target && model.enabled).map(model => ({
      id: model.model, route_id: model.route_id, provider: model.provider, kind: model.kind,
    }));
    return { models, discovery: 'configured' };
  }

  async probe(request, context) {
    const legacy = this.#legacyRequest({ ...request, prompt: undefined }, 'probe');
    const workspace = context.workspace;
    if (this.target === 'agy') return invokeAgy(workspace, workspace, legacy, () => {}, this.testDriver);
    const driver = this.testDriver ?? nativeDriver(legacy, workspace);
    return invokeCli(workspace, workspace, legacy, () => {}, driver);
  }

  async prepare(request, context = {}) {
    const legacy = this.#legacyRequest(request, 'run');
    const driver = this.target === 'agy' ? this.testDriver : this.testDriver ?? nativeDriver(legacy, request.workspace);
    return { request, legacy, driver, taskDirectory: context.taskDirectory ?? request.workspace };
  }

  async dispatch(prepared, context) {
    let possiblySent = false;
    let nativeSessionId = null;
    let modelReported = null;
    const publish = patch => {
      if (patch.native_session_id) nativeSessionId = patch.native_session_id;
      if (patch.model_reported !== undefined) modelReported = patch.model_reported;
      if (patch.submission === 'may_have_been_sent' && !possiblySent) {
        context.checkpoint('possibly_sent');
        possiblySent = true;
      }
    };
    const workspace = prepared.request.workspace;
    const directory = prepared.taskDirectory;
    const outcome = this.target === 'agy'
      ? await invokeAgy(directory, workspace, prepared.legacy, publish, prepared.driver)
      : await invokeCli(directory, workspace, prepared.legacy, publish, prepared.driver);
    nativeSessionId ??= outcome.result?.native_session_id ?? null;
    if (!possiblySent) {
      const error = Object.assign(new Error(outcome.error ?? 'native_preflight_failed'), {
        code: outcome.error ?? 'native_preflight_failed', submission: 'not_sent', cancelled: outcome.status === 'cancelled',
      });
      throw error;
    }
    if (!nativeSessionId) return { handle: { session_id: null, task_id: null, status: outcome.native_status ?? null }, outcome };
    const handle = { session_id: nativeSessionId, task_id: null, status: outcome.native_status ?? 'accepted' };
    context.checkpoint('accepted', { handle, evidence_ref: `${this.target}:native-session` });
    this.#outcomes.set(nativeSessionId, { ...outcome, model_reported: modelReported, request: prepared.request });
    return { handle };
  }

  async *observe(handle) {
    const outcome = this.#outcomes.get(handle.session_id);
    if (!outcome) {
      yield { type: 'indeterminate', same_native_identity: true, evidence_strength: 1, error: 'native_outcome_missing' };
      return;
    }
    const type = outcome.status === 'succeeded' ? 'succeeded'
      : outcome.status === 'needs_user' ? 'waiting_user'
        : outcome.status === 'cancelled' ? 'cancelled'
          : outcome.status === 'failed' || outcome.status === 'blocked' ? 'failed' : 'indeterminate';
    const requested = outcome.request.model_resolved;
    const reported = outcome.model_reported;
    const verified = this.target === 'agy' && typeof reported === 'string' && reported === requested;
    yield {
      type,
      same_native_identity: true,
      evidence_strength: type === 'indeterminate' ? 1 : 2,
      native_status: outcome.native_status ?? null,
      error: outcome.error ?? null,
      response: outcome.result?.response ?? '',
      usage: outcome.result?.usage ?? null,
      model_reported: reported,
      model_verified: verified,
      model_verification: {
        status: verified ? 'verified' : reported && requested && reported !== requested ? 'mismatch' : 'unverified',
        assurance: reported ? 'runtime_self_report' : 'none',
        match: reported && requested ? reported === requested : null,
        method: reported ? 'native_event' : null,
        evidence_ref: reported ? `${this.target}:native-model` : null,
      },
    };
  }

  async cancel() { return { confirmed: false }; }

  #legacyRequest(request, kind) {
    return {
      request_id: request.request_id,
      target: this.target,
      model: this.target === 'opencode' ? request.route_id : this.target === 'workbuddy' ? 'workbuddy-default' : request.model_resolved,
      mode: request.mode,
      permission_policy: 'native',
      expected_outputs: request.expected_outputs.map(output => output.path),
      kind,
      ...(kind === 'run' ? { prompt: request.prompt } : {}),
      timeout_ms: request.execution.observation_timeout_ms,
    };
  }
}
