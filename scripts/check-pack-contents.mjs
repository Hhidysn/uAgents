import assert from 'node:assert/strict';
import path from 'node:path';
import { execSync } from 'node:child_process';

// The package root carries no .npmignore, so npm falls back to ignore files it
// finds there. This check reads what npm would actually put in the tarball
// instead of trusting the "files" whitelist.
const packageRoot = path.resolve('plugins/uagents');

const required = [
  'package.json',
  'LICENSE',
  'README.md',
  'AGENTS.md',
  'bin/uagents.mjs',
  'bin/uagents-service.mjs',
  'bin/uagents-mcp-bridge.mjs',
  'bin/uagents-checkin.mjs',
  'scripts/windows-host.ps1',
  'skills/agent-dispatch/SKILL.md',
  'mcp/unified/dist/server.mjs',
  'mcp/unified/dist/service.mjs',
  'mcp/unified/dist/bridge.mjs',
  'mcp/unified/THIRD_PARTY_NOTICES.md',
  'mcp/doubao/dist/server.mjs',
  'mcp/doubao/THIRD_PARTY_NOTICES.md',
  'mcp/trae/dist/gateway.cjs',
  'mcp/trae/dist/server.mjs',
  'mcp/trae/THIRD_PARTY_NOTICES.md',
  'mcp/trae/vendor/luckycat133-traecnclaw-0.6.0.tgz',
];

const forbiddenPrefixes = ['.codex-plugin/', '.build/', 'test/', 'node_modules/'];
const forbiddenSuffixes = ['.tgz'];

const raw = execSync('npm pack --dry-run --json', {
  cwd: packageRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
});
const [packed] = JSON.parse(raw);
const entries = new Set(packed.files.map((file) => file.path.replaceAll('\\', '/')));

for (const entry of required) {
  assert.ok(entries.has(entry), `npm pack omits required file: ${entry}`);
}
for (const entry of entries) {
  assert.ok(!forbiddenPrefixes.some((prefix) => entry.startsWith(prefix)), `npm pack includes ${entry}`);
  if (entry.endsWith('.tgz') && !entry.startsWith('mcp/trae/vendor/')) {
    assert.ok(!forbiddenSuffixes.some((suffix) => entry.endsWith(suffix)), `npm pack includes archive ${entry}`);
  }
}

console.log(JSON.stringify({
  package: `${packed.name}@${packed.version}`,
  files: packed.entryCount,
  size: packed.size,
  unpackedSize: packed.unpackedSize,
  required: required.length,
}, null, 2));
