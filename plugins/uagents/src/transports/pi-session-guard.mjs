// JSON mode emits a session header only once. Keep that session fixed for the
// tracked task while retaining the host's other extensions and permissions.
import { writeSync } from 'node:fs';

export default function registerSessionGuard(pi) {
  // Pi redirects extension stdout to stderr in JSON mode. Use the raw fd for
  // the bounded protocol records, without exposing prompts or credentials.
  const emit = event => writeSync(1, `${JSON.stringify(event)}\n`);
  const identity = (ctx, phase) => emit({ type: 'uagents_pi_identity', phase, id: ctx.sessionManager.getSessionId(), cwd: ctx.sessionManager.getCwd() });
  pi.on('session_start', (_event, ctx) => identity(ctx, 'startup'));
  pi.on('agent_settled', (_event, ctx) => identity(ctx, 'settled'));
  pi.on('session_shutdown', (event, ctx) => {
    if (event.reason === 'reload') emit({ type: 'uagents_pi_guard_invalidated' });
    else if (event.reason === 'quit') identity(ctx, 'quit');
  });
  for (const type of ['session_before_switch', 'session_before_fork', 'session_before_tree']) {
    pi.on(type, () => {
      // A broken stdout must never turn a refused replacement into permission.
      try { emit({ type: 'uagents_pi_session_change_blocked' }); } catch {}
      return { cancel: true };
    });
  }
}
