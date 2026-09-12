import { BUILTIN_REGISTRY } from '../registry/builtins.mjs';
import { fail } from '../protocol/errors.mjs';
import { invokeCli, nativeDriver } from '../transports/cli-process.mjs';
import { invokeAgy } from '../transports/agy-process.mjs';
import { createOpenCodeDriver, createOpenCodeParser, buildOpenCodePrompt } from '../transports/opencode-driver.mjs';
import {
  launchAndAccept,
  observeDurableExecution,
  prepareDurableExecution,
} from '../transports/durable-cli-execution.mjs';
import { createProcessInspector } from '../host/process-inspector.mjs';
import { discoverCliModelCatalog } from '../transports/model-discovery.mjs';

export class CliAdapter {
  #outcomes = new Map();
  #entryResolver = null;

  constructor(target, { testDriver = null, entryResolver = null } = {}) {
    this.target = target;
    this.testDriver = testDriver;
    // Optional async (target) => installation|null from the Target Supervisor.
    // When it yields a verified installation, the CLI entry is the cached
    // absolute path; without it, legacy PATH discovery stays in force.
    this.#entryResolver = typeof entryResolver === 'function' ? entryResolver : null;
  }

  async #verifiedInstallation(context = null) {
    const inline = context?.verifiedEntry;
    if (inline && typeof inline === 'object' && typeof inline.canonical_path === 'string' && inline.canonical_path.length > 0) {
      return inline;
    }
    if (typeof inline === 'string' && inline.length > 0) return { canonical_path: inline };
    if (!this.#entryResolver) return null;
    try {
      const installation = await this.#entryResolver(this.target);
      if (installation && typeof installation.canonical_path === 'string' && installation.canonical_path.length > 0) return installation;
    } catch {
      return null;
    }
    return null;
  }

