import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createHash } from 'node:crypto';
import { UnifiedRuntime } from '../plugins/uagents/src/runtime/api.mjs';
import { ServicePolicy } from '../plugins/uagents/src/service/policy.mjs';
import { ingestAttachmentInputs } from '../plugins/uagents/src/artifacts/attachments.mjs';
import {
  executionConfig, initializeServiceConfig, readServiceToken, serviceChildEnvironment,
  SERVICE_TOOLS, validateServiceConfig,
} from '../plugins/uagents/src/service/config.mjs';

const base = path.resolve('.local', 'test-runs', `service-policy-${randomUUID()}`);
fs.mkdirSync(base, { recursive: true });

function request(workspace, patch = {}) {
  return {
    schema_version: '1.0', request_id: randomUUID(), target: 'agy', model: 'gemini-3.8-flash-medium',
    mode: 'analysis', prompt: 'service policy fixture', workspace,
    execution: { observation_timeout_ms: 5_000, effort: 'low', permission: 'advisory-read-only' },
    policy: { fallback: 'none', max_cost_usd: null }, ...patch,
  };
}

function policyConfig(stateRoot, workspaceRoot, overrides = {}) {
  return {
    ...validateServiceConfig({
      schema_version: '1.0', state_dir: stateRoot, token_file: path.join(stateRoot, 'service.token'),
      workspace_roots: [workspaceRoot], targets: ['agy'], tools: SERVICE_TOOLS,
      ...overrides,
    }),
    protected_paths: [path.join(stateRoot, 'service.token')],
  };
}

function runtimeAt(stateRoot) {
  return new UnifiedRuntime({ stateRoot, spawnWorker() {} });
}

function deny(operation) {
  assert.throws(operation, error => error.code === 'service_scope_denied');
}

function writeCouncilFixture(stateRoot, councilId, { workspace, members, manifestMembers = [] }) {
  const directory = path.join(stateRoot, 'councils', councilId);
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, 'request.json'), JSON.stringify({ workspace, members }));
  fs.writeFileSync(path.join(directory, 'manifest.json'), JSON.stringify({ members: manifestMembers }));
  return directory;
}

test('service configuration and tool policy constrain configured targets and tools', () => {
  const workspace = path.join(base, 'config-workspace'); fs.mkdirSync(workspace, { recursive: true });
  const stateRoot = path.join(base, 'config-state'); fs.mkdirSync(stateRoot, { recursive: true });
  const config = policyConfig(stateRoot, workspace, { targets: ['agy'], tools: ['uagents_submit'] });
  const policy = new ServicePolicy(config, {});
  assert.doesNotThrow(() => policy.authorize('uagents_submit', request(workspace)));
  deny(() => policy.authorize('uagents_probe', { target: 'agy' }));
  deny(() => policy.authorize('uagents_submit', request(workspace, { target: 'codex' })));
  assert.throws(() => validateServiceConfig({
    schema_version: '1.0', state_dir: stateRoot, token_file: path.join(stateRoot, 'token'),
    workspace_roots: [workspace], targets: ['unknown'],
  }), { code: 'invalid_request' });
});

test('task access uses persisted request scope and task listing filters external records', () => {
  const workspaceRoot = path.join(base, 'task-root'); fs.mkdirSync(workspaceRoot, { recursive: true });
  const externalRoot = path.join(base, 'task-external'); fs.mkdirSync(externalRoot, { recursive: true });
  const stateRoot = path.join(base, 'task-state');
  const runtime = runtimeAt(stateRoot);
  try {
    const local = runtime.submit(request(workspaceRoot));
    const external = runtime.submit(request(externalRoot));
    const policy = new ServicePolicy(policyConfig(stateRoot, workspaceRoot), runtime);
    assert.equal(policy.task(local.task_id).task_id, local.task_id);
    deny(() => policy.task(external.task_id));
    assert.throws(() => policy.task(randomUUID()), { code: 'task_not_found' });
    const listed = policy.listTasks({ limit: 10 });
    assert.deepEqual(listed.tasks.map(task => task.task_id), [local.task_id]);
  } finally { runtime.close(); }
});

