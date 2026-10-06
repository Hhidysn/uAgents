import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';

const packageRoot = path.resolve(process.argv[2] ?? '');
const stateRoot = path.resolve(process.argv[3] ?? '');

if (!process.argv[2] || !process.argv[3]) {
  throw new Error('Usage: node scripts/verify-installed-package.mjs <package-root> <state-root>');
}

for (const forbidden of ['third-part-research', 'node_modules', '.git', '.local', '.codex-plugin']) {
  assert.equal(fs.existsSync(path.join(packageRoot, forbidden)), false, `installed package contains ${forbidden}`);
}

const manifest = JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8'));
assert.equal(manifest.name, 'uagents');
assert.match(manifest.version, /^0\.2\.0-alpha\.1$/);
assert.equal(manifest.license, 'MIT');
assert.equal(manifest.engines.node, '>=22.14.0');
assert.equal(manifest.bin.uagents, './bin/uagents.mjs');

const references = ['agy.md', 'codex.md', 'workbuddy.md', 'dsh.md', 'opencode-council.md', 'doubao-work.md', 'trae-cn.md'];
const skillRoot = path.join(packageRoot, 'skills', 'agent-dispatch');
assert.ok(fs.statSync(path.join(skillRoot, 'SKILL.md')).isFile());
for (const reference of references) {
  assert.ok(fs.statSync(path.join(skillRoot, 'references', reference)).isFile());
}

fs.mkdirSync(stateRoot, { recursive: true });
const isolatedHome = path.join(stateRoot, 'home');
fs.mkdirSync(isolatedHome, { recursive: true });
const childEnv = {
  ...process.env,
  HOME: isolatedHome,
  USERPROFILE: isolatedHome,
  LOCALAPPDATA: path.join(isolatedHome, 'AppData', 'Local'),
  UAGENTS_STATE_DIR: path.join(stateRoot, 'v1'),
  UAGENTS_AUTO_CHECKIN: '0',
};
delete childEnv.PLUGIN_DATA;
delete childEnv.PLUGIN_ROOT;

function runCli(args) {
  const output = execFileSync(process.execPath, [path.join(packageRoot, 'bin', 'uagents.mjs'), ...args], {
    cwd: packageRoot, env: childEnv, encoding: 'utf8', windowsHide: true, timeout: 60_000,
  });
  return JSON.parse(output);
}

const cli = {
  describe: runCli(['describe']).data,
  targets: runCli(['targets']).data,
  capabilities: runCli(['capabilities', 'codex']).data,
  sessions: runCli(['sessions', '--limit', '5']).data,
  run: runCli(['describe', 'run']).data,
  skills: runCli(['skills', 'path']).data,
};
assert.equal(cli.describe.executable, 'uagents');
assert.deepEqual(cli.targets, ['agy', 'codex', 'claudeCode', 'workbuddy', 'dsh', 'opencode', 'doubao', 'trae']);
assert.deepEqual(cli.run.constraints, [{ type: 'exactly_one', options: ['--prompt', '--prompt-file', '--prompt-stdin'] }]);
// The native deadline must be raisable from the installed command, not only
// through a hand-written request file.
assert.deepEqual(cli.run.options.filter(option => option.name.endsWith('timeout-ms')).map(option => [option.name, option.minimum ?? null, option.maximum ?? null]), [
  ['--timeout-ms', 1, null],
  ['--observation-timeout-ms', 1_000, 1_200_000],
  ['--execution-timeout-ms', 1_000, 86_400_000],
]);
assert.equal(path.resolve(cli.skills.source), skillRoot);
// A fresh install has no registered conversation, and the command must say so
// without inventing rows or contacting a provider.
assert.deepEqual(cli.sessions.sessions, []);
assert.equal(cli.sessions.next_cursor, null);

