import { BUILTIN_REGISTRY } from '../../registry/builtins.mjs';
import { fail } from '../../protocol/errors.mjs';
import { invokeDshSdk, locateDshEntry, probeDshVersion } from '../../transports/dsh-sdk-process.mjs';

export class DshAdapter {
  #entryResolver = null;
  #outcomes = new Map();

  constructor({ testDriver = null, entryResolver = null } = {}) {
    this.target = 'dsh';
    this.testDriver = testDriver;
    this.#entryResolver = typeof entryResolver === 'function' ? entryResolver : null;
  }

  descriptor() {
    return {
      target: this.target,
      ...structuredClone(BUILTIN_REGISTRY.targets.dsh),
      model_identity: { reported: true, verification: 'runtime_self_report' },
    };
  }

  async discoverModels() {
    return { status: 'configured_only', discovery: 'configured', models: [] };
  }

  async #entry(context = null) {
    const inline = context?.verifiedEntry;
    if (inline && typeof inline === 'object' && typeof inline.canonical_path === 'string') return inline.canonical_path;
    if (typeof inline === 'string' && inline) return inline;
    if (this.#entryResolver) {
      try {
        const installation = await this.#entryResolver(this.target);
        if (typeof installation?.canonical_path === 'string' && installation.canonical_path) return installation.canonical_path;
      } catch {}
    }
    return locateDshEntry();
  }

  async probe(_request, context = {}) {
    return probeDshVersion(await this.#entry(context), { spawnImpl: this.testDriver?.spawn });
  }

  async prepare(request, context = {}) {
    return { request, entry: await this.#entry(context), taskDirectory: context.taskDirectory ?? request.workspace };
  }

  async dispatch(prepared, context) {
    let possiblySent = false;
    let handle = null;
    let modelReported = null;
    const publish = patch => {
      if (patch.model_reported !== undefined) modelReported = patch.model_reported;
      if (patch.submission === 'may_have_been_sent' && !possiblySent) {
        context.checkpoint('possibly_sent');
        possiblySent = true;
      }
    };
    const outcome = await invokeDshSdk({
      entry: prepared.entry,
      request: prepared.request,
      workspace: prepared.request.workspace,
      publish,
      signal: context.signal,
      isCancelRequested: context.isCancelRequested,
      spawnImpl: this.testDriver?.spawn,
      onAccepted: accepted => {
        handle = accepted;
        context.checkpoint('accepted', { handle: accepted, evidence_ref: 'dsh:sdk-message' });
      },
    });
    if (!possiblySent) {
      const code = outcome.error ?? 'native_preflight_failed';
      throw Object.assign(new Error(code), { code, submission: 'not_sent' });
    }
    if (!handle) return { handle: { session_id: null, task_id: null, status: outcome.native_status ?? null }, outcome };
    this.#outcomes.set(handle.session_id, { outcome, request: prepared.request, modelReported });
    return { handle };
  }

  async *observe(handle) {
    const stored = this.#outcomes.get(handle?.session_id);
    if (!stored) {
      yield { type: 'indeterminate', same_native_identity: true, evidence_strength: 1, error: 'native_outcome_missing' };
      return;
    }
    const { outcome, request, modelReported } = stored;
    const type = outcome.status === 'succeeded' ? 'succeeded'
      : outcome.status === 'failed' ? 'failed'
        : outcome.status === 'cancelled' ? 'cancelled' : 'indeterminate';
    const reported = modelReported ?? outcome.model_reported ?? null;
    const requested = request.model_resolved;
    const verified = typeof reported === 'string' && typeof requested === 'string' && reported === requested;
    yield {
      type,
      same_native_identity: true,
      evidence_strength: type === 'indeterminate' ? 1 : 2,
      native_status: outcome.native_status ?? null,
      error: outcome.error ?? null,
      response: outcome.response ?? '',
      usage: outcome.usage ?? null,
      model_reported: reported,
      model_verified: verified,
      model_verification: {
        status: verified ? 'verified' : reported && requested ? 'mismatch' : 'unverified',
        assurance: reported ? 'runtime_self_report' : 'none',
        match: reported && requested ? reported === requested : null,
        method: reported ? 'native_event' : null,
        evidence_ref: reported ? 'dsh:native-model' : null,
      },
    };
  }

  async cancel() { return { confirmed: false }; }

  async reconcile(_native, context = {}) {
    fail('reconcile_unsupported', 'dsh does not support durable SDK reconciliation in this release.', {
      category: 'policy', submission: context.submission ?? 'may_have_been_sent',
    });
  }
}
