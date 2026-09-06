import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { ControlDatabase } from '../plugins/uagents/src/store/database.mjs';
import { TaskService } from '../plugins/uagents/src/runtime/task-service.mjs';

const base = path.resolve('.local', 'test-runs', randomUUID(), 'SQLite Store 中文');
fs.mkdirSync(base, { recursive: true });
const v2Fixture = fileURLToPath(new URL('./fixtures/control-v2.sql', import.meta.url));
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

test('fresh control database initializes schema v3 with an empty native process ledger', () => {
  const root = path.join(base, 'fresh-v3');
  const control = new ControlDatabase(root);
  try {
    assert.equal(control.raw.prepare("SELECT value FROM metadata WHERE key = 'schema_version'").get().value, '3');
    assert.equal(control.raw.prepare("SELECT count(*) AS count FROM native_processes").get().count, 0);
    const indexes = new Set(control.raw.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all().map(row => row.name));
    assert.equal(indexes.has('native_process_attempt_idx'), true);
    assert.equal(indexes.has('native_process_guard_idx'), true);
  } finally { control.close(); }
});

test('real schema-v2 fixture migrates transactionally to v3 and reopens idempotently', () => {
  const root = createV2Fixture('v2-migrate');
  const before = snapshotV2Rows(root);
  let control = new ControlDatabase(root);
  try {
    assert.equal(control.raw.prepare("SELECT value FROM metadata WHERE key = 'schema_version'").get().value, '3');
    assert.equal(control.raw.prepare('SELECT count(*) AS count FROM native_processes').get().count, 0);
    assert.deepEqual(snapshotRows(control.raw), before);
  } finally { control.close(); }

  control = new ControlDatabase(root);
  try {
    assert.equal(control.raw.prepare("SELECT value FROM metadata WHERE key = 'schema_version'").get().value, '3');
    assert.equal(control.raw.prepare('SELECT count(*) AS count FROM native_processes').get().count, 0);
    assert.deepEqual(snapshotRows(control.raw), before);
  } finally { control.close(); }
});

for (const status of ['starting', 'running', 'waiting_user', 'indeterminate']) {
  test(`schema-v2 ${status} task blocks automatic migration without mutation`, () => {
    const root = createV2Fixture(`blocked-status-${status}`);
    mutateDb(root, database => database.prepare('UPDATE tasks SET status = ?').run(status));
    const journalBefore = journalMode(root);
    assert.throws(() => new ControlDatabase(root), error => {
      assert.equal(error.code, 'store_migration_blocked');
      assert.equal(error.category, 'runtime');
      assert.equal(error.retryable, true);
      assert.equal(error.submission, 'not_sent');
      assert.deepEqual(error.details?.blockers, [{ task_id: 'fixture-task-v2', status, submission: 'not_sent' }]);
      return true;
    });
    assertUnmigratedV2(root);
    assert.equal(journalMode(root), journalBefore);
  });
}

for (const submission of ['may_have_been_sent', 'sent']) {
  test(`schema-v2 ${submission} latest attempt blocks automatic migration without mutation`, () => {
    const root = createV2Fixture(`blocked-submission-${submission}`);
    mutateDb(root, database => database.prepare('UPDATE attempts SET submission = ?').run(submission));
    assert.throws(() => new ControlDatabase(root), error => {
      assert.equal(error.code, 'store_migration_blocked');
      assert.equal(error.retryable, true);
      assert.deepEqual(error.details?.blockers, [{ task_id: 'fixture-task-v2', status: 'queued', submission }]);
      return true;
    });
    assertUnmigratedV2(root);
  });
}

for (const status of ['succeeded', 'failed', 'cancelled']) {
  test(`schema-v2 terminal ${status} + sent is historical and migrates without fabricating process evidence`, () => {
    const root = createV2Fixture(`terminal-${status}`);
    mutateDb(root, database => {
      database.prepare('UPDATE tasks SET status = ?').run(status);
      database.prepare("UPDATE attempts SET status = ?, submission = 'sent', finished_at_ms = 2000").run(status);
    });
    const control = new ControlDatabase(root);
    try {
      assert.equal(control.raw.prepare("SELECT value FROM metadata WHERE key = 'schema_version'").get().value, '3');
      assert.equal(control.raw.prepare('SELECT count(*) AS count FROM native_processes').get().count, 0);
      assert.equal(control.raw.prepare('SELECT status FROM tasks').get().status, status);
      assert.equal(control.raw.prepare('SELECT submission FROM attempts').get().submission, 'sent');
    } finally { control.close(); }
  });
}

test('schema-v2 terminal task with may_have_been_sent remains ambiguous and blocks migration', () => {
  const root = createV2Fixture('terminal-ambiguous');
  mutateDb(root, database => {
    database.prepare("UPDATE tasks SET status = 'failed'").run();
    database.prepare("UPDATE attempts SET status = 'failed', submission = 'may_have_been_sent', finished_at_ms = 2000").run();
  });
  assert.throws(() => new ControlDatabase(root), error => {
    assert.equal(error.code, 'store_migration_blocked');
    assert.deepEqual(error.details?.blockers, [{ task_id: 'fixture-task-v2', status: 'failed', submission: 'may_have_been_sent' }]);
    return true;
  });
  assertUnmigratedV2(root);
});

for (const status of ['registered', 'queued']) {
  test(`schema-v2 ${status} + not_sent task is safe to migrate`, () => {
    const root = createV2Fixture(`safe-${status}`);
    mutateDb(root, database => database.prepare('UPDATE tasks SET status = ?').run(status));
    const control = new ControlDatabase(root);
    try {
      assert.equal(control.raw.prepare("SELECT value FROM metadata WHERE key = 'schema_version'").get().value, '3');
      assert.equal(control.raw.prepare('SELECT count(*) AS count FROM native_processes').get().count, 0);
    } finally { control.close(); }
  });
}

