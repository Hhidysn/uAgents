# Durable Native Execution Implementation Plan

Date: 2026-09-06

Design: `docs/superpowers/specs/2026-09-06-durable-native-execution-design.md`

Baseline: `a6fac4e fix: harden Windows OpenCode discovery and verification`

Status: Detailed implementation plan ready for review. No runtime implementation changes have started in this plan.

## 1. Objective

Implement the approved Durable Native Execution and Workspace Ownership design without weakening the release-grade OpenCode v1 path.

The milestone must make a native CLI execution survive loss of its observing uAgents Worker in the control plane. The implementation
must persist local process identity before prompt submission, persist target-native session identity as soon as it is observed, retain
replayable output, and keep an overlapping workspace blocked while a previous native writer is still alive or cannot yet be proven
dead.

The implementation is successful only when a crashed Worker cannot cause a second OpenCode process to enter the same workspace and
the same Attempt can recover observation without replaying its original prompt.

## 2. Implementation doctrine

The following rules apply to every phase.

1. Preserve the existing `Task -> Attempt -> Native Session` model and add Native Process as a separate execution identity.
2. Never turn `may_have_been_sent` or `sent` back into `not_sent`.
3. Never use PID alone as ownership evidence.
4. Never release a workspace guard because a Worker lease expired.
5. Never treat process inspection failure as proof that a process is absent.
6. Never use `opencode run --continue` or `opencode run --session` for automatic recovery.
7. Keep OpenCode `--auto` and `--pure` caller-controlled through `execution.native_args`; do not add defaults.
8. Keep normal tests provider-free. Real provider crash/reconcile tests require explicit authorization.
9. Do not migrate WorkBuddy or agy onto the durable controller until OpenCode crash recovery is stable.
10. Do not implement images, automatic retry, generic multi-turn continuation, file-level ownership, or a permanent daemon in this
    milestone.

## 3. Target end-state

The control-plane relationship after this milestone is:

```text
Task
└─ Attempt
   ├─ Native Process
   │  ├─ local process identity
   │  ├─ durable stdout/stderr transcript
   │  ├─ output cursors
   │  └─ workspace execution guard
   └─ Native Session
      └─ target conversation/task identity
```

The main execution flow becomes:

```text
submit
  -> acquire Worker leases
  -> verify inputs / installation
  -> prepare target driver
  -> persist provisional native process guard
  -> spawn process
  -> verify pid + started_at + executable
  -> persist process identity
  -> checkpoint possibly_sent
  -> write prompt exactly once
  -> tail durable stdout
  -> first valid native session identity
  -> checkpoint accepted immediately
  -> dispatch returns
  -> observe/replay until terminal / waiting / observation timeout
```

Recovery becomes:

```text
resume/reconcile
  -> no fresh dispatch when submission != not_sent
  -> reacquire same-Attempt observation ownership
  -> inspect persisted native process
  -> replay transcript from byte 0
  -> validate/persist same native session identity
  -> continue tailing if process is alive
  -> optionally use target-specific read-only reconcile
  -> refine unified state only with stronger same-identity evidence
```

## 4. File-level implementation map

### 4.1 Store and schema

Primary files:

```text
plugins/uagents/src/store/schema.mjs
plugins/uagents/src/store/database.mjs
tests/fixtures/control-v2.sql                         # new frozen migration fixture
tests/sqlite-store.test.mjs
```

Responsibilities:

- bump store schema version from 2 to 3;
- create additive v2 -> v3 migration;
- create `native_processes` table and indexes;
- ensure unknown future schema versions fail before mutation;
- preserve existing v2 Task/Attempt/Session/Event/Lease/Idempotency data.

### 4.2 Native process ledger and inspection

Primary files:

```text
plugins/uagents/src/runtime/native-processes.mjs      # new
plugins/uagents/src/runtime/process-inspector.mjs     # new unless direct reuse is cleaner
plugins/uagents/scripts/windows-host.ps1
tests/runtime-native-processes.test.mjs               # new focused suite
tests/target-supervisor.test.mjs                      # shared inspector regression only
```

Responsibilities:

- provisional process record;
- verified identity binding;
- process exit/unknown transitions;
- transcript cursor persistence;
- workspace guard refresh/release;
- PID-reuse classification;
- process-inspection failure classification.

### 4.3 Workspace admission and Worker lifecycle

Primary files:

```text
plugins/uagents/src/runtime/leases.mjs
plugins/uagents/src/runtime/worker.mjs
plugins/uagents/src/runtime/checkpoints.mjs
plugins/uagents/src/runtime/task-service.mjs
plugins/uagents/src/runtime/api.mjs
tests/workspace-locks.test.mjs
tests/runtime-crash.test.mjs
tests/queue-recovery.test.mjs
```

Responsibilities:

- guard-aware workspace admission;
- same-Attempt observation takeover;
- resource-wait behavior for active/unknown foreign executions;
- idempotent accepted checkpoint for replay;
- resume routing for durable executions.

### 4.4 Durable CLI substrate

Primary files:

```text
plugins/uagents/src/transports/durable-cli-execution.mjs # new
plugins/uagents/src/transports/cli-process.mjs            # legacy path + shared CLI discovery
plugins/uagents/src/adapters/cli-base.mjs
tests/cli-transports.test.mjs
tests/runtime-crash.test.mjs
```

Responsibilities:

- file-backed spawn;
- prompt send boundary;
- transcript tail/replay;
- process close evidence;
- early native identity notification;
- observation timeout without implicit native termination.

`cli-process.mjs` should continue to host existing `locateCli`, `nativeCliCandidates`, WorkBuddy legacy transport and compatibility
parser exports. Do not move WorkBuddy merely to make the file layout symmetrical.

