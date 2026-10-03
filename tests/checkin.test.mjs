import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { runNoPromptCommand } from '../plugins/uagents/src/transports/no-prompt-command.mjs';
import { decryptTraeAuth, loadCheckinAuth, authSummary } from '../plugins/uagents/src/checkin/auth.mjs';
import { runCheckins } from '../plugins/uagents/src/checkin/checkin.mjs';
import { initializeCheckin, bootstrapCheckin, disableCheckin, checkinScheduleStatus, checkinRoot,
  installCheckinRuntime, recognizedLegacyPath } from '../plugins/uagents/src/checkin/scheduler.mjs';
import { execute } from '../plugins/uagents/src/cli/main.mjs';

// Synthetic credential vector, independently produced with AES-CBC + SHA512.
const encryptedTrae = 'dGMFEAAABwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwdpkCY+2SHoeu4Wg84myqwiZB10PLSiA0eLiDyNU83VdPsiK8/9OK/V5NBviC0QFwdELRDwl0lULolYybWXR51UhMaOC5sffiTLOZIHuMnQyFyEqm2+k1L5qQYpqxr9hOXB9tOrjGzeH1InrIiE+ApJlxEOoVgCtVSkudV8G7omuuiFoUsB9dp73Cu0N4zJ190=';
function environment(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'uagents-checkin-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { LOCALAPPDATA: path.join(root, 'local'), APPDATA: path.join(root, 'roaming'), ProgramFiles: path.join(root, 'programs') };
}
function json(file, value) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(value)); }
function workbuddyFile(env) { return path.join(env.LOCALAPPDATA, 'CodeBuddyExtension', 'Data', 'Public', 'auth', 'workbuddy-desktop.info'); }
const auth = { logged_in: true, source: 'fixture', token: 'SECRET_FIXTURE_TOKEN', domain: 'www.codebuddy.cn' };
const wbStatus = (checked, extra = {}) => ({ code: 0, data: { today_checked_in: checked, ...extra } });
const traeStatus = (checked, enable = true) => ({ code: 0, checked_in: checked, enable, credits: 100 });
function provider(responses) {
  const calls = [];
  return { calls, fetchImpl: async (url, options) => {
    calls.push({ url, options }); const response = responses.shift();
    if (response instanceof Error) throw response;
    assert.ok(response, 'unexpected provider call');
    return new Response(JSON.stringify(response.body ?? response), { status: response.http ?? 200 });
  } };
}
async function run(responses, options = {}) {
  const network = provider(responses);
  const result = await runCheckins({ targets: ['workbuddy'], authLoader: async () => auth, ...network, ...options });
  assert.equal(JSON.stringify(result).includes(auth.token), false);
  return { result: result.results[0], calls: network.calls };
}

test('TRAE decrypts an independent format vector and rejects damaged payloads', () => {
  assert.deepEqual(decryptTraeAuth(encryptedTrae), { token: 'fixture-trae-token', expiredAt: '2099-01-01T00:00:00Z' });
  const corrupted = Buffer.from(encryptedTrae, 'base64'); corrupted[50] ^= 1;
  assert.throws(() => decryptTraeAuth(corrupted.toString('base64')));
  assert.throws(() => decryptTraeAuth('unknown-format'));
});

test('TRAE missing/broken preferred profile falls through to the other client', async t => {
  const env = environment(t);
  json(path.join(env.APPDATA, 'TRAE SOLO CN', 'User/globalStorage/storage.json'), { 'iCubeAuthInfo://icube.cloudide': 'broken' });
  json(path.join(env.APPDATA, 'Trae CN', 'User/globalStorage/storage.json'), {
    'iCubeAuthInfo://icube.cloudide': encryptedTrae, 'iCubeAuthInfo://icube-dc:fixture-device': {},
  });
  const found = await loadCheckinAuth('trae', { env });
  assert.equal(found.logged_in, true); assert.equal(found.source, 'Trae CN'); assert.equal(found.device_id, 'fixture-device');
  assert.equal(authSummary('trae', found).token, undefined);
});

test('missing credentials and expired WorkBuddy credentials do not count as logged in', async t => {
  const env = environment(t);
  for (const target of ['trae', 'workbuddy']) assert.equal((await loadCheckinAuth(target, { env })).reason, 'auth_missing');
  json(workbuddyFile(env), { auth: { accessToken: 'fixture', expiresAt: 10 } });
  assert.equal((await loadCheckinAuth('workbuddy', { env, now: 20 })).reason, 'auth_expired');
  const jwt = `header.${Buffer.from(JSON.stringify({ exp: 1 })).toString('base64url')}.signature`;
  json(workbuddyFile(env), { auth: { accessToken: jwt } });
  assert.equal((await loadCheckinAuth('workbuddy', { env, now: 2000 })).reason, 'auth_expired');
});

