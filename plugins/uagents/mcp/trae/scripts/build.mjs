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
const relativeToPackage = (target) => path.relative(packageRoot, target).split(path.sep).join('/');
const extracted = spawnSync('tar', ['-xf', relativeToPackage(archive), '-C', relativeToPackage(buildRoot)], { cwd: packageRoot, stdio: 'inherit', windowsHide: true });
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

// The current TRAE CN Agent panel removes the Explorer DOM, so infer the
// active single-folder workspace from TRAE's own workbench state. Keep the
// Explorer path as the fallback; do not infer a native path for multi-root.
replaceOnce('src/cdp/dom-handlers/panel-capture.js', `      return {
        title: title,
        folderName: explorer && title ? title : null,
        rootPath: rootPath,
        hasExplorer: !!explorer
      };`, `      var folders = window.icubeWorkspace && window.icubeWorkspace.folders;
      if (Array.isArray(folders) && folders.length === 1) {
        var uri = folders[0] && folders[0].uri;
        var nativePath = uri && uri.scheme === 'file' ? uri.fsPath : null;
        if (typeof nativePath === 'string' && nativePath.length > 3 &&
            nativePath.charAt(1) === ':' &&
            (nativePath.charAt(2) === String.fromCharCode(92) || nativePath.charAt(2) === '/')) {
          rootPath = nativePath;
        }
      }
      return {
        title: title,
        folderName: explorer && title ? title : null,
        rootPath: rootPath,
        hasExplorer: !!explorer
      };`);

replaceOnce('src/http/gateway.js', `    if ((currentPath && currentPath !== normalizedRequestedPath) ||
        (!currentPath && currentFolder !== requestedFolder)) {`, `    const samePath = currentPath && (process.platform === 'win32'
      ? currentPath.toLowerCase() === normalizedRequestedPath.toLowerCase()
      : currentPath === normalizedRequestedPath);
    if ((currentPath && !samePath) ||
        (!currentPath && currentFolder !== requestedFolder)) {`);

// This TRAE build renders Solo turns under .turn and the final answer in a
// finish card. Bind extraction to the exact pending user message so a stale
// prior answer or broad page text cannot be reported as the new Task result.
replaceOnce('src/cdp/dom-handlers/panel-capture.js', `async function _queryTaskSource(driver, skipText, options = {}) {
  const modeInfo = await driver.detectMode();`, `async function _queryTaskSource(driver, skipText, options = {}) {
  const pendingTask = String(driver._pendingUserTask || '').replace(/\\s+/g, ' ').trim();
  if (pendingTask) {
    const currentTurn = await driver.client.send('Runtime.evaluate', {
      expression: \`(() => {
        const turns = Array.from(document.querySelectorAll('.turn')).filter(el => el.offsetParent !== null);
        const last = turns[turns.length - 1];
        const userLines = last ? Array.from(last.querySelectorAll('.turn__user-message .user-message-query-line')) : [];
        const legacyUser = last && last.querySelector('.turn__user-message .user-message-query-text');
        const userText = userLines.length ? userLines.map(el => el.textContent || '').join('\\\\n') : legacyUser && legacyUser.textContent;
        const normalize = value => String(value || '').replace(/\\\\s+/g, ' ').trim();
        if (!userText || normalize(userText) !== normalize(\${safeJsValue(pendingTask)})) return null;
        const summary = last.querySelector('.turn__agent-message .core-finish-card__summary .markdown-renderer');
        return { matching: true, finalText: summary ? String(summary.innerText || summary.textContent || '').trim() : '' };
      })()\`,
      returnByValue: true
    });
    const current = currentTurn.result?.value;
    if (current?.matching === true) {
      if (current.finalText) return { text: current.finalText, inProgress: false, isComplete: true, hasResponse: true };
      return { text: '', awaitingAssistant: true, latestUserText: pendingTask };
    }
    // Missing ownership is a wait, never permission to scan page/menu text.
    return { text: '', awaitingAssistant: true, latestUserText: pendingTask };
  }
  const modeInfo = await driver.detectMode();`);

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
// Opening a workspace can take longer than the HTTP admission deadline.
// Persist/return the task first; _prepareQueuedTask already does this work.
replaceOnce('src/http/handlers/unified-agent.js',
  `  if (projectPath) await ctx._ensureRequestedWorkspace(projectPath);`,
  `  // Workspace preparation runs only after durable task admission.`);
