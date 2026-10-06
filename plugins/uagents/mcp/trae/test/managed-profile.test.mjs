import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { Readable } from 'node:stream';
const require = createRequire(import.meta.url);
const { buildReuseWindowCommand } = require('../.build/package/src/config/quickstart.js');
const { handleSubmit } = require('../.build/package/src/http/handlers/unified-agent.js');

test('workspace commands keep the managed profile as one native argument', () => {
  const previous = process.env.TRAECN_USER_DATA_DIR;
  try {
    process.env.TRAECN_USER_DATA_DIR = 'C:\\managed profile\\trae\\9';
    const command = buildReuseWindowCommand('C:\\TRAE\\Trae CN.exe', 'F:\\test workspace', { platform: 'win32' });
    assert.deepEqual(command.commandArgs, ['--user-data-dir=C:\\managed profile\\trae\\9', '--reuse-window', 'F:\\test workspace']);
    delete process.env.TRAECN_USER_DATA_DIR;
    assert.deepEqual(buildReuseWindowCommand('trae', '/workspace', { platform: 'linux' }).commandArgs, ['--reuse-window', '/workspace']);
  } finally {
    if (previous === undefined) delete process.env.TRAECN_USER_DATA_DIR;
    else process.env.TRAECN_USER_DATA_DIR = previous;
  }
});

test('task admission persists identity before slow workspace preparation', async () => {
  const request = Readable.from([JSON.stringify({ message: 'Summarize the two trade-offs of a command-line interface.', workspace: 'F:\\test workspace', mode: 'solo', newConversation: true })]);
  request.headers = { 'idempotency-key': 'test-request' };
  const calls = [];
  const ctx = {
    driver: {},
    _fingerprintTaskRequest: () => 'fingerprint',
    _resolveTaskIdempotency: () => null,
    _ensureConnection: async () => { calls.push('connection'); },
    _ensureRequestedWorkspace: async () => { throw new Error('must run only after admission'); },
    _createQueuedTask: body => { calls.push('persist'); assert.equal(body.projectPath, 'F:\\test workspace'); return { taskId: 'native-task' }; },
    _ensureBackgroundPolling: () => { calls.push('polling'); },
    _json: (_req, _res, data, status) => { calls.push('response'); return { data, status }; },
  };
  const response = await handleSubmit(request, {}, ctx);
  assert.deepEqual(response, { data: { taskId: 'native-task', status: 'accepted' }, status: 202 });
  assert.deepEqual(calls, ['connection', 'persist', 'polling', 'response']);
});

