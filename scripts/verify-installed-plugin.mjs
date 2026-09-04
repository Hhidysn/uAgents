import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

const pluginRoot = path.resolve(process.argv[2] ?? '');
const stateRoot = path.resolve(process.argv[3] ?? '');

if (!process.argv[2] || !process.argv[3]) {
  throw new Error('Usage: node scripts/verify-installed-plugin.mjs <plugin-root> <state-root>');
}

for (const forbidden of ['third-part-research', 'node_modules', '.git', '.local']) {
  assert.equal(fs.existsSync(path.join(pluginRoot, forbidden)), false, `clean plugin contains ${forbidden}`);
}

const manifest = JSON.parse(
  fs.readFileSync(path.join(pluginRoot, '.codex-plugin', 'plugin.json'), 'utf8'),
);
const mcpConfig = JSON.parse(fs.readFileSync(path.join(pluginRoot, '.mcp.json'), 'utf8'));
assert.equal(manifest.name, 'uagents');
assert.match(manifest.version, /^0\.2\.0-alpha\.1(?:\+codex\.[A-Za-z0-9-]+)?$/);
assert.equal(manifest.skills, './skills/');
assert.equal(manifest.mcpServers, './.mcp.json');
assert.deepEqual(Object.keys(mcpConfig.mcpServers), ['unified']);

const references = ['agy.md', 'workbuddy.md', 'opencode-council.md', 'doubao-work.md', 'trae-cn.md'];
const skillRoot = path.join(pluginRoot, 'skills', 'agent-dispatch');
assert.ok(fs.statSync(path.join(skillRoot, 'SKILL.md')).isFile());
for (const reference of references) {
  assert.ok(fs.statSync(path.join(skillRoot, 'references', reference)).isFile());
}

fs.mkdirSync(stateRoot, { recursive: true });

async function listTools(serverName, expectedTools) {
  const server = mcpConfig.mcpServers[serverName];
  assert.equal(server.type, 'stdio');
  assert.equal(server.command, 'node');
  assert.equal(server.cwd, './');
  assert.equal(server.args.length, 1);

  const entry = path.resolve(pluginRoot, server.args[0]);
  assert.ok(entry.startsWith(`${pluginRoot}${path.sep}`));
  assert.ok(fs.statSync(entry).isFile());

  const isolatedHome = path.join(stateRoot, serverName, 'home');
  fs.mkdirSync(isolatedHome, { recursive: true });
  const childEnv = {
    ...process.env,
    HOME: isolatedHome,
    USERPROFILE: isolatedHome,
    LOCALAPPDATA: path.join(isolatedHome, 'AppData', 'Local'),
    PLUGIN_ROOT: pluginRoot,
    UAGENTS_TRAE_STATE_DIR: path.join(stateRoot, serverName, 'gateway'),
  };
  delete childEnv.PLUGIN_DATA;
  delete childEnv.UAGENTS_STATE_DIR;

  const child = spawn(process.execPath, [entry], {
    cwd: pluginRoot,
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
      reject(new Error(`${serverName} timed out waiting for response ${id}; stderr=${stderr}`));
    }, 5000);
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
        clientInfo: { name: 'uagents-clean-install-check', version: '1.0.0' },
      },
    });
    const initialized = await waitFor(1);
    assert.ok(initialized.result?.serverInfo?.name);
    assert.ok(fs.statSync(path.join(isolatedHome, 'AppData', 'Local', 'uAgents', 'v1', 'control.db')).isFile());
    send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
    const listed = await waitFor(2);
    assert.deepEqual(
      listed.result.tools.map((tool) => tool.name).sort(),
      [...expectedTools].sort(),
    );
    const probeName = 'uagents_probe';
    send({
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: probeName, arguments: {
        target: 'opencode', model: 'commandcode-goat/deepseek/deepseek-v4-flash',
      } },
    });
    const probed = await waitFor(3);
    assert.ok(probed.result);
    return {
      server: initialized.result.serverInfo.name,
      tools: listed.result.tools.map((tool) => tool.name).sort(),
      probe: {
        isError: probed.result.isError === true,
        content: probed.result.content,
      },
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
  plugin: { name: manifest.name, version: manifest.version, root: pluginRoot },
  skill: { name: 'agent-dispatch', references },
  mcp: [await listTools('unified', [
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
  ])],
};

console.log(JSON.stringify(result, null, 2));
