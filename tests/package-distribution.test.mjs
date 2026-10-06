import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const packageRoot = path.resolve('plugins/uagents');
const manifest = JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8'));

test('the package publishes one uagents command from an explicit file whitelist', () => {
  assert.equal(manifest.name, 'uagents');
  assert.equal(manifest.license, 'MIT');
  assert.equal(manifest.engines.node, '>=22.14.0');
  assert.ok(fs.statSync(path.join(packageRoot, manifest.bin.uagents)).isFile());
  assert.ok(Array.isArray(manifest.files) && manifest.files.length > 0);
  assert.equal(fs.existsSync(path.join(packageRoot, '.codex-plugin')), false, 'the Codex plugin manifest is retired');
  assert.equal(fs.existsSync(path.join(packageRoot, '.mcp.json')), false, 'plugin MCP wiring is retired');
});

test('every whitelisted path resolves to packaged content', () => {
  for (const entry of manifest.files) {
    assert.ok(fs.existsSync(path.join(packageRoot, entry)), `missing packaged path: ${entry}`);
  }
});

test('runtime entry points, skill content and bundled desktop payload stay in the package', () => {
  for (const relative of [
    'bin/uagents.mjs',
    'bin/uagents-service.mjs',
    'bin/uagents-mcp-bridge.mjs',
    'bin/uagents-checkin.mjs',
    'scripts/windows-host.ps1',
    'skills/agent-dispatch/SKILL.md',
    'mcp/unified/dist/server.mjs',
    'mcp/unified/dist/service.mjs',
    'mcp/unified/dist/bridge.mjs',
    'mcp/doubao/dist/server.mjs',
    'mcp/doubao/src/cdp.mjs',
    'mcp/doubao/THIRD_PARTY_NOTICES.md',
    'mcp/trae/dist/gateway.cjs',
    'mcp/trae/dist/server.mjs',
    'mcp/trae/src/client.mjs',
    'mcp/trae/THIRD_PARTY_NOTICES.md',
    'mcp/trae/vendor/luckycat133-traecnclaw-0.6.0.tgz',
    'LICENSE',
  ]) assert.ok(fs.statSync(path.join(packageRoot, relative)).isFile(), `missing ${relative}`);
});

test('desktop adapters load on demand, so a core-only copy still serves every other target', () => {
  const base = path.resolve('.local', 'test-runs'); fs.mkdirSync(base, { recursive: true });
  const copy = fs.mkdtempSync(path.join(base, 'core-only-'));
  try {
    for (const directory of ['src', 'bin', 'scripts']) {
      fs.cpSync(path.join(packageRoot, directory), path.join(copy, directory), { recursive: true });
    }
    fs.copyFileSync(path.join(packageRoot, 'package.json'), path.join(copy, 'package.json'));
    const home = path.join(copy, 'home');
    fs.mkdirSync(home, { recursive: true });
    const env = {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      LOCALAPPDATA: path.join(home, 'AppData', 'Local'),
      UAGENTS_STATE_DIR: path.join(copy, 'state'),
      UAGENTS_AUTO_CHECKIN: '0',
    };
    const run = (args) => {
      const result = spawnSync(process.execPath, [path.join(copy, 'bin', 'uagents.mjs'), ...args], {
        encoding: 'utf8', windowsHide: true, timeout: 30_000, env,
      });
      return { status: result.status, envelope: JSON.parse(result.stdout), stderr: result.stderr };
    };

    const targets = run(['targets']);
    assert.equal(targets.status, 0, targets.stderr);
    assert.deepEqual(targets.envelope.data, ['agy', 'codex', 'claudeCode', 'workbuddy', 'dsh', 'opencode', 'pi', 'doubao', 'trae']);
    const codex = run(['capabilities', 'codex']);
    assert.equal(codex.status, 0, codex.stderr);
    assert.equal(codex.envelope.data.target, 'codex');

    const trae = run(['models', 'trae']);
    assert.equal(trae.status, 1, trae.stderr);
    assert.equal(trae.envelope.ok, false);
    assert.equal(trae.envelope.error.code, 'unsupported_capability');
    assert.match(trae.envelope.error.message, /unavailable in this installation: trae/);

    // The same missing component must fail visibly on a real dispatch: the
    // detached worker records the reason instead of leaving the task silently
    // registered until `run` times out.
    const workspace = path.join(copy, 'workspace');
    fs.mkdirSync(workspace, { recursive: true });
    const prompt = path.join(copy, 'prompt.txt');
    fs.writeFileSync(prompt, 'core-only worker start failure');
    const failed = run(['run', 'trae', '--workspace', workspace, '--prompt-file', prompt, '--timeout-ms', '120000']);
    assert.equal(failed.status, 1, failed.stderr);
    assert.equal(failed.envelope.ok, true);
    assert.equal(failed.envelope.data.status, 'queued');
    assert.equal(failed.envelope.data.attempt.submission, 'not_sent');
    assert.equal(failed.envelope.data.error.code, 'worker_start_failed');
    assert.match(failed.envelope.data.error.message, /unavailable in this installation: trae/);
    assert.deepEqual(failed.envelope.warnings, ['run_not_started']);
  } finally { fs.rmSync(copy, { recursive: true, force: true }); }
});
