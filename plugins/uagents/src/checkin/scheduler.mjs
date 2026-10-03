import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { authSummary, loadCheckinAuth } from './auth.mjs';
import { CHECKIN_TARGETS, checkinTargets } from './checkin.mjs';
import { runNoPromptCommand } from '../transports/no-prompt-command.mjs';

const TASK_NAME = 'uAgents.AutoCheckin';
const DESCRIPTION = 'uAgents daily check-in v1';
const sourceRoot = fileURLToPath(new URL('../', import.meta.url));
const runtimeFiles = ['checkin/auth.mjs', 'checkin/checkin.mjs', 'checkin/run.mjs',
  'checkin/workbuddy-credential-child.cjs', 'transports/no-prompt-command.mjs'];

const launchScript = `param([Parameter(Mandatory=$true)][string]$Plan)
$ErrorActionPreference = 'Stop'
try {
  $settings = Get-Content -LiteralPath $Plan -Raw -Encoding UTF8 | ConvertFrom-Json
  $arguments = @('"' + $settings.entry + '"', '--report-file', '"' + $settings.report_file + '"')
  foreach ($target in $settings.targets) {
    if ($target -notin @('trae', 'workbuddy')) { throw 'Invalid target' }
    $arguments += @('--target', $target)
  }
  $child = Start-Process -FilePath $settings.node -ArgumentList $arguments -WindowStyle Hidden -Wait -PassThru
  exit $child.ExitCode
} catch { exit 1 }
`;

// Only metadata, paths and scheduling options enter this script. Credentials
// remain in the provider client files and are read at execution time.
const schedulerScript = `
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
Import-Module ScheduledTasks -ErrorAction Stop
function Emit($value) { [Console]::WriteLine(($value | ConvertTo-Json -Compress -Depth 6)) }
function Snapshot($task) {
  if (-not $task) { return $null }
  $info = Get-ScheduledTaskInfo -InputObject $task
  return @{ name=$task.TaskName; state=[string]$task.State; description=$task.Description;
    actions=@($task.Actions | ForEach-Object { @{ execute=$_.Execute; arguments=$_.Arguments } });
    last_result=$info.LastTaskResult; next_run=$info.NextRunTime.ToString('o') }
}
try {
  $task = Get-ScheduledTask -TaskName $inputData.task_name -TaskPath '\\' -ErrorAction SilentlyContinue
  $legacy = Get-ScheduledTask -TaskName 'AutoCheckin' -TaskPath '\\' -ErrorAction SilentlyContinue
  if ($inputData.action -eq 'status') { Emit @{ task=(Snapshot $task); legacy=(Snapshot $legacy) }; exit 0 }
  if ($task -and $task.Description -ne $inputData.description) { Emit @{ error='schedule_ownership_conflict' }; exit 1 }
  if ($inputData.action -eq 'disable') {
    if ($task) { Disable-ScheduledTask -InputObject $task | Out-Null }
    Emit @{ status='disabled'; task=(Snapshot (Get-ScheduledTask -TaskName $inputData.task_name -TaskPath '\\' -ErrorAction SilentlyContinue)) }; exit 0
  }
  $identity = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
  $arguments = '-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "' + $inputData.launcher + '" -Plan "' + $inputData.plan + '"'
  $matching = $false
  if ($task -and $task.Actions.Count -eq 1 -and $task.Triggers.Count -eq 1) {
    $triggerTime = ([datetime]$task.Triggers[0].StartBoundary).ToString('HH:mm')
    $principalIdentity = $task.Principal.UserId
    if ($principalIdentity -notmatch '^S-1-') { $principalIdentity = (New-Object System.Security.Principal.NTAccount($principalIdentity)).Translate([System.Security.Principal.SecurityIdentifier]).Value }
    $matching = $task.Actions[0].Execute -eq $inputData.powershell -and $task.Actions[0].Arguments -eq $arguments -and
      $triggerTime -eq $inputData.time -and $task.Triggers[0].DaysInterval -eq 1 -and $task.Settings.StartWhenAvailable -and
      [string]$task.Settings.MultipleInstances -eq 'IgnoreNew' -and $principalIdentity -eq $identity -and [string]$task.Principal.LogonType -eq 'Interactive' -and
      [string]$task.Principal.RunLevel -eq 'Limited' -and $task.Settings.Enabled -and -not $task.Actions[0].WorkingDirectory
  }
  if (-not $matching) {
    $action = New-ScheduledTaskAction -Execute $inputData.powershell -Argument $arguments
    $trigger = New-ScheduledTaskTrigger -Daily -At ([datetime]::ParseExact($inputData.time, 'HH:mm', [Globalization.CultureInfo]::InvariantCulture))
    $settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 5)
    $principal = New-ScheduledTaskPrincipal -UserId $identity -LogonType Interactive -RunLevel Limited
    Register-ScheduledTask -TaskName $inputData.task_name -TaskPath '\\' -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Description $inputData.description -Force | Out-Null
  }
  $migrated = $false
  if ($inputData.legacy_path -and $legacy -and [string]$legacy.State -in @('Ready', 'Disabled') -and
      $legacy.Actions.Count -eq 1 -and $legacy.Actions[0].Execute -eq $inputData.legacy_path) {
    $backup = Join-Path $inputData.root 'legacy-AutoCheckin.xml'
    if (-not (Test-Path -LiteralPath $backup)) {
      $xml = Export-ScheduledTask -TaskName 'AutoCheckin' -TaskPath '\\'
      $stream = [IO.File]::Open($backup, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write)
      try { $bytes=[Text.Encoding]::UTF8.GetBytes($xml); $stream.Write($bytes,0,$bytes.Length) } finally { $stream.Dispose() }
    }
    Disable-ScheduledTask -InputObject $legacy | Out-Null
    $migrated = $true
  }
  Emit @{ status='registered'; reused=$matching; migrated_legacy=$migrated;
    task=(Snapshot (Get-ScheduledTask -TaskName $inputData.task_name -TaskPath '\\')) }
} catch { Emit @{ error='schedule_unavailable' }; exit 1 }
`;