test('attachments and input paths stay under configured roots and the selected workspace', () => {
  const workspaceRoot = path.join(base, 'inputs-root');
  const workspace = path.join(workspaceRoot, 'project');
  const outside = path.join(base, 'inputs-outside');
  fs.mkdirSync(workspace, { recursive: true }); fs.mkdirSync(outside, { recursive: true });
  const insideFile = path.join(workspace, 'source.txt'); fs.writeFileSync(insideFile, 'fixture');
  const outsideFile = path.join(outside, 'source.txt'); fs.writeFileSync(outsideFile, 'external');
  const stateRoot = path.join(base, 'inputs-state'); fs.mkdirSync(stateRoot, { recursive: true });
  const credential = path.join(stateRoot, 'service.token'); fs.writeFileSync(credential, 'fixture-token');
  const policy = new ServicePolicy(policyConfig(stateRoot, workspaceRoot), {});

  assert.doesNotThrow(() => policy.inputs({ workspace, attachments: [{ local_path: insideFile }] }));
  assert.doesNotThrow(() => policy.inputs({ workspace, inputs: [{ path: 'source.txt' }] }));
  deny(() => policy.inputs({ workspace, attachments: [{ local_path: outsideFile }] }));
  deny(() => policy.inputs({ workspace, inputs: [{ path: '../inputs-outside/source.txt' }] }));
  deny(() => policy.inputs({ workspace, inputs: [{ path: path.join(workspace, 'source.txt') }] }));
  deny(() => policy.inputs({ workspace, attachments: [{ local_path: credential }] }));
  deny(() => policy.inputs({ workspace: outside, attachments: [{ local_path: outsideFile }] }));
});