test('WorkBuddy supports plaintext and its native encrypted wrapper without exposing material', async t => {
  const env = { ...environment(t), NODE_OPTIONS: '--inspect', NODE_PATH: 'untrusted-modules' };
  json(workbuddyFile(env), { auth: { accessToken: 'fixture', domain: 'www.codebuddy.cn' } });
  assert.equal((await loadCheckinAuth('workbuddy', { env })).token, 'fixture');
  const native = path.join(env.ProgramFiles, 'WorkBuddy', 'WorkBuddy.exe');
  fs.mkdirSync(path.dirname(native), { recursive: true }); fs.writeFileSync(native, 'fixture');
  json(workbuddyFile(env), { auth: { accessToken: { $wbEncrypted: 1, envelope: 'fixture' } } });
  let calls = 0;
  const found = await loadCheckinAuth('workbuddy', { env, commandRunner: async (executable, args, options) => {
    calls++; assert.equal(executable, native); assert.equal(args[1], workbuddyFile(env));
    assert.equal(options.env.ELECTRON_RUN_AS_NODE, '1'); assert.equal(options.env.NODE_OPTIONS, undefined);
    assert.equal(options.env.NODE_PATH, undefined);
    assert.equal(args.some(arg => arg.includes('SECRET_FIXTURE_TOKEN')), false);
    return { status: 0, stdout: JSON.stringify({ value: auth.token }) };
  } });
  assert.equal(calls, 1); assert.equal(found.logged_in, true); assert.equal(JSON.stringify(authSummary('workbuddy', found)).includes(auth.token), false);
});

test('a changed auth-file domain never receives the stored WorkBuddy token', async t => {
  const env = environment(t);
  json(workbuddyFile(env), { auth: { accessToken: auth.token, domain: 'attacker.example' } });
  assert.equal((await loadCheckinAuth('workbuddy', { env })).reason, 'unsupported_auth_domain');
});

test('already checked in skips the claim endpoint', async () => {
  const { result, calls } = await run([wbStatus(true, { today_credit: 100, streak_days: 3 })]);
  assert.equal(result.status, 'already_checked_in'); assert.equal(calls.length, 1); assert.equal(result.credits, 100);
});

test('check-only queries state and never claims credits', async () => {
  const { result, calls } = await run([wbStatus(false)], { checkOnly: true });
  assert.equal(result.status, 'not_checked_in'); assert.equal(calls.length, 1);
});

test('malformed and unauthorized status responses stop before a claim', async () => {
  for (const response of [{ code: 0, data: {} }, { http: 401, body: { code: 1001 } }, new Error(auth.token)]) {
    const { result, calls } = await run([response]); assert.equal(result.status, 'failed'); assert.equal(calls.length, 1);
  }
});

test('WorkBuddy claim is followed by confirmed provider state', async () => {
  const { result, calls } = await run([wbStatus(false, { active: false }), { code: 0, data: { credit: 100 } }, wbStatus(true)]);
  assert.equal(result.status, 'checked_in'); assert.equal(calls.length, 3);
  assert.equal(calls[1].url, 'https://www.codebuddy.cn/billing/meter/daily-checkin');
  assert.equal(calls[1].options.redirect, 'error'); assert.equal(calls[1].options.headers.Authorization, `Bearer ${auth.token}`);
});

test('lost claim response is reconciled without replay', async () => {
  const recovered = await run([wbStatus(false), new Error(auth.token), wbStatus(true)]);
  assert.equal(recovered.result.status, 'checked_in');
  const unknown = await run([wbStatus(false), new Error(auth.token), wbStatus(false)]);
  assert.equal(unknown.result.status, 'unconfirmed');
  assert.equal(unknown.calls.filter(call => call.url.endsWith('daily-checkin')).length, 1);
});

test('an unconfirmed success body is not advertised as checked in', async () => {
  const { result } = await run([wbStatus(false), { code: 0 }, wbStatus(false)]);
  assert.equal(result.status, 'unconfirmed');
  const duplicate = await run([wbStatus(false), { http: 400, body: { code: 10001, msg: '今天已签到，请明天再来' } }, wbStatus(false)]);
  assert.equal(duplicate.result.status, 'already_checked_in');
  assert.equal(duplicate.result.status_query_checked, false);
  assert.equal(duplicate.result.verification, 'provider_already_checked_in');
  const unrelatedError = await run([wbStatus(false), { http: 400, body: { code: 10001, msg: 'invalid request' } }, wbStatus(false)]);
  assert.equal(unrelatedError.result.status, 'failed');
});

