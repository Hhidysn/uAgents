import { BUILTIN_REGISTRY } from '../../registry/builtins.mjs';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fail } from '../../protocol/errors.mjs';
import { uuidPattern } from '../../protocol/schema.mjs';
import { codexExecArgs, invokeCodexExec, locateCodexEntry, prepareCodexImages, probeCodexVersion } from '../../transports/codex-process.mjs';
import { invokeCodexAppServerTurn, readCodexAppServerTurn } from '../../transports/codex-app-server.mjs';
import { refreshWorkspaceExecutionGuard } from '../../runtime/workspace-execution-guard.mjs';

export class CodexAdapter {
  #entryResolver;
  #transport;
  #outcomes = new Map();

  constructor({ testDriver = null, entryResolver = null, transport = 'exec' } = {}) {
    this.target = 'codex';
    this.testDriver = testDriver;
    this.#entryResolver = typeof entryResolver === 'function' ? entryResolver : null;
    if (!['exec', 'app-server'].includes(transport)) fail('invalid_request', 'Unknown Codex transport.');
    this.#transport = transport;
  }

  descriptor() {
    return {
      target: 'codex',
      ...structuredClone(BUILTIN_REGISTRY.targets.codex),
      ...(this.#transport === 'app-server' ? { transport: 'app-server-stdio-prototype' } : {}),
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
    const session = context.session ?? null;
    if (Boolean(request.session) !== Boolean(session) || request.session &&
        (session.action !== (request.session.fork_from_task_id ? 'fork' : 'continue') ||
          session.from_task_id !== (request.session.continue_from_task_id ?? request.session.fork_from_task_id))) {
      fail('invalid_native_session', 'Codex native session binding is missing or mismatched.', {
        category: 'policy', submission: 'not_sent',
      });
    }
    const entry = await this.#entry(context);
    const imagePaths = prepareCodexImages(request, request.workspace, context.inputSnapshots ?? []);
    let installationFingerprint = null;
    if (this.#transport === 'app-server') {
      if (session && (session.native_transport !== 'app-server' ||
          !uuidPattern.test(session.native_session_id ?? '') || !uuidPattern.test(session.native_turn_id ?? ''))) {
        fail('invalid_native_session', 'Codex app-server requires a completed app-server source Turn.', {
          category: 'policy', submission: 'not_sent',
        });
      }
      const version = await probeCodexVersion(entry, { spawnImpl: this.testDriver?.spawn });
      if (version.status !== 'succeeded') fail('installation_untrusted', 'Codex CLI version probe failed before native dispatch.', {
        category: 'target', submission: 'not_sent',
      });
      let entryBytes;
      try { entryBytes = await readFile(entry); }
      catch { fail('installation_untrusted', 'Codex CLI entry could not be read before native dispatch.', {
        category: 'target', submission: 'not_sent',
      }); }
      const canonicalEntry = path.resolve(entry);
      const nativeBinary = await codexNativeBinaryIdentity(canonicalEntry);
      installationFingerprint = createHash('sha256').update(JSON.stringify({
        transport: 'app-server', path: process.platform === 'win32' ? canonicalEntry.toLowerCase() : canonicalEntry,
        version: version.version,
        entry_sha256: createHash('sha256').update(entryBytes).digest('hex'),
        native_binary: nativeBinary,
      })).digest('hex');
      if (session && session.installation_fingerprint !== installationFingerprint) {
        fail('invalid_native_session', 'Codex CLI installation changed since the source Turn.', {
          category: 'policy', submission: 'not_sent',
        });
      }
    } else {
      if (session?.native_transport) fail('invalid_native_session', 'Codex exec cannot resume an unverified app-server thread.', {
        category: 'policy', submission: 'not_sent',
      });
      codexExecArgs(request, request.workspace, entry, session, imagePaths); // Validate before native send.
    }
    return { request, entry, session, installationFingerprint,
      imagePaths,
      taskDirectory: context.taskDirectory ?? request.workspace };
  }

  async dispatch(prepared, context) {
    let possiblySent = false;
    let handle = null;
    const shared = {
      entry: prepared.entry,
      request: prepared.request,
      workspace: prepared.request.workspace,
      imagePaths: prepared.imagePaths,
      spawnImpl: this.testDriver?.spawn,
      signal: context.signal,
      isCancelRequested: context.isCancelRequested,
      onAccepted: accepted => {
        context.checkpoint('accepted', { handle: accepted,
          evidence_ref: this.#transport === 'app-server' ? 'codex:app-server-thread-turn' : 'codex:thread' });
        handle = accepted;
      },
    };
    const outcome = this.#transport === 'app-server'
      ? await invokeCodexAppServerTurn({ ...shared, session: prepared.session, beforeSend: threadId => {
        context.checkpoint('possibly_sent', { native_session_id: threadId,
          installation_fingerprint: prepared.installationFingerprint });
        possiblySent = true;
      }, appServerArgs: this.testDriver?.appServerArgs ?? [],
      processEvidence: context.control ? { control: context.control, attemptId: context.attemptId,
        lease: context.lease, taskDirectory: context.taskDirectory, inspector: context.processInspector,
        coreVersion: context.coreVersion, adapterVersion: context.adapterVersion } : null })
      : await invokeCodexExec({ ...shared, session: prepared.session, publish: patch => {
        if (patch.submission === 'may_have_been_sent' && !possiblySent) {
          context.checkpoint('possibly_sent');
          possiblySent = true;
        }
      } });
    if (!possiblySent) {
      const code = outcome.error ?? 'native_preflight_failed';
      throw Object.assign(new Error(code), { code, submission: 'not_sent' });
    }
    if (!handle) return { handle: { session_id: null, task_id: null, status: outcome.native_status ?? null }, outcome };
    this.#outcomes.set(handle.task_id ?? handle.session_id, outcome);
    return { handle };
  }

  async *observe(handle) {
    const outcome = this.#outcomes.get(handle?.task_id ?? handle?.session_id);
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

  async cancel(handle) {
    const outcome = this.#outcomes.get(handle?.task_id ?? handle?.session_id);
    const confirmed = this.#transport === 'app-server' && outcome?.status === 'cancelled' &&
      outcome.native_status === 'interrupted' && outcome.launcher_close_confirmed === true &&
      outcome.process_tree_quiescent === true;
    return { confirmed, ...(confirmed ? { native_status: 'interrupted', evidence_strength: 2 }
      : { error: outcome?.error ?? 'cancel_remote_state_unknown',
        ...(outcome?.native_status ? { native_status: outcome.native_status } : {}) }) };
  }

  async reconcile(native, context = {}) {
    const accepted = native?.evidence_ref === 'codex:app-server-thread-turn' && uuidPattern.test(native.task_id ?? '');
    const possible = native?.evidence_ref === 'codex:app-server-possible-turn' && !native.task_id &&
      uuidPattern.test(context.request?.request_id ?? '');
    if (this.#transport === 'app-server' && uuidPattern.test(native?.session_id ?? '') && (accepted || possible)) {
      if (context.nativeProcess && context.control) {
        const process = await refreshWorkspaceExecutionGuard(context.control, context.nativeProcess.attempt_id,
          { inspector: context.processInspector ?? null });
        if (process?.workspace_guard_state !== 'released') {
          return { type: 'indeterminate', same_native_identity: true, evidence_strength: 1,
            error: 'process_tree_unconfirmed' };
        }
      }
      const observation = await readCodexAppServerTurn({ entry: await this.#entry(context),
        workspace: context.request.workspace, threadId: native.session_id,
        ...(accepted ? { turnId: native.task_id } : { clientRequestId: context.request.request_id }),
        spawnImpl: this.testDriver?.spawn });
      if (possible && uuidPattern.test(observation.native_turn_id ?? '')) {
        context.checkpoint('accepted', { handle: { session_id: native.session_id,
          task_id: observation.native_turn_id, status: 'accepted' }, evidence_ref: 'codex:app-server-thread-turn' });
      }
      return observation;
    }
    fail('reconcile_unsupported', 'Codex CLI durable reconciliation is not available in v1.', {
      category: 'policy', submission: context.submission ?? 'may_have_been_sent',
    });
  }
}

async function codexNativeBinaryIdentity(entry) {
  if (path.basename(entry).toLowerCase() !== 'codex.js') return null; // Local protocol fixtures.
  const targets = {
    'win32:x64': ['@openai/codex-win32-x64', 'x86_64-pc-windows-msvc'],
    'win32:arm64': ['@openai/codex-win32-arm64', 'aarch64-pc-windows-msvc'],
    'linux:x64': ['@openai/codex-linux-x64', 'x86_64-unknown-linux-musl'],
    'linux:arm64': ['@openai/codex-linux-arm64', 'aarch64-unknown-linux-musl'],
    'darwin:x64': ['@openai/codex-darwin-x64', 'x86_64-apple-darwin'],
    'darwin:arm64': ['@openai/codex-darwin-arm64', 'aarch64-apple-darwin'],
  };
  const target = targets[`${process.platform}:${process.arch}`];
  if (!target) fail('installation_untrusted', 'Codex CLI native platform is unsupported.', {
    category: 'target', submission: 'not_sent',
  });
  const [packageName, triple] = target;
  let vendorRoot;
  try {
    const require = createRequire(entry);
    vendorRoot = path.join(path.dirname(require.resolve(`${packageName}/package.json`)), 'vendor');
  } catch { vendorRoot = path.join(path.dirname(entry), '..', 'vendor'); }
  const nativePath = path.resolve(vendorRoot, triple, 'bin', process.platform === 'win32' ? 'codex.exe' : 'codex');
  const hash = createHash('sha256');
  try { for await (const chunk of createReadStream(nativePath)) hash.update(chunk); }
  catch { fail('installation_untrusted', 'Codex CLI native executable could not be hashed.', {
    category: 'target', submission: 'not_sent',
  }); }
  return { path: process.platform === 'win32' ? nativePath.toLowerCase() : nativePath,
    sha256: hash.digest('hex') };
}