  async #verifiedEntry(context = null) {
    return (await this.#verifiedInstallation(context))?.canonical_path ?? null;
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

  async discoverModels({ registry = BUILTIN_REGISTRY } = {}) {
    if (this.target === 'agy') return { models: [], discovery: 'explicit-pattern' };
    if (this.target === 'workbuddy' || this.target === 'opencode') {
      return discoverCliModelCatalog(this.target, { entryOverride: await this.#verifiedEntry(), registry });
    }
    return { models: [], discovery: 'unsupported', status: 'unsupported' };
  }

  async probe(request, context) {
    const legacy = this.#legacyRequest({ ...request, prompt: undefined }, 'probe');
    const workspace = context.workspace;
    if (this.target === 'agy') return invokeAgy(workspace, workspace, legacy, () => {}, this.testDriver, { entry: await this.#verifiedEntry() });
    const driver = this.testDriver ?? nativeDriver(legacy, workspace, await this.#verifiedEntry());
    return invokeCli(workspace, workspace, legacy, () => {}, driver);
  }

  async prepare(request, context = {}) {
    const legacy = this.#legacyRequest(request, 'run', context.session ?? context.continuation ?? null);
    const installation = await this.#verifiedInstallation(context);
    const entry = installation?.canonical_path ?? null;
    let driver = this.target === 'agy'
      ? this.testDriver
      : this.testDriver ?? nativeDriver(legacy, request.workspace, entry, context.inputSnapshots ?? []);
    if (this.target === 'opencode' && this.testDriver) {
      driver = decorateOpenCodeDriver(driver, legacy, request.workspace);
    }
    const prepared = { request, legacy, driver, entry, installation, taskDirectory: context.taskDirectory ?? request.workspace };
    if (this.target === 'opencode' && (process.platform === 'win32' || context.processInspector)) {
      prepared.durable = prepareDurableExecution({
        driver,
        request: legacy,
        workspace: request.workspace,
        taskDirectory: prepared.taskDirectory,
        attemptId: context.attemptId,
        // Injected test drivers are themselves the executable under test.
        // Never weaken production installation verification to accommodate a
        // synthetic resolver path that the fixture will not execute.
        installation: this.testDriver ? null : installation,
        coreVersion: context.coreVersion ?? null,
        adapterVersion: context.adapterVersion ?? null,
      });
    }
    return prepared;
  }

  async dispatch(prepared, context) {
    if (this.target === 'opencode' && prepared.durable) {
      const inspector = context.processInspector ?? (process.platform === 'win32' ? createProcessInspector() : null);
      if (!inspector) fail('unsupported_capability', 'Durable OpenCode execution requires process identity inspection.', {
        category: 'policy', submission: 'not_sent',
      });
      const cancellation = cancellableSignal(context);
      try {
        const launched = await launchAndAccept({
          prepared: prepared.durable,
          control: context.control,
          checkpoint: context.checkpoint,
          inspector,
          lease: context.lease,
          signal: cancellation.signal,
          spawnImpl: prepared.driver?.spawn,
          acceptTimeoutMs: prepared.legacy.timeout_ms,
          timeoutGuardianLauncher: context.timeoutGuardianLauncher ?? undefined,
        });
        return { handle: launched.handle };
      } finally {
        cancellation.cleanup();
      }
    }
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
      ? await invokeAgy(directory, workspace, prepared.legacy, publish, prepared.driver, { entry: prepared.entry })
      : await invokeCli(directory, workspace, prepared.legacy, publish, prepared.driver);
    nativeSessionId ??= outcome.result?.native_session_id ?? null;
    if (!possiblySent) {
      const code = typeof outcome.error === 'string' ? outcome.error : outcome.error?.code ?? 'native_preflight_failed';
      const message = typeof outcome.error === 'object' && outcome.error?.message ? outcome.error.message : code;
      const error = Object.assign(new Error(message), {
        code, submission: 'not_sent', cancelled: outcome.status === 'cancelled',
      });
      throw error;
    }
    if (!nativeSessionId) return { handle: { session_id: null, task_id: null, status: outcome.native_status ?? null }, outcome };
    const handle = { session_id: nativeSessionId, task_id: null, status: outcome.native_status ?? 'accepted' };
    context.checkpoint('accepted', { handle, evidence_ref: `${this.target}:native-session` });
    this.#outcomes.set(nativeSessionId, { ...outcome, model_reported: modelReported, request: prepared.request });
    return { handle };
  }

  async *observe(handle, context = {}) {
    if (this.target === 'opencode' && context.prepared?.durable) {
      const prepared = context.prepared;
      const inspector = context.processInspector ?? (process.platform === 'win32' ? createProcessInspector() : null);
      const cancellation = cancellableSignal(context);
      let observed;
      try {
        observed = await observeDurableExecution({
          control: context.control,
          taskDirectory: prepared.taskDirectory,
          attemptId: context.attemptId,
          driver: prepared.driver,
          checkpoint: context.checkpoint,
          inspector,
          lease: context.lease,
          signal: cancellation.signal,
          observationTimeoutMs: prepared.legacy.timeout_ms,
        });
      } finally {
        cancellation.cleanup();
      }
      if (!observed.outcome) {
        yield {
          type: 'indeterminate', same_native_identity: true, evidence_strength: 1,
          native_status: handle?.status ?? null,
          error: observed.execution_timed_out
            ? observed.termination_confirmed ? 'execution_timeout' : 'execution_timeout_termination_unconfirmed'
            : observed.timed_out ? 'native_observation_timeout' : observed.aborted ? 'native_observation_aborted' : 'native_terminal_missing',
        };
        return;
      }
      yield outcomeEvent(this.target, prepared.request, observed.outcome, null);
      return;
    }
    const outcome = this.#outcomes.get(handle.session_id);
    if (!outcome) {
      yield { type: 'indeterminate', same_native_identity: true, evidence_strength: 1, error: 'native_outcome_missing' };
      return;
    }
    yield outcomeEvent(this.target, outcome.request, outcome, outcome.model_reported);
  }

  async cancel() { return { confirmed: false }; }

  async reconcile(native, context = {}) {
    if (this.target !== 'opencode') fail('reconcile_unsupported', `${this.target} does not support durable CLI reconciliation.`, {
      category: 'policy', submission: context.submission ?? 'may_have_been_sent',
    });
    if (!context.request || !context.control || typeof context.checkpoint !== 'function') {
      fail('native_observation_unavailable', 'Durable OpenCode reconciliation requires persisted request and control context.', {
        category: 'runtime', submission: context.submission ?? 'may_have_been_sent',
      });
    }
    const legacy = this.#legacyRequest(context.request, 'run', context.session ?? context.continuation ?? null);
    if (context.nativeProcess?.target !== 'opencode') {
      fail('native_process_identity_mismatch', 'Persisted durable process target does not match OpenCode.', {
        category: 'transport', submission: context.submission ?? 'may_have_been_sent',
      });
    }
    const persistedExecutable = context.nativeProcess?.executable_path;
    if (!this.testDriver && (typeof persistedExecutable !== 'string' || !persistedExecutable)) {
      fail('native_observation_unavailable', 'Durable OpenCode reconciliation requires persisted executable identity.', {
        category: 'runtime', submission: context.submission ?? 'may_have_been_sent',
      });
    }
    // Reconcile is parser-only. Build the OpenCode parser/argv contract from
    // persisted evidence without resolving the current installation and
    // without invoking any spawn path.
    let driver = this.testDriver ?? createOpenCodeDriver(legacy, context.request.workspace, persistedExecutable);
    if (this.testDriver) driver = decorateOpenCodeDriver(driver, legacy, context.request.workspace);
    const inspector = context.processInspector ?? (process.platform === 'win32' ? createProcessInspector() : null);
    const cancellation = cancellableSignal(context);
    let observed;
    try {
      observed = await observeDurableExecution({
        control: context.control,
        taskDirectory: context.taskDirectory,
        attemptId: context.attemptId,
        driver,
        checkpoint: context.checkpoint,
        inspector,
        lease: context.lease,
        signal: cancellation.signal,
        observationTimeoutMs: legacy.timeout_ms,
      });
    } finally {
      cancellation.cleanup();
    }
    if (!observed.outcome) {
      return {
        type: 'indeterminate', same_native_identity: native !== null || observed.handle !== null,
        evidence_strength: 1,
        native_status: native?.status ?? observed.handle?.status ?? null,
        error: observed.execution_timed_out
          ? observed.termination_confirmed ? 'execution_timeout' : 'execution_timeout_termination_unconfirmed'
          : observed.timed_out ? 'native_observation_timeout' : observed.aborted ? 'native_observation_aborted' : 'native_terminal_missing',
      };
    }
    const event = outcomeEvent(this.target, context.request, observed.outcome, null);
    event.same_native_identity = Boolean(native || observed.handle || observed.outcome?.result?.native_session_id);
    return event;
  }

  #legacyRequest(request, kind, session = null) {
    const sessionAction = session?.action ?? (session?.native_session_id ? 'continue' : null);
    return {
      request_id: request.request_id,
      target: this.target,
      model: this.target === 'opencode' ? request.route_id : this.target === 'workbuddy' ? 'workbuddy-default' : request.model_resolved,
      mode: request.mode,
      permission_policy: request.execution.permission,
      inputs: (request.inputs ?? []).map(input => ({ type: input.type, path: input.path, media_type: input.media_type ?? null })),
      expected_outputs: (request.expected_outputs ?? []).map(output => output.path),
      native_args: [...(request.execution?.native_args ?? [])],
      continue_session_id: sessionAction === 'continue' ? session.native_session_id : null,
      continue_from_task_id: sessionAction === 'continue' ? session.from_task_id : null,
      fork_session_id: sessionAction === 'fork' ? session.native_session_id : null,
      fork_from_task_id: sessionAction === 'fork' ? session.from_task_id : null,
      kind,
      ...(kind === 'run' ? { prompt: request.prompt } : {}),
      timeout_ms: request.execution.observation_timeout_ms,
      execution_timeout_ms: request.execution.execution_timeout_ms,
    };
  }
}

function decorateOpenCodeDriver(driver, legacy, workspace) {
  return {
    ...driver,
    createParser: driver.createParser ?? (publish => createOpenCodeParser(legacy, workspace, publish)),
    buildPrompt: driver.buildPrompt ?? (() => buildOpenCodePrompt(legacy, workspace)),
  };
}

function cancellableSignal(context) {
  const controller = new AbortController();
  let timer = null;
  let parentAbort = null;
  const abort = () => { if (!controller.signal.aborted) controller.abort(); };
  if (context?.signal?.aborted) abort();
  else if (context?.signal?.addEventListener) {
    parentAbort = abort;
    context.signal.addEventListener('abort', parentAbort, { once: true });
  }
  if (typeof context?.isCancelRequested === 'function') {
    const poll = () => {
      try { if (context.isCancelRequested()) abort(); } catch {}
    };
    poll();
    if (!controller.signal.aborted) {
      timer = setInterval(poll, 50);
      timer.unref?.();
    }
  }
  return {
    signal: controller.signal,
    cleanup() {
      if (timer) clearInterval(timer);
      if (parentAbort) context.signal.removeEventListener?.('abort', parentAbort);
    },
  };
}

function outcomeEvent(target, request, outcome, modelReported) {
  const type = outcome.status === 'succeeded' ? 'succeeded'
    : outcome.status === 'needs_user' ? 'waiting_user'
      : outcome.status === 'cancelled' ? 'cancelled'
        : outcome.status === 'failed' || outcome.status === 'blocked' ? 'failed' : 'indeterminate';
  const requested = request.model_resolved;
  const reported = modelReported;
  const verified = target === 'agy' && typeof reported === 'string' && reported === requested;
  return {
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
      evidence_ref: reported ? `${target}:native-model` : null,
    },
  };
}