test('TRAE activity disabled skips and rate-limit rejection has a bounded retry', async () => {
  const options = { targets: ['trae'], authLoader: async () => ({ ...auth, domain: 'api.trae.cn', device_id: 'device' }), sleep: async () => {} };
  const disabled = await run([traeStatus(false, false)], options);
  assert.equal(disabled.result.reason, 'activity_disabled'); assert.equal(disabled.calls.length, 1);
  const recovered = await run([traeStatus(false), { code: 9074 }, { code: 0 }, traeStatus(true)], options);
  assert.equal(recovered.result.status, 'checked_in');
  assert.equal(recovered.calls[1].options.headers.Authorization, `Cloud-IDE-JWT ${auth.token}`);
  assert.equal(recovered.calls[1].options.headers['x-device-id'], 'device');
  const rejected = await run([traeStatus(false), { code: 9074 }, { code: 9074 }, { code: 9074 }, traeStatus(false)], options);
  assert.equal(rejected.result.status, 'failed'); assert.equal(rejected.calls.length, 5);
});

test('one missing account does not prevent the other account from checking in', async () => {
  const network = provider([wbStatus(true)]);
  const result = await runCheckins({ ...network, authLoader: async target => target === 'trae' ? { logged_in: false, reason: 'auth_missing' } : auth });
  assert.deepEqual(result.results.map(item => item.status), ['skipped', 'already_checked_in']);
});

test('startup without login, disabled targets and non-Windows never register a task', async t => {
  const env = environment(t), noSchedule = async () => { throw new Error('unexpected scheduling'); };
  const options = { env, platform: 'win32', schedulerRunner: noSchedule, authLoader: async () => ({ logged_in: false, reason: 'auth_missing' }) };
  assert.equal((await initializeCheckin(options)).reason, 'no_logged_in_account');
  assert.equal(fs.existsSync(checkinRoot(env)), false);
  assert.equal((await initializeCheckin({ ...options, targets: [] })).reason, 'targets_disabled');
  assert.equal((await initializeCheckin({ ...options, platform: 'linux' })).reason, 'unsupported_platform');
  assert.equal((await initializeCheckin({ ...options, env: { ...env, UAGENTS_AUTO_CHECKIN: '0' } })).reason, 'auto_registration_disabled');
});

test('startup deploys an independent runtime and schedules both selected accounts when one is logged in', async t => {
  const env = environment(t), calls = [];
  const options = { env, platform: 'win32', authLoader: async target => target === 'trae' ? { logged_in: false, reason: 'auth_missing' } : auth,
    schedulerRunner: async input => { calls.push(input); return input.action === 'status' ? {} : { status: 'registered', reused: calls.length > 2 }; } };
  const first = await initializeCheckin(options), second = await initializeCheckin(options);
  assert.equal(first.status, 'registered'); assert.equal(second.reused, true);
  assert.deepEqual(first.targets, ['trae', 'workbuddy']); assert.equal(first.time, '00:30');
  assert.equal(first.runtime_version, second.runtime_version);
  const plan = JSON.parse(fs.readFileSync(calls[1].plan));
  assert.equal(fs.existsSync(plan.entry), true);
  assert.equal(plan.entry.startsWith(checkinRoot(env)), true);
  assert.equal(fs.readFileSync(calls[1].plan, 'utf8').includes(auth.token), false);
  assert.equal(JSON.stringify(first).includes(auth.token), false);
});

test('disable persists across startup; explicit enable opts back in and accepts a time', async t => {
  const env = environment(t), actions = [];
  const options = { env, platform: 'win32', authLoader: async () => auth,
    schedulerRunner: async input => { actions.push(input.action); return { status: input.action === 'disable' ? 'disabled' : 'registered' }; } };
  await disableCheckin(options);
  assert.equal((await initializeCheckin(options)).status, 'disabled');
  assert.deepEqual(actions, ['disable']);
  assert.equal((await initializeCheckin({ ...options, explicit: true, time: '01:15' })).time, '01:15');
  assert.equal((await checkinScheduleStatus(options)).enabled, true);
  await assert.rejects(() => initializeCheckin({ ...options, time: '25:00' }));
});