export function checkinRoot(env = process.env) {
  const root = env.USERPROFILE && path.isAbsolute(env.USERPROFILE)
    ? path.join(env.USERPROFILE, '.uagents', 'checkin-v1')
    : env.LOCALAPPDATA && path.isAbsolute(env.LOCALAPPDATA) ? path.join(env.LOCALAPPDATA, 'uAgents', 'checkin-v1') : null;
  if (!root) throw new Error('checkin_state_unavailable');
  // MSIX hosts may virtualize AppData writes. A Windows scheduled task runs
  // outside that package, so its paths must name the actual backing directory.
  let ancestor = root; const missing = [];
  while (!fs.existsSync(ancestor)) {
    const parent = path.dirname(ancestor);
    if (parent === ancestor) throw new Error('checkin_state_unavailable');
    missing.unshift(path.basename(ancestor)); ancestor = parent;
  }
  return path.join(fs.realpathSync.native(ancestor), ...missing);
}

function preferences(root) {
  const file = path.join(root, 'preferences.json');
  if (!fs.existsSync(file)) return { enabled: true, time: '00:30' };
  const value = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (typeof value.enabled !== 'boolean' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(value.time)) throw new Error('invalid_checkin_preferences');
  return { enabled: value.enabled, time: value.time };
}

function writePreferences(root, value) {
  fs.mkdirSync(root, { recursive: true });
  const file = path.join(root, 'preferences.json'), temporary = `${file}.${process.pid}.tmp`;
  try { fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx', mode: 0o600 }); fs.renameSync(temporary, file); }
  finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
}

export async function runSchedulerCommand(input, { env = process.env } = {}) {
  const executable = path.join(env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const payload = Buffer.from(JSON.stringify({ ...input, task_name: TASK_NAME, description: DESCRIPTION, powershell: executable })).toString('base64');
  const script = `$inputData = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${payload}')) | ConvertFrom-Json\n${schedulerScript}`;
  const result = await runNoPromptCommand(executable, ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { env, timeout: 15000, maxBuffer: 65536 });
  let response;
  try { response = JSON.parse(result.stdout.trim()); } catch { throw new Error('schedule_unavailable'); }
  if (result.status !== 0 || response.error) throw new Error(response.error === 'schedule_ownership_conflict' ? response.error : 'schedule_unavailable');
  return response;
}

export function recognizedLegacyPath(snapshot) {
  const task = snapshot?.legacy;
  if (!task || task.name !== 'AutoCheckin' || task.actions?.length !== 1 || !['Ready', 'Disabled'].includes(task.state)) return null;
  const executable = task.actions[0].execute;
  if (typeof executable !== 'string' || !path.isAbsolute(executable) || !/[\\/]auto-checkin[\\/]run_all\.bat$/i.test(executable)) return null;
  try {
    const folder = path.dirname(executable);
    const batch = fs.readFileSync(executable, 'utf8');
    const trae = fs.readFileSync(path.join(folder, 'trae_checkin.py'), 'utf8');
    const workbuddy = fs.readFileSync(path.join(folder, 'workbuddy_checkin.py'), 'utf8');
    return batch.includes('trae_checkin.py') && batch.includes('workbuddy_checkin.py') &&
      trae.includes('api.trae.cn') && trae.includes('checkin_credits/claim') && workbuddy.includes('/billing/meter/daily-checkin') ? executable : null;
  } catch { return null; }
}

export function installCheckinRuntime(root, targets, node = process.execPath) {
  fs.mkdirSync(root, { recursive: true });
  root = fs.realpathSync.native(root);
  const sources = runtimeFiles.map(relative => [relative, fs.readFileSync(path.join(sourceRoot, relative))]);
  const hash = createHash('sha256').update(JSON.stringify({ targets, node, root }));
  for (const [relative, bytes] of sources) hash.update(relative).update(bytes);
  hash.update(launchScript);
  const version = hash.digest('hex');
  const directory = path.join(root, 'runtime', version);
  const plan = { node, entry: path.join(directory, 'checkin', 'run.mjs'), targets, report_file: path.join(root, 'last-result.json') };
  sources.push(['launch.ps1', Buffer.from(launchScript)], ['plan.json', Buffer.from(`${JSON.stringify(plan)}\n`)]);
  for (const [relative, bytes] of sources) {
    const destination = path.join(directory, relative);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    try { fs.writeFileSync(destination, bytes, { flag: 'wx', mode: 0o600 }); }
    catch (error) {
      if (error.code !== 'EEXIST' || !fs.readFileSync(destination).equals(bytes)) throw new Error('checkin_runtime_conflict');
    }
  }
  return { root, launcher: path.join(directory, 'launch.ps1'), plan: path.join(directory, 'plan.json'), runtime_version: version };
}

export async function initializeCheckin({ env = process.env, platform = process.platform, targets = CHECKIN_TARGETS,
  authLoader = loadCheckinAuth, schedulerRunner = runSchedulerCommand, time = null, explicit = false } = {}) {
  if (platform !== 'win32') return { status: 'skipped', reason: 'unsupported_platform' };
  if (!explicit && env.UAGENTS_AUTO_CHECKIN === '0') return { status: 'skipped', reason: 'auto_registration_disabled' };
  let root = checkinRoot(env);
  const settings = preferences(root);
  if (!explicit && !settings.enabled) return { status: 'disabled' };
  const selected = checkinTargets(targets);
  if (!selected.length) return { status: 'skipped', reason: 'targets_disabled' };
  const accounts = [];
  for (const target of selected) {
    try { accounts.push(authSummary(target, await authLoader(target, { env }))); }
    catch { accounts.push({ target, logged_in: false, reason: 'auth_unreadable' }); }
  }
  const selectedTime = time ?? settings.time;
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(selectedTime)) throw new Error('invalid_checkin_time');
  if (!accounts.some(account => account.logged_in)) {
    if (explicit) writePreferences(root, { enabled: true, time: selectedTime });
    return { status: 'skipped', reason: 'no_logged_in_account', accounts };
  }
  const runtime = installCheckinRuntime(root, selected);
  root = runtime.root;
  const before = await schedulerRunner({ action: 'status', root }, { env });
  const registered = await schedulerRunner({ action: 'enable', ...runtime, time: selectedTime, legacy_path: recognizedLegacyPath(before) }, { env });
  writePreferences(root, { enabled: true, time: selectedTime });
  return { ...registered, time: selectedTime, targets: selected, accounts, runtime_version: runtime.runtime_version,
    report_file: path.join(root, 'last-result.json') };
}

export async function checkinScheduleStatus({ env = process.env, platform = process.platform, schedulerRunner = runSchedulerCommand } = {}) {
  if (platform !== 'win32') return { status: 'skipped', reason: 'unsupported_platform' };
  const root = checkinRoot(env), settings = preferences(root);
  let lastResult = null;
  try { lastResult = JSON.parse(fs.readFileSync(path.join(root, 'last-result.json'), 'utf8')); } catch {}
  return { ...settings, ...(await schedulerRunner({ action: 'status', root }, { env })), report_file: path.join(root, 'last-result.json'), last_result: lastResult };
}

export async function disableCheckin({ env = process.env, platform = process.platform, schedulerRunner = runSchedulerCommand } = {}) {
  if (platform !== 'win32') return { status: 'skipped', reason: 'unsupported_platform' };
  const root = checkinRoot(env);
  writePreferences(root, { ...preferences(root), enabled: false });
  return schedulerRunner({ action: 'disable', root }, { env });
}

export async function bootstrapCheckin(options = {}) {
  try { return await initializeCheckin(options); }
  catch { return { status: 'failed', reason: 'auto_registration_failed' }; }
}
