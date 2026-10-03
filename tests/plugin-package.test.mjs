import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

test('plugin declares one portable unified MCP server',()=>{
  const plugin=path.resolve('plugins/uagents');
  const manifest=JSON.parse(fs.readFileSync(path.join(plugin,'.codex-plugin/plugin.json'),'utf8'));
  const config=JSON.parse(fs.readFileSync(path.join(plugin,'.mcp.json'),'utf8'));
  assert.equal(manifest.mcpServers,'./.mcp.json');
  assert.deepEqual(Object.keys(config.mcpServers),['unified']);
  const expected={unified:'./mcp/unified/dist/server.mjs'};
  for(const [name,entryArg] of Object.entries(expected)){
    const server=config.mcpServers[name];
    assert.equal(server.type,'stdio');assert.equal(server.command,'node');assert.equal(server.cwd,'./');
    assert.deepEqual(server.args,[entryArg]);
    const entry=path.resolve(plugin,server.args[0]);assert.ok(entry.startsWith(plugin+path.sep));assert.ok(fs.statSync(entry).isFile());
  }
});

test('portable service and bridge wrappers have bundled entry points', () => {
  const plugin = path.resolve('plugins/uagents');
  for (const [wrapper, bundle] of [['uagents-service.mjs', 'service.mjs'], ['uagents-mcp-bridge.mjs', 'bridge.mjs']]) {
    assert.ok(fs.statSync(path.join(plugin, 'bin', wrapper)).isFile());
    assert.ok(fs.statSync(path.join(plugin, 'mcp', 'unified', 'dist', bundle)).isFile());
  }
});

test('service discovery and bridge load from a copied plugin without node_modules', () => {
  const base = path.resolve('.local', 'test-runs'); fs.mkdirSync(base, { recursive: true });
  const copy = fs.mkdtempSync(path.join(base, 'portable-service-'));
  const plugin = path.resolve('plugins/uagents');
  try {
    for (const directory of ['src', 'bin', 'mcp/unified/dist', 'mcp/doubao/src', 'mcp/trae/src']) fs.cpSync(path.join(plugin, directory), path.join(copy, directory), { recursive: true });
    assert.equal(fs.existsSync(path.join(copy, 'node_modules')), false);
    const output = execFileSync(process.execPath, [path.join(copy, 'bin', 'uagents-service.mjs'), 'describe'], {
      encoding: 'utf8', windowsHide: true, timeout: 10000, stdio: ['ignore', 'pipe', 'pipe'],
    });
    assert.equal(JSON.parse(output).data.transport, 'streamable-http');
    const url = pathToFileURL(path.join(copy, 'mcp', 'unified', 'dist', 'bridge.mjs')).href;
    const bridge = execFileSync(process.execPath, ['--input-type=module', '-e', `const m = await import(${JSON.stringify(url)}); console.log(typeof m.connectService);`], {
      encoding: 'utf8', windowsHide: true, timeout: 10000, stdio: ['ignore', 'pipe', 'pipe'],
    });
    assert.equal(bridge.trim(), 'function');
  } finally { fs.rmSync(copy, { recursive: true, force: true }); }
});
