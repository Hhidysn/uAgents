import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const [, , mode, databaseFile, value] = process.argv;

function openDatabase(file) {
  const database = new DatabaseSync(file);
  database.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 10000;');
  return database;
}

if (mode === '--child') {
  const database = openDatabase(databaseFile);
  try {
    database.exec('BEGIN IMMEDIATE');
    database.prepare('INSERT OR IGNORE INTO unique_values(value) VALUES (?)').run(value);
    database.exec('COMMIT');
  } catch (error) {
    try { database.exec('ROLLBACK'); } catch {}
    throw error;
  } finally {
    database.close();
  }
  process.exit(0);
}

if (mode === '--hold-lock') {
  const database = openDatabase(databaseFile);
  database.exec('BEGIN IMMEDIATE');
  database.prepare('INSERT INTO crash_probe(value) VALUES (?)').run(value);
  process.stdout.write('ready\n');
  setInterval(() => {}, 60_000);
} else {
  await main();
}

async function main() {
  const base = path.resolve('.local', 'sqlite-spike');
  fs.mkdirSync(base, { recursive: true });
  const directory = fs.mkdtempSync(path.join(base, 'SQLite 中文 空格-'));
  const file = path.join(directory, '控制面.db');
  const database = openDatabase(file);
  const journalMode = database.prepare('PRAGMA journal_mode = WAL').get().journal_mode;
  database.exec(`
    CREATE TABLE unique_values(value TEXT PRIMARY KEY);
    CREATE TABLE rollback_probe(value TEXT NOT NULL);
    CREATE TABLE crash_probe(value TEXT NOT NULL);
  `);

  database.exec('BEGIN');
  database.prepare('INSERT INTO rollback_probe(value) VALUES (?)').run('must rollback');
  database.exec('ROLLBACK');
  const rollbackCount = Number(database.prepare('SELECT count(*) AS count FROM rollback_probe').get().count);
  database.close();

  const concurrentKey = randomUUID();
  const children = Array.from({ length: 32 }, () => runChild(['--child', file, concurrentKey]));
  const childResults = await Promise.all(children);
  const childFailures = childResults.filter(result => result.code !== 0);

  const afterConcurrency = openDatabase(file);
  const uniqueCount = Number(afterConcurrency.prepare('SELECT count(*) AS count FROM unique_values WHERE value = ?').get(concurrentKey).count);
  afterConcurrency.close();

  const lockValue = randomUUID();
  const lockHolder = spawn(process.execPath, [fileURLToPath(import.meta.url), '--hold-lock', file, lockValue], {
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  await waitForReady(lockHolder);
  lockHolder.kill('SIGKILL');
  await new Promise(resolve => lockHolder.once('close', resolve));

  const afterCrash = openDatabase(file);
  afterCrash.prepare('INSERT INTO crash_probe(value) VALUES (?)').run('after crash');
  const crashRows = Number(afterCrash.prepare('SELECT count(*) AS count FROM crash_probe').get().count);
  afterCrash.close();

  const result = {
    ok: journalMode.toLowerCase() === 'wal' && rollbackCount === 0 && childFailures.length === 0 && uniqueCount === 1 && crashRows === 1,
    node: process.version,
    platform: `${process.platform}-${process.arch}`,
    sqlite: process.versions.sqlite ?? null,
    journal_mode: journalMode,
    rollback_count: rollbackCount,
    concurrent_processes: children.length,
    child_failures: childFailures,
    unique_rows: uniqueCount,
    crash_recovery_rows: crashRows,
    path_case: path.relative(process.cwd(), file),
    host_temp: os.tmpdir(),
  };
  fs.rmSync(directory, { recursive: true, force: true });
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) process.exitCode = 1;
}

function runChild(args) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [fileURLToPath(import.meta.url), ...args], {
      stdio: ['ignore', 'ignore', 'pipe'],
      windowsHide: true,
    });
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.once('close', code => resolve({ code, stderr: stderr.slice(0, 500) }));
  });
}

function waitForReady(child) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Crash-recovery child did not acquire its transaction.')), 10_000);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      if (chunk.includes('ready')) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.once('error', error => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('exit', code => {
      if (code !== null && code !== 0) {
        clearTimeout(timer);
        reject(new Error(`Crash-recovery child exited early: ${code}`));
      }
    });
  });
}
