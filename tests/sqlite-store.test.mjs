import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { ControlDatabase } from '../plugins/uagents/src/store/database.mjs';
import { TaskService } from '../plugins/uagents/src/runtime/task-service.mjs';

const base = path.resolve('.local', 'test-runs', randomUUID(), 'SQLite Store 中文');
fs.mkdirSync(base, { recursive: true });
const request = patch => ({
  schema_version: '1.0', request_id: randomUUID(), target: 'opencode',
  model: 'commandcode-goat/deepseek/deepseek-v4-flash', mode: 'analysis', prompt: 'private prompt value',
  execution: { observation_timeout_ms: 10_000, effort: 'medium', permission: 'native' },
  policy: { fallback: 'none', max_cost_usd: null }, ...patch,
});

test('store creates one task and attempt and keeps prompt out of control rows', () => {
  const root = path.join(base, 'single');
  const control = new ControlDatabase(root);
  try {
    const service = new TaskService(control);
    const input = request();
    const first = service.submit(input, { adapterVersion: 'fixture-1' });
    const duplicate = service.submit(input, { adapterVersion: 'fixture-1' });
    assert.equal(first.duplicate, false);
    assert.equal(duplicate.duplicate, true);
    assert.equal(first.task_id, input.request_id);
    assert.equal(first.attempt.attempt_id, duplicate.attempt.attempt_id);
    assert.equal(control.raw.prepare('SELECT count(*) AS count FROM tasks').get().count, 1);
    assert.equal(control.raw.prepare('SELECT count(*) AS count FROM attempts').get().count, 1);
    assert.equal(control.raw.prepare('SELECT count(*) AS count FROM events').get().count, 1);
    assert.doesNotMatch(JSON.stringify(control.raw.prepare('SELECT * FROM tasks').get()), /private prompt value/);
    assert.equal(service.payload(input.request_id).payload.prompt, 'private prompt value');
    assert.throws(() => service.submit({ ...input, prompt: 'changed' }), { code: 'request_conflict' });
  } finally { control.close(); }
});

test('32 independent processes register exactly one attempt for one UUID', async () => {
  const root = path.join(base, 'concurrent');
  fs.mkdirSync(root, { recursive: true });
  const input = request();
  const requestFile = path.join(base, 'concurrent-request.json');
  fs.writeFileSync(requestFile, JSON.stringify(input));
  const fixture = fileURLToPath(new URL('./fixtures/sqlite-submit-child.mjs', import.meta.url));
  const results = await Promise.all(Array.from({ length: 32 }, () => child(fixture, root, requestFile)));
  assert.deepEqual([...new Set(results.map(result => result.task_id))], [input.request_id]);
  assert.equal(new Set(results.map(result => result.attempt_id)).size, 1);
  assert.equal(results.filter(result => result.duplicate === false).length, 1);
  const control = new ControlDatabase(root);
  try {
    assert.equal(control.raw.prepare('SELECT count(*) AS count FROM tasks').get().count, 1);
    assert.equal(control.raw.prepare('SELECT count(*) AS count FROM attempts').get().count, 1);
  } finally { control.close(); }
});

function child(fixture, root, requestFile) {
  return new Promise((resolve, reject) => {
    const processChild = spawn(process.execPath, [fixture, root, requestFile], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    processChild.stdout.setEncoding('utf8'); processChild.stderr.setEncoding('utf8');
    processChild.stdout.on('data', value => { stdout += value; });
    processChild.stderr.on('data', value => { stderr += value; });
    processChild.once('error', reject);
    processChild.once('close', code => code === 0 ? resolve(JSON.parse(stdout)) : reject(new Error(`child ${code}: ${stderr}`)));
  });
}