// The packaged skill must be installable by a host from the installed package alone.
const installedSkillRoot = path.join(stateRoot, 'skills');
const installedSkill = runCli(['skills', 'install', '--dir', installedSkillRoot]).data;
assert.equal(installedSkill.dry_run, false);
assert.equal(fs.readFileSync(path.join(installedSkillRoot, 'agent-dispatch', 'SKILL.md'), 'utf8'), fs.readFileSync(path.join(skillRoot, 'SKILL.md'), 'utf8'));
assert.throws(() => runCli(['skills', 'install', '--dir', installedSkillRoot]));

async function listTools(entryName, expectedTools) {
  const entry = path.join(packageRoot, 'mcp', 'unified', 'dist', entryName);
  assert.ok(fs.statSync(entry).isFile());

  const child = spawn(process.execPath, [entry], {
    cwd: packageRoot,
    env: childEnv,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });

  let stdout = '';
  let stderr = '';
  const messages = [];
  const waiters = new Map();
  child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });
  child.stdout.on('data', (chunk) => {
    stdout += chunk.toString('utf8');
    let newline;
    while ((newline = stdout.indexOf('\n')) >= 0) {
      const line = stdout.slice(0, newline).trim();
      stdout = stdout.slice(newline + 1);
      if (!line) continue;
      const message = JSON.parse(line);
      messages.push(message);
      const waiter = waiters.get(message.id);
      if (waiter) {
        waiters.delete(message.id);
        waiter.resolve(message);
      }
    }
  });

  const send = (message) => child.stdin.write(`${JSON.stringify(message)}\n`);
  const waitFor = (id) => new Promise((resolve, reject) => {
    const existing = messages.find((message) => message.id === id);
    if (existing) return resolve(existing);
    const timer = setTimeout(() => {
      waiters.delete(id);
      reject(new Error(`${entryName} timed out waiting for response ${id}; stderr=${stderr}`));
    }, 15_000);
    waiters.set(id, {
      resolve: (message) => {
        clearTimeout(timer);
        resolve(message);
      },
    });
  });

  try {
    send({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2026-07-28',
        capabilities: {},
        clientInfo: { name: 'uagents-install-check', version: '1.0.0' },
      },
    });
    const initialized = await waitFor(1);
    assert.ok(initialized.result?.serverInfo?.name);
    assert.ok(fs.statSync(path.join(childEnv.UAGENTS_STATE_DIR, 'control.db')).isFile());
    send({ jsonrpc: '2.0', method: 'notifications/initialized' });

    send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
    const listed = await waitFor(2);
    assert.deepEqual(listed.result.tools.map((tool) => tool.name).sort(), [...expectedTools].sort());
    return {
      server: initialized.result.serverInfo.name,
      tools: listed.result.tools.map((tool) => tool.name).sort(),
    };
  } finally {
    child.stdin.end();
    await new Promise((resolve) => {
      if (child.exitCode !== null) return resolve();
      child.once('close', resolve);
      setTimeout(() => {
        child.kill();
        resolve();
      }, 2000).unref();
    });
  }
}

const result = {
  package: { name: manifest.name, version: manifest.version, root: packageRoot },
  skill: { name: 'agent-dispatch', references, installed: path.relative(packageRoot, installedSkillRoot) || installedSkill.target },
  cli: { executable: cli.describe.executable, targets: cli.targets, codexTransport: cli.capabilities.transport, sessions: cli.sessions.sessions.length },
  mcp: [await listTools('server.mjs', [
    'uagents_list_sessions',
    'uagents_list_targets',
    'uagents_get_capabilities',
    'uagents_list_models',
    'uagents_probe',
    'uagents_submit',
    'uagents_status',
    'uagents_result',
    'uagents_cancel',
    'uagents_list_tasks',
    'uagents_reconcile',
    'uagents_ensure',
    'uagents_stop',
    'uagents_resume',
    'uagents_council_submit',
    'uagents_council_status',
    'uagents_council_result',
    'uagents_council_diff',
    'uagents_council_validate',
    'uagents_council_adopt',
    'uagents_council_cleanup',
  ])],
};

console.log(JSON.stringify(result, null, 2));