### 4.5 OpenCode target integration

Primary files:

```text
plugins/uagents/src/transports/opencode-driver.mjs
plugins/uagents/src/adapters/cli-base.mjs
plugins/uagents/src/runtime/reconcile.mjs
tests/unified-cli-adapters.test.mjs
tests/cli-transports.test.mjs
tests/runtime-crash.test.mjs
```

Responsibilities:

- mark OpenCode driver as durable-controller capable;
- emit native session identity on first valid JSON event;
- preserve replay-safe parsing;
- verify optional read-only `opencode export <session-id>` reconciliation;
- never call a prompt-sending OpenCode recovery command.

## 5. Store v3 design details

### 5.1 Migration strategy

The current `ControlDatabase` constructor executes the complete schema before checking the metadata version. That is acceptable while
there is only one schema, but it is not a valid migration engine.

Refactor initialization into explicit branches:

```text
open database
-> enable foreign_keys + busy_timeout + WAL
-> detect whether metadata/schema_version exists

no schema metadata
    -> initialize fresh v3 schema in one transaction

schema_version == 2
    -> verify no v2 Attempt may already have started native work
    -> if an unsafe/nonterminal v2 Attempt exists: fail store_migration_blocked without changing metadata
    -> execute only MIGRATION_2_TO_3 in one IMMEDIATE transaction
    -> update metadata schema_version to 3 in that same transaction

schema_version == 3
    -> verify required tables/indexes; do not rewrite data

any other version
    -> incompatible_store_version without schema mutation
```

Do not implement a generic migration framework beyond what is needed for the first real migration. A small ordered migration table is
acceptable if it remains explicit and testable.

### 5.1.1 Active-v2 migration gate

Schema v2 cannot prove native process identity. Auto-migrating while an old task may already be executing would create a false durable
workspace-safety claim.

Allow automatic migration only when every nonterminal v2 Attempt is provably pre-dispatch:

```text
task.status in registered | queued
AND attempt.submission == not_sent
```

Block migration when any v2 task is:

```text
starting
running
waiting_user
indeterminate
```

or when any latest Attempt has:

```text
submission == may_have_been_sent | sent
```

Use a stable `store_migration_blocked` error with enough sanitized details to identify affected task IDs/statuses. Do not mutate the
schema version before this check succeeds. Do not synthesize v3 native-process rows for old tasks with missing process evidence.

This gate is intentionally conservative. A future explicit legacy-repair/import workflow can relax it with stronger evidence; this
milestone must not.

### 5.2 Frozen v2 fixture

Create `tests/fixtures/control-v2.sql` containing the exact schema-2 DDL required to build a real pre-migration database. This fixture
must not import the new `SCHEMA_SQL`; otherwise the migration test could pass while no longer representing a v2 installation.

Migration test data must include at least:

- one task;
- one attempt;
- one native session;
- one event;
- one lease;
- one idempotency record.

After opening the fixture with the new `ControlDatabase`:

- metadata version is 3;
- all original rows remain byte-for-byte equivalent for pre-existing columns;
- `native_processes` exists and is empty;
- reopening the database does not re-run or corrupt the migration.

### 5.3 `native_processes` DDL

Implement the approved fields with explicit checks. The logical shape is:

```text
attempt_id            UNIQUE -> attempts(attempt_id)
target                NOT NULL
workspace_key         nullable only when no user/runtime workspace exists
executable_path       NOT NULL
executable_sha256     nullable when the verified installation did not expose one
launch_fingerprint    NOT NULL
pid                   nullable while starting
process_started_at_ms nullable while starting
process_state         starting | running | exited | unknown
exit_code             nullable
stdout_relpath        NOT NULL
stderr_relpath        NOT NULL
stdout_cursor_bytes   >= 0
stderr_cursor_bytes   >= 0
workspace_guard_state held | released | unknown
observed_at_ms        NOT NULL
exited_at_ms          nullable
created_at_ms         NOT NULL
updated_at_ms         NOT NULL
```

Required invariant:

```text
process_state == running
    => pid IS NOT NULL
    && process_started_at_ms IS NOT NULL
```

Use both SQLite checks and store-helper validation where practical. Store helpers must remain the only production write path for this
table.

Suggested indexes:

```text
native_process_attempt_idx(attempt_id)
native_process_guard_idx(workspace_guard_state, process_state)
```

Do not add an index directly on `workspace_key` and rely on SQL prefix matching for overlap. Parent/child overlap remains a canonical
path operation in JavaScript.

## 6. Native process ledger API

Create a small module rather than issuing process-row SQL from transports.

Recommended public operations:

```text
createProvisionalProcess(control, record, { lease, now })
bindProcessIdentity(control, attemptId, identity, { lease, now })
markProcessExited(control, attemptId, exit, { lease?, now })
markProcessUnknown(control, attemptId, reason, { lease?, now })
updateTranscriptCursor(control, attemptId, cursors, { lease, now })
getNativeProcess(control, attemptId)
listGuardedProcesses(control)
refreshGuard(control, processId, inspectionEvidence, { now })
executionSummary(control, attemptId)
```

### 6.1 Provisional record

`createProvisionalProcess()` runs only after a valid execution lease has been obtained and before `spawn()`.

Persist:

- canonical workspace key;
- verified executable path and SHA-256 if available;
- deterministic launch fingerprint;
- relative transcript paths;
- `pid=null`;
- `process_started_at_ms=null`;
- `process_state=starting`;
- `workspace_guard_state=held`.

Creating a second process row for the same Attempt must fail closed.

