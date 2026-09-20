import { BUILTIN_REGISTRY } from '../../registry/builtins.mjs';
import { fail } from '../../protocol/errors.mjs';
import { invokeCodexExec, locateCodexEntry, probeCodexVersion } from '../../transports/codex-process.mjs';

export class CodexAdapter {
  #entryResolver;
  #outcomes = new Map();

  constructor({ testDriver = null, entryResolver = null } = {}) {
    this.target = 'codex';
    this.testDriver = testDriver;
    this.#entryResolver = typeof entryResolver === 'function' ? entryResolver : null;
  }

  descriptor() {
    return {
      target: 'codex',
      ...structuredClone(BUILTIN_REGISTRY.targets.codex),
      model_identity: { reported: false, verification: 'unsupported' },
    };
  }

  async discoverModels() {
    return { status: 'configured_only', discovery: 'configured', models: [] };
  }

  async #entry(context = {}) {
    const inline = context?.verifiedEntry;
    if (inline && typeof inline === 'object' && typeof inline.canonical_path === 'string') return inline.canonical_path;
    if (typeof inline === 'string' && inline) return inline;
    if (this.#entryResolver) {
      const installation = await this.#entryResolver('codex');
      if (typeof installation?.canonical_path === 'string' && installation.canonical_path) return installation.canonical_path;
    }
    return locateCodexEntry();
  }

  async probe(_request, context = {}) {
    return probeCodexVersion(await this.#entry(context), { spawnImpl: this.testDriver?.spawn });
  }

  async prepare(request, context = {}) {
    return { request, entry: await this.#entry(context), taskDirectory: context.taskDirectory ?? request.workspace };
  }

  async dispatch(prepared, context) {
    let possiblySent = false;
    let handle = null;
    const outcome = await invokeCodexExec({
      entry: prepared.entry,
      request: prepared.request,
      workspace: prepared.request.workspace,
      spawnImpl: this.testDriver?.spawn,
      signal: context.signal,
      isCancelRequested: context.isCancelRequested,
      publish: patch => {
        if (patch.submission === 'may_have_been_sent' && !possiblySent) {
          context.checkpoint('possibly_sent');
          possiblySent = true;
        }
      },
      onAccepted: accepted => {
        handle = accepted;
        context.checkpoint('accepted', { handle: accepted, evidence_ref: 'codex:thread' });
      },
    });
    if (!possiblySent) {
      const code = outcome.error ?? 'native_preflight_failed';
      throw Object.assign(new Error(code), { code, submission: 'not_sent' });
    }
    if (!handle) return { handle: { session_id: null, task_id: null, status: outcome.native_status ?? null }, outcome };
    this.#outcomes.set(handle.session_id, outcome);
    return { handle };
  }

  async *observe(handle) {
    const outcome = this.#outcomes.get(handle?.session_id);
    if (!outcome) {
      yield { type: 'indeterminate', same_native_identity: true, evidence_strength: 1, error: 'native_outcome_missing' };
      return;
    }
    const type = outcome.status === 'succeeded' ? 'succeeded'
      : outcome.status === 'failed' ? 'failed'
        : outcome.status === 'cancelled' ? 'cancelled' : 'indeterminate';
    yield {
      type,
      same_native_identity: true,
      evidence_strength: type === 'indeterminate' ? 1 : 2,
      native_status: outcome.native_status ?? null,
      launcher_close_confirmed: outcome.launcher_close_confirmed === true,
      error: outcome.error ?? null,
      response: outcome.response ?? '',
      usage: outcome.usage ?? null,
      model_reported: null,
      model_verified: false,
      model_verification: {
        status: 'unverified', assurance: 'none', match: null, method: null, evidence_ref: null,
      },
    };
  }

  async cancel() { return { confirmed: false }; }

  async reconcile(_native, context = {}) {
    fail('reconcile_unsupported', 'Codex CLI durable reconciliation is not available in v1.', {
      category: 'policy', submission: context.submission ?? 'may_have_been_sent',
    });
  }
}
