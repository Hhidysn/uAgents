import { childEnvironment } from '../runtime/child-environment.mjs';
import { runNoPromptCommand } from './no-prompt-command.mjs';

// Read an existing session only. Raw transcript stays in memory: do not log
// native stderr, credentials, provider bodies or export data on failures.
export async function readOpenCodeSession(entry, workspace, session, { runner = runNoPromptCommand } = {}) {
  if (typeof session !== 'string' || !/^ses_[A-Za-z0-9]+$/.test(session)) return null;
  try {
    const result = await runner(entry, ['session', 'export', session], {
      cwd: workspace, env: childEnvironment(), timeout: 5_000, maxBuffer: 8 * 1024 * 1024,
    });
    if (result.status !== 0 || result.error) return null;
    return JSON.parse(result.stdout);
  } catch { return null; }
}