Once the provisional row exists, v1 considers the Attempt to have consumed its one native-launch slot. Even when later evidence proves
that no prompt was sent and the process is dead, the same Attempt does not spawn again. Finish/reconcile that Attempt with
`submission=not_sent` and require a new request ID for another native launch. This keeps the one-row audit model honest and avoids
silently replacing process identity.

### 6.2 Launch fingerprint

The launch fingerprint is evidence, not an authorization token. Compute SHA-256 over deterministic canonical JSON containing only:

```text
target
attempt_id
canonical workspace
verified executable path
verified executable SHA-256 when known
driver-owned argv + validated native args
core/adapter version identifiers when available
```

Do not include:

- prompt text;
- inherited environment;
- credentials;
- command-line text copied from the operating system.

The raw argv does not need to be persisted because the request files and driver can reconstruct the intended launch.

### 6.3 Identity bind

After `spawn()` returns a PID, inspect the process before writing any prompt byte.

Identity is accepted only when:

```text
observed pid == child.pid
AND observed process start time is available
AND canonical observed executable == verified executable
```

On success, atomically update the provisional row to `running` with PID/start-time and `observed_at_ms`.

On failure:

- do not write the task prompt;
- terminate only the newly created child handle owned by this Worker;
- attempt process reinspection;
- keep `submission=not_sent`;
- if confirmed dead, mark process exited/release guard and fail preflight;
- if termination/death cannot be proven, mark process/guard unknown and do not automatically redispatch.

## 7. Windows process inspector

### 7.1 Reuse existing host action

Create a JS facade around the existing `createDefaultRunner()` / `inspect-process` host action. Do not create a second CIM/WMI
implementation.

Recommended result contract:

```text
{ kind: 'alive', pid, started_at_ms, executable_path }
{ kind: 'absent', pid }
{ kind: 'inspection_failed', code }
```

Add a second read-only facade operation for descendant quiescence:

```text
inspectProcessTree({ rootPid, rootStartedAtMs })
  -> { kind: 'quiescent', descendants: [] }
  -> { kind: 'active_descendants', descendants: [{ pid, parent_pid, started_at_ms }] }
  -> { kind: 'inspection_failed', code }
```

Implement it by extending the existing Windows host script with `inspect-process-tree`; do not create a second PowerShell file or use
command-line text as ownership evidence.

Higher layers must not infer `absent` from thrown exceptions.

### 7.2 Fix false absence classification

The current PowerShell `Invoke-ProcessInspection` catches CIM errors and can collapse them into a null process. Tighten it so:

```text
successful CIM query + no process row -> ok=true, exists=false
CIM/provider/query failure            -> ok=false, process_inspection_failed
```

Use terminating error behavior for query failures rather than `SilentlyContinue` where necessary.

Regression tests must prove that an injected inspection failure never produces `exists=false` and never releases a durable workspace
guard.

### 7.3 Persisted identity classification

Given a persisted row and an observed PID query:

```text
same pid + same start time + same canonical executable
    -> alive_same_identity

PID absent
    -> dead

same pid + different start time
    -> old_identity_dead_pid_reused

same pid + same start time + executable mismatch
    -> identity_mismatch_unknown

inspection failure
    -> inspection_unknown
```

`old_identity_dead_pid_reused` releases the old guard but must never kill/adopt the new process.

`identity_mismatch_unknown` and `inspection_unknown` keep the guard conservative.

### 7.4 Descendant quiescence

The durable workspace guard protects against the tracked native execution tree, not only the root `opencode.exe` PID.

When the root process is confirmed dead, enumerate Win32 process parent relationships starting from the recorded root PID. A surviving
descendant keeps the guard held even though `process_state` for the root can be `exited`.

Rules:

```text
root alive
    -> guard held

root dead + descendant(s) found
    -> root process_state may be exited
    -> guard held

root dead + descendant enumeration succeeds + no descendants
    -> guard may be released

root dead + descendant enumeration fails/ambiguous
    -> guard unknown/held
```

Do not persist descendant command lines. PIDs/start times/parent PIDs are sufficient diagnostic evidence for this v1 guard. If PID reuse
causes unrelated descendants to be conservatively attributed to the old root, keep the guard rather than guessing.

## 8. Workspace guard admission

### 8.1 Guard check location

Do not perform asynchronous process inspection inside a SQLite transaction.

Use a two-step model:

```text
1. optional async refresh of existing guarded process rows
2. transactional lease acquisition that rechecks durable guard rows
```

The transactional `acquireExecutionLeases()` call remains the final admission authority. It must inspect all non-released process rows
and reject a foreign overlapping guard even if a preflight refresh just ran.

This avoids a race where a new process guard appears between external inspection and lease acquisition.

### 8.2 API change

Extend execution lease acquisition with the current Attempt identity:

```text
acquireExecutionLeases(control, {
  target,
  workspace,
  attemptId,
  ownerNonce,
  ...
})
```

Rules:

- foreign Attempt + overlapping `held`/`unknown` guard -> fail resource admission;
- same Attempt + its own guard -> permit observation/reconcile takeover;
- normal fresh dispatch with an existing process row for the same Attempt is separately rejected by Worker dispatch eligibility so
  same-Attempt guard bypass cannot accidentally create a second process.

### 8.3 Resource-wait errors

Add stable error classifications:

```text
workspace_execution_active
workspace_execution_unknown
```

For a new unsent task these are queueable resource conflicts, not terminal task failures.

Generalize the Worker helper currently named around `lease_conflict` so bounded resource waiting recognizes:

```text
lease_conflict
workspace_execution_active
workspace_execution_unknown
```

`recordLeaseWait()` should preserve the specific reason code in the queued event.

### 8.4 Which tasks count as writers

Do not equate `mode=analysis` with read-only. Current uAgents has no enforced read-only sandbox for OpenCode, agy or WorkBuddy.

