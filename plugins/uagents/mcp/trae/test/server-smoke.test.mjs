import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';

const base = path.resolve('../../../../.local/test-runs');
async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => server.listen(0, '127.0.0.1', resolve).once('error', reject));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

test('bundled stdio server lists only the four tracked task tools', async () => {
  fs.mkdirSync(base, { recursive: true }); const root = fs.mkdtempSync(path.join(base, 'trae-mcp-'));
  const child = spawn(process.execPath, ['dist/server.mjs'], { cwd: path.resolve('.'), env: { ...process.env, UAGENTS_STATE_DIR: root }, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  let buffer = ''; const messages = []; let wake;
  child.stdout.on('data', chunk => { buffer += chunk.toString('utf8'); let end; while ((end = buffer.indexOf('\n')) >= 0) { const line = buffer.slice(0, end); buffer = buffer.slice(end + 1); if (line.trim()) { messages.push(JSON.parse(line)); wake?.(); wake = undefined; } } });
  const wait = id => new Promise((resolve, reject) => { const deadline = setTimeout(() => reject(new Error(`timeout waiting for ${id}`)), 5000); const check = () => { const found = messages.find(item => item.id === id); if (found) { clearTimeout(deadline); resolve(found); } else wake = check; }; check(); });
  const send = value => child.stdin.write(JSON.stringify(value) + '\n');
  try {
    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2026-07-28', capabilities: {}, clientInfo: { name: 'uagents-test', version: '1' } } });
    assert.equal((await wait(1)).result.serverInfo.name, 'uagents-trae-cn');
    send({ jsonrpc: '2.0', method: 'notifications/initialized' }); send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
    const listed = await wait(2);
    assert.deepEqual(listed.result.tools.map(tool => tool.name).sort(), ['trae_probe', 'trae_result', 'trae_status', 'trae_submit']);
  } finally {
    child.stdin.end(); await new Promise(resolve => { child.once('close', resolve); setTimeout(() => { child.kill(); resolve(); }, 2000).unref(); }); fs.rmSync(root, { recursive: true, force: true });
  }
});

test('bundled gateway starts with durable state and strict CDP isolation', async () => {
  fs.mkdirSync(base, { recursive: true }); const root = fs.mkdtempSync(path.join(base, 'trae-gateway-'));
  const gatewayPort = await freePort();
  let unusedCdpPort = await freePort();
  while (unusedCdpPort === gatewayPort) unusedCdpPort = await freePort();
  const env = {
    ...process.env,
    UAGENTS_TRAE_STATE_DIR: root,
    UAGENTS_TRAE_GATEWAY_PORT: String(gatewayPort),
    UAGENTS_TRAE_CDP_PORT: String(unusedCdpPort),
    TRAECN_QUIET_LOG: '1',
  };
  const child = spawn(process.execPath, ['scripts/start-gateway.mjs'], { cwd: path.resolve('.'), env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  try {
    let status;
    for (let attempt = 0; attempt < 40; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 100));
      try { const response = await fetch(`http://127.0.0.1:${gatewayPort}/api/status`); if (response.ok) { status = await response.json(); break; } } catch {}
    }
    assert.equal(status?.service, 'traecn-cdp-http-bridge');
    assert.equal(status?.version, '0.6.0');
    assert.equal(status?.cdpReachable, false);
    assert.equal(status?.durability?.durabilityDegraded, false);
  } finally {
    child.kill(); await new Promise(resolve => { child.once('close', resolve); setTimeout(() => { child.kill(); resolve(); }, 2000).unref(); }); fs.rmSync(root, { recursive: true, force: true });
  }
});
