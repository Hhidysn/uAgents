import path from 'node:path';
import { fileURLToPath } from 'node:url';

const agentFile = fileURLToPath(new URL('./durable-cli-agent.mjs', import.meta.url));

export function createDurableFixtureDriver(markerDirectory, { mode = 'normal' } = {}) {
  return {
    command: process.execPath,
    args: [agentFile, path.resolve(markerDirectory), mode],
    env: { ...process.env },
    evidenceRef: 'fixture:native-session',
    createParser(publish) {
      let sessionId = null;
      let terminal = null;
      const progress = [];
      return {
        line(text) {
          const event = JSON.parse(text);
          if (event.type === 'session') {
            if (sessionId && sessionId !== event.session_id) {
              const error = new Error('fixture session changed');
              error.code = 'native_session_mismatch';
              throw error;
            }
            sessionId = event.session_id;
            publish({ native_session_id: sessionId, model_reported: 'fixture-model' });
          } else if (event.type === 'progress') {
            progress.push(event.text);
          } else if (event.type === 'terminal') {
            terminal = event.response;
          }
        },
        stderr() {},
        finish(code) {
          if (code === 0 && sessionId && terminal) {
            return {
              status: 'succeeded',
              native_status: 'stop',
              result: { native_session_id: sessionId, response: terminal, usage: null },
              progress: [...progress],
            };
          }
          return {
            status: 'unknown',
            error: 'native_completion_unconfirmed',
            native_exit_code: code,
            ...(sessionId ? { result: { native_session_id: sessionId, response: terminal ?? '', usage: null } } : {}),
          };
        },
      };
    },
  };
}