test('unknown future store version fails closed without adding v3 schema', () => {
  const root = createV2Fixture('future-version');
  mutateDb(root, database => database.prepare("UPDATE metadata SET value = '99' WHERE key = 'schema_version'").run());
  const journalBefore = journalMode(root);
  assert.throws(() => new ControlDatabase(root), { code: 'incompatible_store_version' });
  const database = openRaw(root);
  try {
    assert.equal(database.prepare("SELECT value FROM metadata WHERE key = 'schema_version'").get().value, '99');
    assert.equal(hasTable(database, 'native_processes'), false);
  } finally { database.close(); }
  assert.equal(journalMode(root), journalBefore);
});

test('nonempty database without schema metadata fails closed without mutation', () => {
  const root = path.join(base, 'partial-no-metadata');
  fs.mkdirSync(root, { recursive: true });
  const database = openRaw(root);
  database.exec('CREATE TABLE legacy_partial(value TEXT) STRICT; INSERT INTO legacy_partial(value) VALUES (\'keep-me\');');
  database.close();
  const journalBefore = journalMode(root);

  assert.throws(() => new ControlDatabase(root), { code: 'incompatible_store_version' });
  const reopened = openRaw(root);
  try {
    assert.equal(reopened.prepare('SELECT value FROM legacy_partial').get().value, 'keep-me');
    assert.equal(hasTable(reopened, 'metadata'), false);
    assert.equal(hasTable(reopened, 'native_processes'), false);
  } finally { reopened.close(); }
  assert.equal(journalMode(root), journalBefore);
});

test('schema-v3 with expected object names but malformed native process shape fails closed', () => {
  const root = createV2Fixture('malformed-v3');
  mutateDb(root, database => {
    database.exec(`
      CREATE TABLE native_processes (
        attempt_id TEXT,
        workspace_guard_state TEXT,
        process_state TEXT
      ) STRICT;
      CREATE INDEX native_process_attempt_idx ON native_processes(attempt_id);
      CREATE INDEX native_process_guard_idx ON native_processes(workspace_guard_state, process_state);
    `);
    database.prepare("UPDATE metadata SET value = '3' WHERE key = 'schema_version'").run();
  });
  const journalBefore = journalMode(root);
  assert.throws(() => new ControlDatabase(root), { code: 'incompatible_store_version' });
  assert.equal(journalMode(root), journalBefore);
  const database = openRaw(root);
  try {
    assert.equal(database.prepare("SELECT value FROM metadata WHERE key = 'schema_version'").get().value, '3');
    assert.deepEqual(database.prepare("PRAGMA table_info('native_processes')").all().map(row => row.name), [
      'attempt_id', 'workspace_guard_state', 'process_state',
    ]);
  } finally { database.close(); }
});

test('failed v2 migration rolls back partial migration objects and preserves metadata version', () => {
  const root = createV2Fixture('migration-rollback');
  mutateDb(root, database => database.exec('CREATE TABLE native_processes(attempt_id TEXT) STRICT;'));
  const journalBefore = journalMode(root);
  assert.throws(() => new ControlDatabase(root), error => {
    assert.equal(error.code, 'incompatible_store_version');
    assert.equal(error.details?.cause_code, 'migration_failed');
    return true;
  });
  assert.equal(journalMode(root), journalBefore);
  const database = openRaw(root);
  try {
    assert.equal(database.prepare("SELECT value FROM metadata WHERE key = 'schema_version'").get().value, '2');
    assert.equal(Boolean(database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'native_process_attempt_idx'").get()), false);
    assert.equal(Boolean(database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'native_process_guard_idx'").get()), false);
    assert.deepEqual(database.prepare("PRAGMA table_info('native_processes')").all().map(row => row.name), ['attempt_id']);
  } finally { database.close(); }
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

function createV2Fixture(name) {
  const root = path.join(base, `${name}-${randomUUID()}`);
  fs.mkdirSync(root, { recursive: true });
  const database = openRaw(root);
  try { database.exec(fs.readFileSync(v2Fixture, 'utf8')); }
  finally { database.close(); }
  return root;
}

function openRaw(root) {
  return new DatabaseSync(path.join(root, 'control.db'));
}

function journalMode(root) {
  const database = openRaw(root);
  try { return String(database.prepare('PRAGMA journal_mode').get().journal_mode).toLowerCase(); }
  finally { database.close(); }
}

function mutateDb(root, operation) {
  const database = openRaw(root);
  try { operation(database); }
  finally { database.close(); }
}

function hasTable(database, name) {
  return Boolean(database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name));
}

function assertUnmigratedV2(root) {
  const database = openRaw(root);
  try {
    assert.equal(database.prepare("SELECT value FROM metadata WHERE key = 'schema_version'").get().value, '2');
    assert.equal(hasTable(database, 'native_processes'), false);
  } finally { database.close(); }
}

function snapshotV2Rows(root) {
  const database = openRaw(root);
  try { return snapshotRows(database); }
  finally { database.close(); }
}

function snapshotRows(database) {
  return {
    tasks: database.prepare('SELECT * FROM tasks ORDER BY task_id').all(),
    attempts: database.prepare('SELECT * FROM attempts ORDER BY attempt_id').all(),
    native_sessions: database.prepare('SELECT * FROM native_sessions ORDER BY id').all(),
    events: database.prepare('SELECT * FROM events ORDER BY id').all(),
    leases: database.prepare('SELECT * FROM leases ORDER BY resource_key').all(),
    idempotency: database.prepare('SELECT * FROM idempotency ORDER BY request_id').all(),
  };
}