For the first durable OpenCode implementation, every OpenCode task using a real workspace is considered potentially write-capable for
guard purposes regardless of `mode` or legacy permission metadata.

Do not weaken workspace protection because the prompt says “analysis”.

## 9. Guard refresh and release

### 9.1 Refresh algorithm

Before a queued task retries an overlapping workspace, inspect relevant foreign durable process rows outside SQLite.

For each row:

```text
starting with no PID
    -> cannot prove spawn did not happen
    -> guard remains unknown/held

running/unknown with PID
    -> inspect exact persisted identity

confirmed alive
    -> keep held

confirmed absent or PID reused
    -> mark root exited
    -> inspect descendant quiescence
    -> release only if no descendants remain

identity mismatch / inspection failure
    -> mark/keep unknown; do not release
```

### 9.2 Compare-and-set release

Foreign guard refresh cannot rely on the dead Worker's fencing token. Use a conservative compare-and-set update keyed by the exact
persisted identity/version that was inspected.

For example, release only if all still match:

```text
row id
attempt id
pid
process_started_at_ms
executable_path
updated_at_ms or another row revision
workspace_guard_state != released
```

If the row changed after inspection, update zero rows and re-read rather than releasing stale evidence.

This housekeeping mutation changes only native-process/guard facts. It does not change unified Task terminal state.

## 10. Checkpoint changes

### 10.1 `possibly_sent`

Keep the existing semantics exactly:

```text
database commit of possibly_sent
BEFORE
first prompt byte write
```

No recovery code can reset this checkpoint.

### 10.2 `accepted` must become replay-idempotent

Transcript replay may rediscover the same native session after a Worker restart.

Change `persistCheckpoint('accepted')` so:

- first call from `may_have_been_sent` stores `submission=sent` and inserts the native session;
- repeated call while `submission=sent` with the exact same target/session/task identity is an idempotent no-op/event reference;
- repeated call with a different native identity fails `native_session_mismatch`;
- it never creates a second `native_sessions` row for replay of the same identity.

Do not weaken the requirement that the first accepted checkpoint must follow a persisted `possibly_sent` checkpoint.

### 10.3 Task-state interaction

Current accepted checkpoint directly updates the Task to `running`. Keep compatibility only for the normal `starting -> running` path.

For recovery from `indeterminate`, persisting a newly discovered same native identity must not bypass the state machine. Store the
identity first, then let `reconcileTask()` transition `indeterminate -> running/terminal` only with stronger same-identity evidence.

Add tests for both paths.

## 11. Durable CLI controller

Create `plugins/uagents/src/transports/durable-cli-execution.mjs` and keep it target-neutral.

Recommended controller surface:

```text
prepareDurableExecution({ driver, request, workspace, taskDirectory, attemptId, installation })
launchAndAccept({ prepared, checkpoint, ledger, inspector, signal })
observeDurableExecution({ handle, driver, ledger, inspector, signal, observationTimeoutMs })
replayDurableExecution({ processRecord, driver, persistedNativeIdentity, ... })
```

The exact names may change, but responsibilities must remain separated from target parsing.

### 11.1 Transcript directory

Use:

```text
tasks/<task-id>/native/<attempt-id>/stdout.log
tasks/<task-id>/native/<attempt-id>/stderr.log
tasks/<task-id>/native/<attempt-id>/exit.json
```

Create files before the provisional process record. Persist only paths relative to the task directory.

Reject path traversal in persisted relative paths even though they are generated internally.

### 11.2 File-backed spawn

Open stdout/stderr files and pass file descriptors directly to `spawn()`:

```text
stdio: ['pipe', stdoutFd, stderrFd]
shell: false
cwd: verified workspace
windowsHide: true
```

Do not pipe native stdout solely through the Worker process. The child must continue writing to the durable files if the observer dies.

Close the parent copies of file descriptors after successful spawn setup without invalidating child handles.

### 11.3 Spawn ownership verification

After the `spawn` event and before `possibly_sent`:

- inspect `child.pid` with bounded retry because process metadata may not be immediately visible;
- require matching verified executable identity;
- bind PID/start time only after inspection succeeds.

Use a short preflight-specific retry budget; do not consume the full model observation timeout while waiting for local process metadata.

### 11.4 Prompt write

The target prompt remains stdin-only and is constructed exactly once.

Order:

```text
await checkpoint('possibly_sent')
write prompt
end stdin
```

If the process exits or stdin fails after the checkpoint, preserve `may_have_been_sent` and never retry automatically.

### 11.5 Dispatch completion condition

`dispatch()` no longer waits for native process exit.

It tails/replays stdout until one of these occurs:

- driver emits a valid native identity -> persist `accepted`, return durable handle;
- process exits before identity -> return/throw conservative ambiguous outcome according to submission state;
- observation window/cancellation/lease ownership ends -> preserve process and submission facts, no replay.

The returned handle must contain enough identity to load the durable process record and exact native session, but must not expose raw
credentials or argv.

## 12. Transcript reader and replay rules

### 12.1 UTF-8 line reader

Implement one reusable incremental UTF-8 line reader.

Requirements:

- read by byte offset;
- use `StringDecoder` or equivalent so split multibyte sequences are preserved;
- publish a line only after a newline delimiter is complete;
- keep any partial final line in memory during normal observation;
- persist cursor only after the complete line has been processed;
- recovery may replay the last committed line but must not skip it.

### 12.2 Replay from zero

Recovery creates a fresh target parser and replays stdout from byte zero to current EOF.

Reasons:

- parser closure state remains in code, not database;
- native identity validation re-runs deterministically;
- terminal text/tool/step state reconstructs exactly.

The persisted byte cursor remains useful for normal incremental tailing and status reporting, but it is not trusted as parser state.

