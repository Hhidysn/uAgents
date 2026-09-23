// Child Worker deliberately crashes or is killed at a selected dispatch boundary.
import { fileURLToPath } from 'node:url';
import { ControlDatabase } from '../../plugins/uagents/src/store/database.mjs';
import { TaskService } from '../../plugins/uagents/src/runtime/task-service.mjs';
import { runTask } from '../../plugins/uagents/src/runtime/worker.mjs';
import { CodexAdapter } from '../../plugins/uagents/src/adapters/codex/adapter.mjs';
import { invokeCodexAppServerTurn } from '../../plugins/uagents/src/transports/codex-app-server.mjs';

const [stateRoot, workspace, taskId, crashPoint = 'accepted'] = process.argv.slice(2);
const entry = fileURLToPath(new URL('./fake-codex-app-server.mjs', import.meta.url));
const control = new ControlDatabase(stateRoot);
const service = new TaskService(control);
const input = { schema_version: '1.0', request_id: taskId, target: 'codex',
  model: 'gpt-5.6-luna', mode: 'analysis', prompt: crashPoint === 'after-send-before-ack'
    ? 'fixture-crash-after-send-saved' : 'fixture-crash-after-accepted-saved', workspace,
  execution: { observation_timeout_ms: 5_000, effort: 'low', permission: 'native' },
  policy: { fallback: 'none', max_cost_usd: null } };
service.submit(input, { adapterVersion: 'codex-app-server-crash-fixture' });
class CrashAdapter extends CodexAdapter {
  async dispatch(prepared, context) {
    await invokeCodexAppServerTurn({ entry, request: prepared.request, workspace,
      processEvidence: { control: context.control, attemptId: context.attemptId,
        lease: context.lease, taskDirectory: context.taskDirectory,
        coreVersion: context.coreVersion, adapterVersion: context.adapterVersion },
      beforeSend(threadId) { context.checkpoint('possibly_sent', { native_session_id: threadId,
        installation_fingerprint: prepared.installationFingerprint });
        if (crashPoint === 'possibly-sent') process.exit(43);
      },
      onAccepted(handle) {
        context.checkpoint('accepted', { handle, evidence_ref: 'codex:app-server-thread-turn' });
        if (crashPoint === 'accepted') process.exit(42);
      },
    });
    throw Error('Expected the Worker to crash after accepted.');
  }
}
await runTask({ service, taskId, adapter: new CrashAdapter({ transport: 'app-server',
  entryResolver: async () => ({ canonical_path: entry }) }),
  leaseOptions: { ttlMs: 1_000, taskLeaseTtlMs: 1_000, heartbeatIntervalMs: 100 } });
