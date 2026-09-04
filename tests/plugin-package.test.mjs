import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

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