### 12.3 Parser publication

Replay may emit the same patches again. Publication handling must be idempotent for:

- native session identity;
- model report;
- tool-state diagnostic patches;
- terminal response persistence.

A replayed conflicting identity still fails closed.

### 12.4 Output safety

Preserve the existing 1 MiB stdout safety limit.

For stderr, preserve the current parser-visible rolling behavior and add a bounded durable transcript policy in the controller rather
than allowing an unlimited state-root file. The implementation should define the bound centrally and test it. Do not silently truncate
without recording a structured `truncated`/limit event.

If either configured transcript safety limit is exceeded while the process may still be running:

- do not interpret missing tail output as success;
- request termination only if owned-process termination is explicitly implemented for that path;
- otherwise mark observation/process state conservatively and keep the workspace guard until death is proven.

## 13. CLI adapter contract split

### 13.1 Preserve non-durable targets

`CliAdapter` currently uses the synchronous `invokeCli()` path for WorkBuddy and a separate agy transport. Keep those paths unchanged in
the first migration.

Add a driver capability flag or explicit adapter branch such as:

```text
driver.execution_mode = 'durable'
```

Only OpenCode and injected test drivers use the new controller initially.

### 13.2 Prepared submission

For a durable target, `prepare()` returns:

- legacy/native request projection;
- verified executable entry;
- target driver;
- task directory;
- workspace;
- no running process and no external side effects.

### 13.3 Dispatch context

Extend runtime context with the minimum infrastructure needed by the durable controller, for example:

```text
control / process ledger facade
process inspector
task/attempt identity
task directory
checkpoint()
AbortSignal
```

Do not let target drivers issue arbitrary control-plane SQL.

## 14. OpenCode driver details

### 14.1 Existing argv contract stays fixed

Normal execution remains:

```text
opencode run
  --model <route>
  --format json
  --dir <workspace>
  --title <uAgents task>
  [--file <absolute-input>]...
  [validated native_args...]
```

No default `--pure`.

No default `--auto`.

No fallback.

### 14.2 Session acceptance

`createOpenCodeParser()` already emits `native_session_id` on first validated `sessionID`. Use that as the early acceptance boundary.

The dispatch-side publisher must:

1. validate it against any previously persisted identity;
2. call the idempotent accepted checkpoint immediately;
3. stop waiting for acceptance and return the durable handle.

It must not wait for `step_finish` or process close.

### 14.3 Replay safety

Keep the existing invariants:

- every event/session part belongs to one stable `sessionID`;
- message/part identities remain internally consistent;
- mixed-session transcript fails `native_session_mismatch`;
- success requires verified target terminal evidence, not merely text output.

### 14.4 Read-only session reconcile spike

Before wiring `opencode export <session-id>` into production recovery, add a provider-free fixture/test proving the command path itself
does not submit a new model request.

Production use is allowed only if the spike can establish:

- command is local/read-only for an existing session;
- requested session ID is echoed/matched in returned data;
- project/workspace identity can be matched strongly enough;
- no new session/turn is created.

If any condition is not provable, do not use `export` in this milestone. Transcript replay + process inspection may still provide safe
but less complete recovery.

Under no circumstance substitute `run --session` or `run --continue` as a reconcile mechanism.

## 15. Process exit semantics

### 15.1 Normal observer owns close event

When the observing Worker receives the child `close` event:

- persist exact exit code when available;
- atomically write `exit.json`;
- mark native process `exited`;
- inspect descendant quiescence;
- set `workspace_guard_state=released` only when no descendants remain;
- if descendants remain or tree inspection fails, keep the guard held/unknown;
- then allow parser terminal evaluation/artifact capture.

### 15.2 Recovered observer may not know exit code

If the original Worker died, a later observer may detect that the persisted process identity no longer exists but have no OS exit code.

Do not fabricate exit code 0.

Persist:

```text
process_state=exited
exit_code=null
workspace_guard_state=released only after descendant quiescence is proven
```

Then use transcript/native-session evidence to determine Task outcome. If the target parser requires exit code 0 for success and no
equivalent stronger target evidence exists, keep the Task `indeterminate` even though the workspace can safely be released.

This distinction is intentional:

```text
workspace safety fact != task objective fact
```

## 16. `resume` routing

Extend `TaskService.resume()` without creating new Attempts.

Recommended matrix:

```text
registered/queued + not_sent + no process row
    -> existing dispatch recovery

preflight waiting_user + not_sent + no process row
    -> existing preflight recovery

not_sent + provisional/verified process row
    -> durable reconcile/cleanup route only
    -> never spawn a second native process in the same Attempt
    -> once owned process death is proven, finish not-sent/preflight failure
    -> caller uses a new request ID to retry native launch

may_have_been_sent + durable process row
    -> durable reconcile route

sent + durable process/session row
    -> durable reconcile route

waiting_user + native session
    -> existing reconcile semantics, durable path when process row exists

terminal
    -> resume_not_allowed
```

Return an explicit `mode` such as `durable_reconcile` so `UnifiedRuntime.resume()` does not accidentally launch a fresh Worker through
the dispatch factory.

## 17. Durable reconcile flow

Refactor `reconcileTask()` into a small router rather than forcing desktop and durable CLI recovery through identical assumptions.

Suggested shape:

```text
reconcileTask()
  -> if durable native process row exists: reconcileDurableCliTask()
  -> else: existing native-session/managed-target reconcile path
```

### 17.1 Durable CLI reconcile

Order:

1. read task, attempt, process row and optional native session;
2. acquire task lease and same-Attempt execution leases;
3. inspect persisted process identity;
4. replay transcript from zero through a fresh parser;
5. if replay discovers the first valid native session while submission is `may_have_been_sent`, persist accepted idempotently;
6. if process remains alive, continue tailing within the current observation window;
7. if process is dead, evaluate transcript plus optional read-only target reconcile;
8. transition unified state only through `transitionState()` with same-identity/evidence rules;
9. capture expected artifacts only after target success evidence;
10. release Worker leases; release durable workspace guard only when process death is proven.

### 17.2 No native session yet

Current `reconcileTask()` rejects tasks without `current.native`. Durable recovery must allow a process row to be the starting identity
when the Worker died before acceptance.

The process identity does not itself prove model acceptance. It only allows safe replay of the original transcript without another
prompt send.

## 18. Observation timeout semantics

### 18.1 Current behavior to remove for durable targets

Current `invokeCli()` uses `observation_timeout_ms` to kill the child. Durable OpenCode must stop doing that.

For the durable path:

```text
observation timeout
    -> current observer stops waiting
    -> process is inspected/persisted
    -> if still alive, process/guard remain active
    -> task remains running or becomes indeterminate based on current evidence
    -> later reconcile may continue
```

Do not change WorkBuddy/agy timeout behavior in the same commit unless required for shared code correctness.

### 18.2 `execution_timeout_ms`

Keep Registry capability false and Policy rejection unchanged during Phases A-D.

Do not add execution-timeout support until a later independently reviewed change proves:

- exact owned process-tree identity;
- process-tree termination;
- post-kill identity reinspection;
- stable result semantics distinct from provider/native cancellation.

## 19. Cancellation during durable execution

Cancellation behavior in this milestone should be conservative and workspace-safe.

Minimum acceptable behavior:

- set existing transactional cancel intent;
- never replay/send prompt during recovery;
- if no prompt was sent and owned child can be proven idle, terminate/release safely;
- after send, local process termination may be used only with exact ownership verification;
- local process death releases workspace guard;
- provider/native cancellation remains unconfirmed unless OpenCode gives explicit evidence;
- unified Task may remain `indeterminate` after local termination.

Do not advertise `native-confirmed` cancellation merely because `taskkill` succeeded.

## 20. Public status projection

Add sanitized optional execution information from the process ledger:

```json
{
  "execution": {
    "durable": true,
    "process_state": "running",
    "workspace_guard": "held",
    "observation_resumable": true,
    "stdout_cursor_bytes": 1234,
    "stderr_cursor_bytes": 0,
    "started_at_ms": 1788700000000
  }
}
```

Do not expose by default:

- PID;
- executable path;
- argv;
- environment;
- provider credentials.

The internal database remains richer than the public Schema 1.0 status surface.

## 21. Error protocol additions

Update `plugins/uagents/src/protocol/errors.mjs` with stable category/retry defaults.

Recommended classifications:

```text
workspace_execution_active
  category: conflict
  retryable: true
  new task submission: not_sent

workspace_execution_unknown
  category: conflict
  retryable: true
  new task submission: not_sent

native_process_identity_mismatch
  category: transport
  retryable: false by default
  submission: inherited from Attempt

native_process_inspection_failed
  category: runtime/transport
  retryable: true
  submission: inherited from Attempt

native_observation_unavailable
  category: transport
  retryable: true
  submission: inherited from Attempt

store_migration_blocked
  category: runtime
  retryable: true
  submission: not_sent
```

Reserve `execution_timeout` but do not make it reachable in this implementation milestone.

## 22. Detailed test-first sequence

Implementation should be test-first at each irreversible boundary.

### Step 0 — Freeze baseline

Before code changes:

- run current `npm.cmd test` and record expected 198 passing tests;
- run skill validator;
- run plugin validator;
- run `git diff --check`;
- confirm baseline HEAD and working tree contain only the approved design/plan docs.

No provider messages.

### Step 1 — Migration tests first

Add failing tests for:

- opening real v2 fixture migrates to v3;
- data preserved;
- migration is idempotent;
- v2 `starting/running/waiting_user/indeterminate` tasks block migration without metadata mutation;
- v2 `may_have_been_sent/sent` Attempts block migration without metadata mutation;
- v2 `registered/queued + not_sent` tasks do not block migration;
- unknown future version is rejected without mutation;
- fresh DB starts at v3.

Then implement schema/database migration.

### Step 2 — Ledger tests first

Add failing tests for:

- provisional row has no PID and cannot be `running`;
- verified bind requires PID/start/executable;
- second row for same Attempt rejected;
- exit releases guard;
- unknown does not release guard;
- cursor cannot move negative/backward unless explicitly replay bookkeeping permits it;
- no absolute transcript path persistence.

Then implement `native-processes.mjs`.

### Step 3 — Inspector tests first

Add failing tests for:

- matching identity alive;
- absent PID dead;
- reused PID with changed start time classified old-dead;
- executable mismatch unknown;
- PowerShell/CIM inspection failure remains failure, never absent;
- root dead with surviving descendants is not quiescent;
- root dead with successful empty descendant enumeration is quiescent;
- descendant enumeration failure remains unknown, never quiescent.

Then implement JS inspector facade and tighten `windows-host.ps1`.

### Step 4 — Guard tests first

Extend `workspace-locks.test.mjs` with:

- expired Worker lease + foreign alive durable process still blocks;
- expired Worker lease + foreign unknown durable process still blocks;
- confirmed dead + quiescent process tree can be released then lease acquired;
- confirmed dead root + surviving descendant still blocks;
- same Attempt can reacquire observation lease;
- same Attempt cannot enter normal fresh dispatch when process row already exists;
- parent/child overlap remains symmetric;
- analysis-mode OpenCode still receives writer protection.

Then integrate guard checks into leases/Worker wait logic.