test('registration failure is contained by the background hook', async t => {
  const env = environment(t);
  const result = await bootstrapCheckin({ env, platform: 'win32', authLoader: async () => auth, schedulerRunner: async () => { throw new Error(auth.token); } });
  assert.deepEqual(result, { status: 'failed', reason: 'auto_registration_failed' });
});

test('immutable runtime detects conflicting content instead of overwriting it', t => {
  const env = environment(t), root = checkinRoot(env);
  const installed = installCheckinRuntime(root, ['workbuddy']);
  const plan = JSON.parse(fs.readFileSync(installed.plan)); fs.writeFileSync(plan.entry, 'changed');
  assert.throws(() => installCheckinRuntime(root, ['workbuddy']), /checkin_runtime_conflict/);
});

test('shared user-profile state resolves to a physical directory visible outside the caller', t => {
  const env = environment(t), profile = path.join(path.dirname(env.LOCALAPPDATA), 'real-profile');
  fs.mkdirSync(profile, { recursive: true });
  const alias = path.join(path.dirname(env.LOCALAPPDATA), 'profile-alias');
  fs.symlinkSync(profile, alias, process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal(checkinRoot({ ...env, USERPROFILE: alias }), path.join(fs.realpathSync.native(profile), '.uagents', 'checkin-v1'));
});

test('deployed hidden launcher works with spaces, independent of the repository cwd', { skip: process.platform !== 'win32' }, async t => {
  const env = environment(t);
  json(workbuddyFile(env), { auth: { accessToken: 'expired-fixture', expiresAt: 1 } });
  const runtime = installCheckinRuntime(path.join(checkinRoot(env), 'with spaces'), ['workbuddy']);
  const executable = path.join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe');
  const child = await runNoPromptCommand(executable, ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden',
    '-ExecutionPolicy', 'Bypass', '-File', runtime.launcher, '-Plan', runtime.plan], {
    env: { ...process.env, ...env, UAGENTS_AUTO_CHECKIN: '0' }, cwd: process.env.SystemRoot, timeout: 20000,
  });
  assert.equal(child.status, 0);
  const plan = JSON.parse(fs.readFileSync(runtime.plan, 'utf8'));
  const report = JSON.parse(fs.readFileSync(plan.report_file, 'utf8'));
  assert.deepEqual(report.results.map(item => [item.target, item.status, item.reason]), [['workbuddy', 'skipped', 'auth_expired']]);
});

test('legacy migration recognizes only the specific original two-provider script', t => {
  const env = environment(t), folder = path.join(env.LOCALAPPDATA, 'auto-checkin'), file = path.join(folder, 'run_all.bat');
  fs.mkdirSync(folder, { recursive: true }); fs.writeFileSync(file, 'python trae_checkin.py\npython workbuddy_checkin.py');
  fs.writeFileSync(path.join(folder, 'trae_checkin.py'), 'https://api.trae.cn /trae/api/v2/ug/checkin_credits/claim');
  fs.writeFileSync(path.join(folder, 'workbuddy_checkin.py'), '/billing/meter/daily-checkin');
  const snapshot = { legacy: { name: 'AutoCheckin', state: 'Ready', actions: [{ execute: file }] } };
  assert.equal(recognizedLegacyPath(snapshot), file);
  snapshot.legacy.state = 'Running'; assert.equal(recognizedLegacyPath(snapshot), null);
  snapshot.legacy.state = 'Ready'; fs.writeFileSync(path.join(folder, 'trae_checkin.py'), 'unrelated');
  assert.equal(recognizedLegacyPath(snapshot), null);
});

test('CLI exposes init and check-in without creating a provider Task', async t => {
  const env = environment(t);
  const options = { env, checkinOptions: { platform: 'win32', authLoader: async () => ({ logged_in: false, reason: 'auth_missing' }), schedulerRunner: async () => ({}) } };
  const initialized = await execute(['init'], options);
  assert.equal(initialized.data.reason, 'no_logged_in_account');
  const checked = await execute(['checkin', '--target', 'workbuddy', '--check-only'], options);
  assert.deepEqual(checked.data.results.map(item => item.target), ['workbuddy']); assert.equal(checked.data.check_only, true);
  await assert.rejects(() => execute(['checkin', '--target', 'codex'], options), error => error.code === 'invalid_target');
  await assert.rejects(() => execute(['checkin', 'disable', '--check-only'], options), error => error.code === 'usage');
  assert.equal(fs.existsSync(path.join(env.LOCALAPPDATA, 'uAgents', 'v1', 'control.db')), false);
});
