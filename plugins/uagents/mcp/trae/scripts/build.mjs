import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const packageRoot = fileURLToPath(new URL('../', import.meta.url));
const archive = path.join(packageRoot, 'vendor', 'luckycat133-traecnclaw-0.6.0.tgz');
const buildRoot = path.join(packageRoot, '.build');
const upstreamRoot = path.join(buildRoot, 'package');
const dist = path.join(packageRoot, 'dist');
const expectedIntegrity = 'sha512-4wCZmtskz5Cge/rF474OxsfAvTux1ln0Ry63V9JW3vLS8mcZMjivO69UZ4gHJ9rHy5rEJ9UeGzMrhdO4RC5DcA==';

function assertOwned(target) {
  const relative = path.relative(packageRoot, path.resolve(target));
  if (!relative || relative.startsWith(`..${path.sep}`) || relative === '..' || path.isAbsolute(relative)) throw new Error(`Refusing path outside package: ${target}`);
}

function resetDirectory(target) {
  assertOwned(target);
  if (fs.existsSync(target)) {
    if (fs.lstatSync(target).isSymbolicLink()) throw new Error(`Refusing linked build path: ${target}`);
    fs.rmSync(target, { recursive: true });
  }
  fs.mkdirSync(target, { recursive: true });
}

function replaceOnce(relative, before, after) {
  const file = path.join(upstreamRoot, relative);
  const source = fs.readFileSync(file, 'utf8');
  const first = source.indexOf(before);
  if (first < 0 || source.indexOf(before, first + before.length) >= 0) throw new Error(`Patch context did not match exactly once: ${relative}`);
  fs.writeFileSync(file, source.slice(0, first) + after + source.slice(first + before.length));
}

function replaceExactCount(relative, before, after, expected) {
  const file = path.join(upstreamRoot, relative);
  const source = fs.readFileSync(file, 'utf8');
  const count = source.split(before).length - 1;
  if (count !== expected) throw new Error(`Patch context matched ${count}, expected ${expected}: ${relative}`);
  fs.writeFileSync(file, source.split(before).join(after));
}

const integrity = `sha512-${createHash('sha512').update(fs.readFileSync(archive)).digest('base64')}`;
if (integrity !== expectedIntegrity) throw new Error('TRAECNclaw archive integrity mismatch.');
resetDirectory(buildRoot);
const extracted = spawnSync('tar', ['-xf', archive, '-C', buildRoot], { stdio: 'inherit', windowsHide: true });
if (extracted.status !== 0) throw new Error(`tar extraction failed with status ${extracted.status}`);

replaceOnce('src/cdp/browser-dom.js', `  await client.send('Input.dispatchKeyEvent', {
    type: 'keyDown',
    key: 'a',
    code: 'KeyA',
    modifiers: 4
  });
  await client.send('Input.dispatchKeyEvent', {
    type: 'keyUp',
    key: 'a',
    code: 'KeyA',
    modifiers: 4
  });`, `  await client.send('Runtime.callFunctionOn', {
    functionDeclaration: \`function() {
      var range = document.createRange();
      range.selectNodeContents(this);
      var sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
    }\`,
    objectId: await _getNodeObjectId(client, nodeId)
  });`);

replaceOnce('src/cdp/dom-handlers/messaging.js', `        el.focus();
        return { ok: true };`, `        el.focus();
        var range = document.createRange();
        range.selectNodeContents(el);
        var sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
        return { ok: true, selected: sel.toString().length };`);
replaceOnce('src/cdp/dom-handlers/messaging.js', `  await driver.client.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'a', code: 'KeyA', modifiers: 4 });
  await driver.client.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', modifiers: 4 });
`, '');

for (const relative of ['src/http/task-store.js', 'src/shared/task-event-store.js', 'src/shared/task-history.js']) {
  replaceOnce(relative, `    fs.copyFileSync(sourcePath, destinationPath);
    const fd = fs.openSync(destinationPath, 'r');`, `    fs.copyFileSync(sourcePath, destinationPath);
    const fd = fs.openSync(destinationPath, 'r+');`);
}

replaceOnce('src/cdp/discovery.js', `  const ports = uniquePorts(
    [configuredPort],
    [quickstartPort],
    extraPorts,
    devtoolsPorts,
    DEFAULT_DISCOVERY_PORTS
  );`, `  const strictConfiguredPort = getEnvWithFallback('TRAECN_STRICT_CDP_PORT', 'TRAE_STRICT_CDP_PORT', '') === '1';
  const ports = strictConfiguredPort
    ? uniquePorts([configuredPort])
    : uniquePorts(
      [configuredPort],
      [quickstartPort],
      extraPorts,
      devtoolsPorts,
      DEFAULT_DISCOVERY_PORTS
    );`);

replaceExactCount(
  'src/http/handlers/unified-agent.js',
  `    autoContinue: true,
    reviewRequired,
    autoApproveDialog: 'auto'`,
  `    autoContinue: false,
    reviewRequired,
    autoApproveDialog: false`,
  2,
);
replaceExactCount(
  'src/http/gateway.js',
  `: Number(process.env.TRAECN_BACKGROUND_MAX_RETRIES || 3);`,
  `: Number(process.env.TRAECN_BACKGROUND_MAX_RETRIES || 0);`,
  3,
);

fs.mkdirSync(dist, { recursive: true });
await build({
  entryPoints: [path.join(packageRoot, 'src', 'server.mjs')],
  outfile: path.join(dist, 'server.mjs'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  minifyWhitespace: true,
  legalComments: 'eof',
});
await build({
  entryPoints: [path.join(upstreamRoot, 'scripts', 'start-gateway.js')],
  outfile: path.join(dist, 'gateway.cjs'),
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  minifyWhitespace: true,
  legalComments: 'eof',
});
for (const file of ['server.mjs', 'gateway.cjs']) {
  const output = path.join(dist, file);
  fs.writeFileSync(output, fs.readFileSync(output, 'utf8').replace(/[\t ]+$/gm, ''));
}
const consoleRoot = path.join(dist, 'web-console');
fs.mkdirSync(consoleRoot, { recursive: true });
for (const file of ['index.html', 'styles.css', 'state.js', 'app.js']) {
  fs.copyFileSync(path.join(upstreamRoot, 'src', 'http', 'web-console', file), path.join(consoleRoot, file));
}