### Step 5 — Accepted checkpoint replay tests

Add failing tests for:

- first accepted creates one native session;
- replay of same accepted identity is idempotent;
- replay of different identity fails mismatch;
- accepted from recovery does not illegally overwrite `indeterminate` state;
- `possibly_sent` remains irreversible.

Then modify checkpoint logic.

### Step 6 — Durable transport fixture

Create an injected executable/driver fixture that:

- writes JSON lines slowly;
- emits a session identity before terminal state;
- can remain alive after the test observer is killed;
- can emit split UTF-8 sequences and partial lines;
- can write terminal output after the first Worker exits;
- records prompt count in a local file without provider use.

Use it to prove prompt count stays exactly 1 through recovery.

Then implement file-backed spawn/tail/replay.

### Step 7 — Crash boundary matrix

Use the fixture to kill/fault at every boundary:

1. before provisional guard;
2. after provisional guard before spawn;
3. after spawn before PID bind;
4. after PID bind before `possibly_sent`;
5. after `possibly_sent` before stdin write completes;
6. after stdin close before session identity;
7. after session identity before accepted transaction;
8. after accepted while process alive;
9. after process exit before unified terminal transition.

For every case assert:

- exact submission state;
- process/guard row state;
- whether redispatch is allowed;
- prompt count;
- second overlapping writer admission result.

### Step 8 — OpenCode integration fixtures

Move OpenCode onto durable controller using fake/injected OpenCode JSON events.

Assert:

- argv unchanged;
- file input mapping unchanged;
- native args unchanged;
- no `--pure` default;
- no `--auto` default;
- session accepted before terminal;
- transcript replay reconstructs the same response/tool/step state;
- duplicate session persistence does not occur;
- artifact capture remains Runtime-owned.

### Step 9 — Durable resume/reconcile tests

Add cases for:

- `may_have_been_sent` + process but no session -> replay discovers session, no prompt replay;
- `sent` + live process -> same Attempt continues observation;
- process dead + terminal transcript -> terminal only when evidence satisfies parser rules;
- process dead + missing exit code -> no invented success;
- inspector failure -> indeterminate/guarded;
- resume returns durable reconcile mode instead of spawning a worker.

### Step 10 — Observation timeout tests

Prove:

- observation timeout does not kill durable OpenCode process;
- guard remains held while process alive;
- later reconcile can continue;
- once process death is proven, guard can release even if Task stays indeterminate.

### Step 11 — Full non-billable regression

Run all repository/MCP tests, validators and diff checks.

Only after this passes should a real provider smoke even be considered.

## 23. Crash test implementation mechanics

Avoid simulating every crash only by throwing JS exceptions inside one process. At least the decisive cases must use a real child Worker
process that is forcibly terminated so `finally` blocks do not execute.

Recommended fixture arrangement:

```text
tests/fixtures/durable-cli-agent.mjs
tests/fixtures/durable-worker-runner.mjs
```

Use filesystem markers for deterministic synchronization:

```text
spawned.marker
prompt-received.marker
session-emitted.marker
terminal-emitted.marker
prompt-count.txt
```

The test parent waits for a selected marker, kills only the Worker process, and then checks whether the native fixture process remains
alive and continues writing its transcript.

Do not make tests depend on arbitrary sleeps when a marker/event can establish the boundary.

## 24. Decisive dual-writer test

This test is mandatory before release.

Provider-free version:

1. start durable fixture Attempt A in workspace W;
2. wait until session accepted and native fixture is still alive;
3. forcibly kill uAgents Worker A without killing native fixture A;
4. wait until Worker leases expire;
5. submit Attempt B against W or a parent/child overlapping workspace;
6. prove B remains queued/rejected with `workspace_execution_active` and its fixture prompt count is zero;
7. resume/reconcile A;
8. prove A uses the original process/transcript and prompt count remains one;
9. let A process exit;
10. prove guard releases only after death evidence;
11. B may then acquire workspace resources.

This test is more important than adding broad happy-path coverage.

## 25. Provider-free OpenCode reconcile validation

Before a real crash smoke, use OpenCode CLI only for commands that do not send a prompt, such as version/help/session metadata probes,
and injected transcript fixtures for all task execution semantics.

If testing `opencode export <session-id>` requires an existing session, use a previously authorized local test session or a synthetic
fixture if possible. Do not create a provider turn merely to validate the export code path without user authorization.

## 26. Optional authorized real OpenCode smoke

This is not part of normal automated tests.

If explicitly authorized after non-billable tests pass:

1. create an isolated temporary workspace outside the uAgents source tree;
2. use the already approved DPF route unless the user chooses another route;
3. `mode=implementation`;
4. `native_args=[]` unless user explicitly requests native flags;
5. no fallback;
6. task writes one small declared output;
7. kill the uAgents Worker only after the OpenCode session is accepted while the native process remains active;
8. verify second overlapping submit does not launch another OpenCode process;
9. reconcile original Attempt without another provider prompt;
10. verify artifact SHA-256 if terminal evidence is recoverable.

The report must state actual provider call count. Never infer “one call” merely from Task count.

## 27. Commit boundaries

Keep commits reviewable and individually green where practical.

Recommended sequence:

```text
1. docs: approve durable native execution design and implementation plan
2. test: freeze store v2 migration and native process ledger cases
3. feat: migrate control store to schema v3
4. feat: add durable native process ledger and process inspection
5. feat: guard workspaces against stale native writers
6. test: add durable cli crash and transcript fixtures
7. feat: add file-backed durable cli execution controller
8. feat: persist early cli acceptance and replay-safe observation
9. feat: migrate opencode to durable native execution
10. feat: resume and reconcile durable cli attempts without replay
11. fix: separate durable observation timeout from native termination
12. test: prove dual-writer crash recovery and update release docs
```