test('attachment realpaths reject links that lead outside the configured roots', t => {
  const workspaceRoot = path.join(base, 'links-root');
  const workspace = path.join(workspaceRoot, 'project');
  const outside = path.join(base, 'links-outside');
  fs.mkdirSync(workspace, { recursive: true }); fs.mkdirSync(outside, { recursive: true });
  const externalFile = path.join(outside, 'linked.txt'); fs.writeFileSync(externalFile, 'outside');
  const link = path.join(workspace, 'external');
  try { fs.symlinkSync(outside, link, process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) { t.skip(`directory link creation is unavailable: ${error.code ?? error.message}`); return; }
  const stateRoot = path.join(base, 'links-state'); fs.mkdirSync(stateRoot, { recursive: true });
  const policy = new ServicePolicy(policyConfig(stateRoot, workspaceRoot), {});
  deny(() => policy.inputs({ workspace, inputs: [{ path: path.join('external', 'linked.txt') }] }));
});

test('session continuation and fork parents must be readable within the same service scope', () => {
  const workspaceRoot = path.join(base, 'session-root'); fs.mkdirSync(workspaceRoot, { recursive: true });
  const externalRoot = path.join(base, 'session-external'); fs.mkdirSync(externalRoot, { recursive: true });
  const stateRoot = path.join(base, 'session-state');
  const runtime = runtimeAt(stateRoot);
  try {
    const local = runtime.submit(request(workspaceRoot));
    const external = runtime.submit(request(externalRoot));
    const policy = new ServicePolicy(policyConfig(stateRoot, workspaceRoot), runtime);
    assert.doesNotThrow(() => policy.session({ continue_from_task_id: local.task_id }));
    assert.doesNotThrow(() => policy.session({ fork_from_task_id: local.task_id }));
    deny(() => policy.session({ continue_from_task_id: external.task_id }));
    deny(() => policy.session({ fork_from_task_id: external.task_id }));
  } finally { runtime.close(); }
});

test('Council source, member targets and adopt workspace remain scoped; manifest permits only its live derived worktree', () => {
  const workspaceRoot = path.join(base, 'council-root'); fs.mkdirSync(workspaceRoot, { recursive: true });
  const outside = path.join(base, 'council-outside'); fs.mkdirSync(outside, { recursive: true });
  const stateRoot = path.join(base, 'council-state');
  const runtime = runtimeAt(stateRoot);
  try {
    const policy = new ServicePolicy(policyConfig(stateRoot, workspaceRoot), runtime);
    const badMemberCouncil = randomUUID();
    writeCouncilFixture(stateRoot, badMemberCouncil, {
      workspace: workspaceRoot, members: [{ target: 'agy' }, { target: 'codex' }],
    });
    deny(() => policy.authorize('uagents_council_status', { council_id: badMemberCouncil }));

    const adoptCouncil = randomUUID();
    writeCouncilFixture(stateRoot, adoptCouncil, {
      workspace: workspaceRoot, members: [{ target: 'agy' }, { target: 'agy' }],
    });
    deny(() => policy.authorize('uagents_council_adopt', { council_id: adoptCouncil, workspace: outside }));

    const councilId = randomUUID();
    const taskId = randomUUID();
    const worktreeRoot = path.join(stateRoot, 'councils', councilId, 'worktrees', taskId);
    fs.mkdirSync(worktreeRoot, { recursive: true });
    const memberTask = runtime.submit(request(worktreeRoot, { request_id: taskId }));
    writeCouncilFixture(stateRoot, councilId, {
      workspace: workspaceRoot, members: [{ target: 'agy' }, { target: 'agy' }],
      manifestMembers: [{ task_id: taskId, target: 'agy', worktree: { worktree_root: worktreeRoot, workspace: worktreeRoot } }],
    });
    assert.equal(policy.task(memberTask.task_id).task_id, taskId);

    const manifest = path.join(stateRoot, 'councils', councilId, 'manifest.json');
    const content = JSON.parse(fs.readFileSync(manifest, 'utf8'));
    content.members[0].cleanup = { removed: true };
    fs.writeFileSync(manifest, JSON.stringify(content));
    assert.equal(policy.task(taskId).task_id, taskId);

    const outsideCouncil = randomUUID();
    writeCouncilFixture(stateRoot, outsideCouncil, {
      workspace: outside, members: [{ target: 'agy' }, { target: 'agy' }],
    });
    deny(() => policy.authorize('uagents_council_status', { council_id: outsideCouncil }));
  } finally { runtime.close(); }
});

test('historical tasks remain queryable after workspace deletion while new submissions are rejected', () => {
  const workspaceRoot = path.join(base, 'history-root'); fs.mkdirSync(workspaceRoot, { recursive: true });
  const stateRoot = path.join(base, 'history-state');
  const runtime = runtimeAt(stateRoot);
  try {
    const ordinaryWorkspace = path.join(workspaceRoot, 'ordinary');
    fs.mkdirSync(ordinaryWorkspace, { recursive: true });
    const ordinaryTask = runtime.submit(request(ordinaryWorkspace));
    fs.rmSync(ordinaryWorkspace, { recursive: true, force: true });

    const councilId = randomUUID();
    const taskId = randomUUID();
    const worktreeRoot = path.join(stateRoot, 'councils', councilId, 'worktrees', taskId);
    fs.mkdirSync(worktreeRoot, { recursive: true });
    const councilTask = runtime.submit(request(worktreeRoot, { request_id: taskId }));
    writeCouncilFixture(stateRoot, councilId, {
      workspace: workspaceRoot, members: [{ target: 'agy' }, { target: 'agy' }],
      manifestMembers: [{ task_id: taskId, target: 'agy', worktree: { worktree_root: worktreeRoot, workspace: worktreeRoot }, cleanup: { removed: true } }],
    });
    fs.rmSync(worktreeRoot, { recursive: true, force: true });

    const policy = new ServicePolicy(policyConfig(stateRoot, workspaceRoot), runtime);
    for (const task of [ordinaryTask, councilTask]) {
      assert.equal(policy.task(task.task_id).task_id, task.task_id);
      assert.doesNotThrow(() => policy.authorize('uagents_status', { task_id: task.task_id }));
      assert.doesNotThrow(() => policy.authorize('uagents_result', { task_id: task.task_id }));
    }
    assert.deepEqual(new Set(policy.listTasks({ limit: 10 }).tasks.map(task => task.task_id)), new Set([ordinaryTask.task_id, councilTask.task_id]));
    for (const deletedWorkspace of [ordinaryWorkspace, worktreeRoot]) {
      assert.throws(() => policy.authorize('uagents_submit', request(deletedWorkspace)), error =>
        ['invalid_workspace', 'service_scope_denied'].includes(error.code));
    }
    assert.equal(policy.listTasks({ limit: 10 }).tasks.length, 2);
  } finally { runtime.close(); }
});

test('Council operations authorize the actual Git repository root instead of expanding a scoped subdirectory', () => {
  const repository = path.join(base, 'scope-repository'); fs.mkdirSync(repository);
  execFileSync('git', ['init', repository], { stdio: 'ignore', windowsHide: true });
  const allowed = path.join(repository, 'allowed'); fs.mkdirSync(allowed);
  const stateRoot = path.join(base, 'scope-repository-state'); const runtime = runtimeAt(stateRoot);
  try {
    const councilId = randomUUID();
    writeCouncilFixture(stateRoot, councilId, { workspace: allowed, members: [{ target: 'agy' }, { target: 'agy' }] });
    const restricted = new ServicePolicy(policyConfig(stateRoot, allowed), runtime);
    deny(() => restricted.authorize('uagents_council_adopt', { council_id: councilId, workspace: allowed }));
    deny(() => restricted.authorize('uagents_council_submit', { workspace: allowed, workspace_strategy: 'git-worktree', members: [{ target: 'agy' }] }));
    const wholeRepository = new ServicePolicy(policyConfig(stateRoot, repository), runtime);
    assert.doesNotThrow(() => wholeRepository.authorize('uagents_council_adopt', { council_id: councilId, workspace: allowed }));
  } finally { runtime.close(); }
});

test('Council managed worktree roots cannot be redirected through a junction', t => {
  const workspace = path.join(base, 'council-junction-workspace'); fs.mkdirSync(workspace);
  const outside = path.join(base, 'council-junction-outside'); fs.mkdirSync(outside);
  const stateRoot = path.join(base, 'council-junction-state'); const runtime = runtimeAt(stateRoot);
  try {
    const councilId = randomUUID(), taskId = randomUUID();
    const worktreeRoot = path.join(stateRoot, 'councils', councilId, 'worktrees', taskId);
    const directory = writeCouncilFixture(stateRoot, councilId, { workspace, members: [{ target: 'agy' }],
      manifestMembers: [{ task_id: taskId, worktree: { worktree_root: worktreeRoot, workspace: worktreeRoot } }] });
    try { fs.symlinkSync(outside, path.join(directory, 'worktrees'), process.platform === 'win32' ? 'junction' : 'dir'); }
    catch (error) { t.skip(`Directory link unavailable: ${error.code}`); return; }
    const policy = new ServicePolicy(policyConfig(stateRoot, workspace), runtime);
    deny(() => policy.authorize('uagents_council_status', { council_id: councilId }));
  } finally { runtime.close(); }
});


test('blob ingestion rejects a .uagents/inputs junction that redirects writes outside the workspace', t => {
  const workspace = path.join(base, 'blob-junction-workspace');
  const outside = path.join(base, 'blob-junction-outside');
  fs.mkdirSync(path.join(workspace, '.uagents'), { recursive: true }); fs.mkdirSync(outside, { recursive: true });
  const junction = path.join(workspace, '.uagents', 'inputs');
  try { fs.symlinkSync(outside, junction, process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) { t.skip(`directory junction creation is unavailable: ${error.code ?? error.message}`); return; }

  const bytes = Buffer.from('%PDF-1.7\njunction regression fixture');
  const name = 'fixture.pdf';
  const relative = path.join('.uagents', 'inputs', `${createHash('sha256').update(bytes).digest('hex')}-${name}`);
  let error = null;
  try {
    ingestAttachmentInputs(workspace, [{ type: 'file', blob: { name, data_base64: bytes.toString('base64') } }]);
  } catch (caught) { error = caught; }
  assert.ok(error, 'blob ingestion must reject a redirected destination directory');
  assert.equal(fs.existsSync(path.join(outside, path.basename(relative))), false);
  // A concurrent creator may insert a junction after the existence check.
  const exists = fs.existsSync;
  let raced = false;
  t.mock.method(fs, 'existsSync', file => {
    if (file === junction && !raced) { raced = true; return false; }
    return exists(file);
  });
  assert.throws(() => ingestAttachmentInputs(workspace, [{ type: 'file', blob: { name, data_base64: bytes.toString('base64') } }]), { code: 'invalid_input' });
  assert.equal(raced, true);
  assert.equal(fs.existsSync(path.join(outside, path.basename(relative))), false);
});

test('blob ingestion accepts attachment directories concurrently created by another caller', t => {
  const workspace = path.join(base, 'blob-concurrent-directory-workspace');
  fs.mkdirSync(workspace);
  const directories = new Set([path.join(workspace, '.uagents'), path.join(workspace, '.uagents', 'inputs')]);
  const mkdir = fs.mkdirSync;
  const raced = [];
  t.mock.method(fs, 'mkdirSync', (directory, ...args) => {
    if (directories.delete(directory)) {
      mkdir(directory);
      raced.push(directory);
    }
    return mkdir(directory, ...args);
  });
  const bytes = Buffer.from('concurrent attachment directory fixture');
  const inputs = [{ type: 'file', blob: { name: 'fixture.txt', data_base64: bytes.toString('base64') } }];
  const [input] = ingestAttachmentInputs(workspace, inputs);
  assert.equal(raced.length, 2);
  assert.deepEqual(fs.readFileSync(path.join(workspace, input.path)), bytes);
  assert.deepEqual(ingestAttachmentInputs(workspace, inputs), [input]);
});

test('blob ingestion refuses to overwrite an existing destination symlink', t => {
  const workspace = path.join(base, 'blob-destination-workspace');
  const inputDirectory = path.join(workspace, '.uagents', 'inputs');
  const outside = path.join(base, 'blob-destination-outside');
  fs.mkdirSync(inputDirectory, { recursive: true }); fs.mkdirSync(outside, { recursive: true });
  const bytes = Buffer.from('%PDF-1.7\nsymlink destination fixture');
  const name = 'fixture.pdf';
  const destination = path.join(inputDirectory, `${createHash('sha256').update(bytes).digest('hex')}-${name}`);
  const externalFile = path.join(outside, 'must-not-change.txt');
  fs.writeFileSync(externalFile, 'untouched');
  try { fs.symlinkSync(externalFile, destination, 'file'); }
  catch (symlinkError) {
    try { fs.linkSync(externalFile, destination); }
    catch (hardlinkError) {
      t.skip(`destination link creation is unavailable: ${symlinkError.code ?? symlinkError.message}; ${hardlinkError.code ?? hardlinkError.message}`);
      return;
    }
  }

  let error = null;
  try {
    ingestAttachmentInputs(workspace, [{ type: 'file', blob: { name, data_base64: bytes.toString('base64') } }]);
  } catch (caught) { error = caught; }
  assert.ok(error, 'blob ingestion must reject a pre-existing symlink destination');
  assert.equal(fs.readFileSync(externalFile, 'utf8'), 'untouched');
});

test('service credentials stay out of child environments and execution config while protected paths deny attachments', async () => {
  const workspaceRoot = path.join(base, 'credential-root'); fs.mkdirSync(workspaceRoot, { recursive: true });
  const stateRoot = path.join(base, 'credential-state');
  const authDirectory = path.join(base, 'credential-auth');
  const configFile = path.join(authDirectory, 'service.json');
  const tokenFile = path.join(authDirectory, 'service.token');
  const options = {
    schema_version: '1.0', state_dir: stateRoot, token_file: tokenFile,
    workspace_roots: [workspaceRoot], targets: ['agy'], tools: SERVICE_TOOLS,
  };
  const config = await initializeServiceConfig(configFile, options);
  const token = readServiceToken(config.token_file);
  assert.match(token, /^[A-Za-z0-9_-]{43,128}$/);
  const execution = executionConfig(config);
  assert.equal(Object.hasOwn(execution, 'token_file'), false);
  assert.deepEqual(execution.protected_paths, [config.token_file]);

  const env = serviceChildEnvironment(config, {
    UAGENTS_SERVICE_TOKEN: token,
    UAGENTS_SERVICE_TOKEN_FILE: tokenFile,
    UAGENTS_TOKEN: token,
    UAGENTS_ENDPOINT: 'http://127.0.0.1:4319',
    ANTHROPIC_API_KEY: 'provider-fixture',
    OPENAI_API_KEY: 'provider-fixture-2',
  });
  assert.equal(Object.keys(env).some(key => /^UAGENTS_(?:SERVICE_|TOKEN|ENDPOINT)/i.test(key)), false);
  assert.equal(env.ANTHROPIC_API_KEY, 'provider-fixture');
  assert.equal(env.OPENAI_API_KEY, 'provider-fixture-2');

  const policy = new ServicePolicy({ ...execution, protected_paths: execution.protected_paths }, {});
  deny(() => policy.inputs({ workspace: workspaceRoot, attachments: [{ local_path: tokenFile }] }));
  const originalConfig = fs.readFileSync(configFile, 'utf8');
  const originalToken = fs.readFileSync(tokenFile, 'utf8');
  await assert.rejects(initializeServiceConfig(configFile, options), { code: 'request_conflict' });
  assert.equal(fs.readFileSync(configFile, 'utf8'), originalConfig);
  assert.equal(fs.readFileSync(tokenFile, 'utf8'), originalToken);

  if (process.platform === 'win32') {
    const literal = tokenFile.replaceAll("'", "''");
    const script = `$ErrorActionPreference='Stop'; $info=New-Object System.IO.FileInfo('${literal}'); $acl=$info.GetAccessControl(); ` +
      `$sid=[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value; ` +
      `$rules=@($acl.Access | ForEach-Object { [pscustomobject]@{ sid=$_.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value; ` +
      `inherited=$_.IsInherited; type=$_.AccessControlType.ToString(); rights=$_.FileSystemRights.ToString() } }); ` +
      `[pscustomobject]@{ owner=$acl.Owner; sid=$sid; rules=$rules } | ConvertTo-Json -Compress -Depth 4`;
    const executable = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const output = execFileSync(executable, ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], {
      encoding: 'utf8', windowsHide: true, timeout: 10_000,
    });
    const acl = JSON.parse(output.trim());
    assert.ok(acl.owner);
    assert.ok(acl.rules.length > 0);
    assert.deepEqual([...new Set(acl.rules.map(rule => rule.sid))], [acl.sid]);
    assert.equal(acl.rules.every(rule => !rule.inherited && rule.type === 'Allow'), true);
  }
});

test.after(() => { fs.rmSync(base, { recursive: true, force: true }); });