// Reuse-window commands must target the same managed profile as the CDP
// connection, never the user's unrelated default-profile window.
replaceOnce('src/config/quickstart.js',
  `function buildReuseWindowCommand(binPath, projectPath, options = {}) {\n  const platform = options.platform || process.platform;`,
  `function buildReuseWindowCommand(binPath, projectPath, options = {}) {\n  const platform = options.platform || process.platform;\n  const profile = process.env.TRAECN_USER_DATA_DIR;\n  const profileArgs = profile ? ['--user-data-dir=' + profile] : [];`);
replaceExactCount('src/config/quickstart.js',
  `commandArgs: ['--reuse-window', projectPath]`,
  `commandArgs: [...profileArgs, '--reuse-window', projectPath]`, 2);
// Nonmodal performance toasts are not Agent command approval dialogs.
replaceOnce('src/cdp/dom-handlers/dialogs.js',
  `          for (var i = 0; i < indicators.length; i++) {\n            var el = indicators[i];\n            if (el && el.offsetParent !== null`,
  `          ['[role="dialog"]', '[role="alertdialog"]', '.modal', '.modal-overlay', '.monaco-dialog'].forEach(function(selector) {\n            document.querySelectorAll(selector).forEach(function(candidate) {\n              if (!indicators.includes(candidate)) indicators.push(candidate);\n            });\n          });\n          for (var i = 0; i < indicators.length; i++) {\n            var el = indicators[i];\n            if (el && el.matches('.monaco-list-row') && el.closest('.notifications-list-container,.notification-toast') && el.getAttribute('aria-modal') !== 'true') {\n              var explicitApproval = Array.from(el.querySelectorAll('button,[role="button"],a.action-label')).some(function(button) {\n                return /允许|拒绝|授权|确认|批准|同意|执行|运行|继续|approve|allow|deny|confirm|execute|run|continue/i.test(button.innerText || button.textContent || button.getAttribute('aria-label') || '');\n              });\n              if (!explicitApproval && !el.querySelector('pre,code,[data-command],[class*="command-preview"]')) continue;\n            }\n            if (el && el.offsetParent !== null`);
replaceExactCount(
  'src/http/gateway.js',
  `: Number(process.env.TRAECN_BACKGROUND_MAX_RETRIES || 3);`,
  `: Number(process.env.TRAECN_BACKGROUND_MAX_RETRIES || 0);`,
  3,
);
// Instance identity: /api/status carries a startup-injected nonce so the
// supervisor's client can verify it reached the gateway it launched (Gate 5).
// The nonce is an opaque identity value, not a secret; the capability token
// stays out of every response body.
replaceOnce(
  'src/http/handlers/status.js',
  `function handleStatus(req, res, ctx) {
  return ctx._statusSnapshot().then(snapshot => ctx._json(req, res, snapshot));
}`,
  `function handleStatus(req, res, ctx) {
  return ctx._statusSnapshot().then(snapshot => {
    const instanceNonce = process.env.TRAECN_GATEWAY_INSTANCE_NONCE;
    if (instanceNonce) snapshot.instance_nonce = String(instanceNonce);
    return ctx._json(req, res, snapshot);
  });
}`,
);

fs.mkdirSync(dist, { recursive: true });
await build({
  entryPoints: [path.join(packageRoot, 'src', 'server.mjs')],
  outfile: path.join(dist, 'server.mjs'),
  absWorkingDir: packageRoot,
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
  absWorkingDir: packageRoot,
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