If one commit cannot pass because a test fixture is intentionally introduced before production behavior, pair the fixture and minimal
implementation in the same commit rather than leaving master red.

Do not combine schema migration, transport rewrite and OpenCode integration into one commit.

## 28. Phase gates

### Gate A — Store safety

Must pass before transport work:

- v2 -> v3 real migration fixture;
- fresh v3 DB;
- unknown version fail-closed;
- process ledger invariants;
- no production adapter behavior changes.

### Gate B — Workspace safety

Must pass before OpenCode migration:

- foreign live/unknown process blocks after lease expiry;
- dead process releases only with identity evidence;
- PID reuse safe;
- inspector error never releases guard;
- same-Attempt observation takeover works.

### Gate C — Generic durable transport

Must pass before real OpenCode driver uses it:

- prompt exactly once;
- transcript survives Worker death;
- partial UTF-8 safe;
- accepted identity persisted before terminal;
- replay is idempotent;
- output limits preserved.

### Gate D — OpenCode durable path

Must pass before timeout/resume public behavior changes:

- existing OpenCode happy path remains green;
- early session acceptance;
- no native arg regression;
- no duplicate native session;
- crash recovery never sends prompt twice.

### Gate E — Release candidate

Must pass before packaging/install smoke:

- full provider-free suite;
- decisive dual-writer test;
- validators;
- `git diff --check`;
- source plugin packaging validation;
- current docs accurately distinguish implemented vs future execution timeout/session continuation.

## 29. Full verification commands

At final non-billable gate, run the repository's existing commands rather than inventing a new test runner:

```powershell
npm.cmd test
python C:\Users\24590\.codex\skills\.system\skill-creator\scripts\quick_validate.py plugins\uagents\skills\agent-dispatch
python C:\Users\24590\.codex\skills\.system\plugin-creator\scripts\validate_plugin.py plugins\uagents
git diff --check
```

Also run focused Node test files during each phase to shorten feedback loops.

Do not hard-code the final expected total test count in implementation logic or docs before the new tests exist.

## 30. Documentation updates during implementation

Update only after behavior exists and tests pass:

```text
README.md
docs/status/2026-09-06-current-status.md
plugins/uagents/skills/agent-dispatch/SKILL.md
plugins/uagents/skills/agent-dispatch/references/protocol.md
plugins/uagents/skills/agent-dispatch/references/opencode-council.md
```

Document these distinctions explicitly:

- durable observation is not generic multi-turn continuation;
- workspace guard is not an OS sandbox;
- local process death is not provider cancellation confirmation;
- observation timeout is not execution timeout;
- OpenCode is the first durable CLI target; agy/WorkBuddy may remain legacy until separately verified.

## 31. Release/install verification after code completion

Do not overwrite the installed plugin cache manually.

After implementation is committed and package validators pass:

1. use the project's normal marketplace/install flow;
2. preserve previous cache for rollback;
3. verify source, marketplace and installed cache file hashes;
4. start a genuinely fresh Codex CLI process;
5. confirm the fresh process loads the new cache path;
6. confirm OpenCode capabilities remain `analysis + implementation + files`;
7. run provider-free durable crash tests against source before any provider smoke;
8. run a real smoke only with explicit quota authorization.

## 32. Stop conditions

Stop implementation and report rather than weakening invariants if any of these occur:

- Windows cannot distinguish process-inspection failure from process absence;
- process start time cannot be obtained reliably enough to avoid PID reuse;
- file-backed child output does not survive Worker termination in a reproducible fixture;
- OpenCode parser cannot reconstruct identity deterministically from transcript replay;
- a second workspace writer can start after Worker lease expiry while the old process remains alive;
- recovery requires resending the original prompt;
- schema v2 migration cannot preserve existing state without destructive reset.

The correct fallback for unresolved identity is `indeterminate` plus conservative workspace guard, not automatic retry.

## 33. Definition of done

The implementation milestone is complete when all of the following are true:

- Store v3 safely migrates real schema-v2 state;
- each durable OpenCode Attempt has a process record before prompt submission;
- `running` process rows always contain verified PID/start-time/executable identity;
- stdout/stderr evidence survives Worker death;
- OpenCode native session is persisted at first valid session event, before process completion;
- accepted checkpoint is replay-idempotent for the same identity and rejects conflicting identity;
- same-Attempt reconcile can recover observation without dispatch;
- foreign overlapping workspace tasks stay blocked while the old native process is alive or unknown even after Worker lease expiry;
- PID reuse never causes adoption or termination of an unrelated process;
- observation timeout does not kill durable OpenCode execution;
- process death can release workspace safety guard independently of Task outcome certainty;
- OpenCode happy-path implementation and artifact verification remain unchanged;
- no default `--auto`, no default `--pure`, no fallback;
- decisive crash/dual-writer fixture passes without provider use;
- full repository/MCP tests and validators pass;
- installed/fresh-process verification is performed before release claims;
- any real provider crash smoke is separately authorized and reported with provider call count.

## 34. Work explicitly deferred after this milestone

Do not pull these into the implementation unless a concrete blocking dependency is demonstrated:

1. generic multi-turn session continuation;
2. automatic `opencode run --session` / `--continue` recovery;
3. agy durable process/session recovery;
4. WorkBuddy durable process/session recovery;
5. provider-confirmed cancellation;
6. independently enforced `execution_timeout_ms`;
7. retention/cleanup policy for large durable transcripts;
8. images/PDF/multimodal protocol;
9. file-level owned-path concurrency;
10. permanent scheduler daemon.

These belong to later specs after the native-execution foundation has production evidence.
