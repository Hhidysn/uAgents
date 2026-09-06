# Durable Native Execution and Workspace Ownership

Date: 2026-09-06

Status: Implemented and provider-free release-candidate verified. Gate A (Store v3 + native-process ledger) is committed as `686b02d`; Gate B (Windows process inspection + durable workspace admission) as `6702f32`; Gate C (generic durable CLI transport) as `f71a891`; Gate D (Windows OpenCode durable production/recovery) as `fa01ca5`; release-candidate metadata is `2fd090b`. Version `0.2.0-alpha.1+codex.20260906212805` is installed through the personal marketplace and verified from a fresh read-only Codex process. The source suite passes Core `238/238` plus MCP `11/9/2` (`260/260` total), and the decisive recovery/dual-writer subset passes `25/25`. No real OpenCode/provider crash smoke was run for this milestone; the build remains a local release candidate, not a public release.

Baseline: `a6fac4e fix: harden Windows OpenCode discovery and verification`

Target milestone: the first post-OpenCode-v1 reliability increment.

## 1. Problem statement

The current OpenCode implementation is release-grade for a normal uninterrupted run: uAgents can discover and verify the real
`opencode.exe`, submit an implementation task through the standard CLI path, capture declared artifacts, and verify their SHA-256.
The remaining reliability gap is what happens after a Worker or observer disappears while a native CLI process may still be executing.

Today the generic CLI path still has one important structural property: `CliAdapter.dispatch()` waits for `invokeCli()` to finish the
entire native process. The `accepted` checkpoint is therefore recorded only after that process returns. Native session identity can be
seen earlier in stdout, but it is held in memory until the whole invocation completes.

This creates two coupled failure modes:

1. A Worker can die after the prompt may have been sent but before `accepted` is persisted. The database correctly preserves
   `may_have_been_sent`, but loses the process identity, output cursor, and any native session identity observed only in memory.
2. The workspace lease is TTL based. If the Worker dies and its lease expires while the old native process is still writing, another
   Worker can eventually acquire the same workspace lease. Database fencing prevents the old Worker from writing control-plane state,
   but it cannot fence file writes made by the still-running native Agent process.

The second case is the unresolved “dual Worker workspace” risk. It is not solved by making lease TTLs longer. Lease expiry is a Worker
ownership decision; whether an already-started native process can still write is a different fact and must be persisted separately.

## 2. Goals

This design adds a durable local execution layer with five goals:

1. Persist native process identity before any task prompt is written to the process.
2. Persist native session identity as soon as the target emits it, rather than after process termination.
3. Make stdout/stderr observation restartable from durable files and durable cursors.
4. Allow the same Attempt to resume observation or reconcile the same native execution without replaying the original prompt.
5. Prevent a second write-capable task from entering an overlapping workspace while a previous native execution is confirmed alive or
   cannot yet be proven dead.

The resulting invariant is:

```text
workspace execution permission
  = valid Worker lease
  + no conflicting foreign durable native execution guard
```

The lease protects the control plane. The native execution guard protects the workspace from stale native writers.

## 3. Non-goals

This increment does not introduce:

- a permanent daemon;
- automatic retry or a second Attempt after an ambiguous send;
- cross-machine scheduling or a remote database;
- an OS sandbox or a claim that uAgents prevents arbitrary same-user writes;
- automatic model fallback;
- generic multi-turn conversation continuation;
- images or other multimodal protocol changes;
- file-level owned-path conflict inference;
- agy/WorkBuddy `native_args` support;
- automatic `--auto` or `--pure` for OpenCode.

“Resume” in this document initially means resume observation/reconciliation of the same execution. It does not mean sending another
message to the same native session.

## 4. Required safety invariants

### 4.1 Never replay an ambiguous send

The existing submission states remain authoritative:

```text
not_sent
may_have_been_sent
sent
```

Only `not_sent` may enter a fresh dispatch path. A task in `may_have_been_sent` or `sent` can only observe, reconcile, cancel, or become
more conservative. Recovery never turns those states back into `not_sent`.

### 4.2 PID alone is never native process identity

On Windows, a persisted native process identity is valid only when all available ownership evidence matches:

```text
pid
+ process start time
+ canonical executable path
```

The existing Windows host inspection code already exposes these fields using `inspect-process`. The same ±1 second start-time tolerance
used by managed desktop process verification should be reused rather than creating a second ownership rule.

The full command line must not be persisted. It may contain target-native parameters that should be treated as sensitive diagnostic
data. A deterministic launch fingerprint can be persisted instead.

### 4.3 Lease expiry does not prove the native process stopped

An expired `workspace` lease only means that the previous Worker no longer owns the lease. It does not authorize a second writer when
the database still contains a conflicting native process whose state is `running` or `unknown`.

### 4.4 Unknown process identity is conservative

If uAgents cannot distinguish “dead process” from “inspection unavailable / PID reused / identity changed”, the conflicting workspace
stays guarded. The task can become `indeterminate`, but the runtime must not silently admit a second potentially writing native task.

### 4.5 Same Attempt recovery does not create a second process

When the original Attempt has a durable native process record, `resume`/`reconcile` may reacquire observation ownership for that same
Attempt, but it must not call the normal dispatch path again.

## 5. Architecture

Keep the existing short-lived entrypoint plus detached task Worker architecture. Do not add a global daemon.

Add a durable execution substrate below the CLI adapters:

```text
Task Worker
  ├─ execution leases
  ├─ Durable CLI Execution Controller
  │    ├─ verified launch descriptor
  │    ├─ native process identity ledger
  │    ├─ stdout/stderr durable transcript
  │    ├─ transcript tail / replay
  │    └─ process exit observation
  └─ Target Driver
       ├─ argv construction
       ├─ parser
       ├─ native identity extraction
       └─ target-specific reconcile
```

The controller owns process lifecycle mechanics. Target drivers continue to own target-specific argv, native event parsing and native
session semantics.

The existing `cli-process.mjs` should be refactored toward this boundary instead of adding more OpenCode conditions to the generic
transport.

## 6. Store model

### 6.1 Store schema version

The durable process ledger requires a control-plane schema change. Bump `STORE_SCHEMA_VERSION` from 2 to 3 and add an explicit,
transactional v2 -> v3 migration.

Do not strand the current installed state root merely because a new table is added. The migration is additive and must preserve all
existing tasks, attempts, sessions, events and leases.

Old v2 tasks have no durable process record. They keep their existing conservative behavior and must not be retroactively treated as
recoverable native executions.

Automatic v2 -> v3 migration must also be guarded against mixed-generation active execution. A v2 store has no process ledger, so v3
must not claim durable workspace safety while a v2 Attempt may already have started native work. Before changing the metadata version,
the migration must fail closed if the v2 store contains a nonterminal Attempt that is not provably still in a pre-dispatch
`registered/queued + submission=not_sent` state. In particular, `starting`, `running`, `waiting_user`, or `indeterminate` blocks
automatic migration, as does `sent` on any nonterminal Task or `may_have_been_sent` on any Task. Historical `succeeded`, `failed`, and `cancelled`
Tasks are allowed to migrate when their last Attempt records confirmed `sent`: v2 reached those terminal states only after its local
observation path completed, and v3 preserves them as non-durable history without fabricating a `native_processes` row. Resolve/finish
unsafe nonterminal tasks under the old runtime or a future explicit legacy-repair workflow first.

### 6.2 `native_processes`

Add one first-version native process record per CLI Attempt:

```text
native_processes
  id                       INTEGER PRIMARY KEY
  attempt_id               TEXT UNIQUE NOT NULL
  target                   TEXT NOT NULL
  workspace_key            TEXT
  executable_path          TEXT NOT NULL
  executable_sha256        TEXT
  launch_fingerprint       TEXT NOT NULL
  pid                      INTEGER
  process_started_at_ms    INTEGER
  process_state            TEXT NOT NULL
  exit_code                INTEGER
  stdout_relpath           TEXT NOT NULL
  stderr_relpath           TEXT NOT NULL
  stdout_cursor_bytes      INTEGER NOT NULL DEFAULT 0
  stderr_cursor_bytes      INTEGER NOT NULL DEFAULT 0
  workspace_guard_state    TEXT NOT NULL
  observed_at_ms           INTEGER NOT NULL
  exited_at_ms             INTEGER
  created_at_ms            INTEGER NOT NULL
  updated_at_ms            INTEGER NOT NULL
```

Initial enums:

```text
process_state:
  starting | running | exited | unknown

workspace_guard_state:
  held | released | unknown
```

`pid` and `process_started_at_ms` are intentionally nullable while `process_state=starting`. The provisional row is committed before
`spawn()` to close the untracked-child crash window. Before the row can transition to `running`, both fields must be present and the
identity must have passed process inspection. Enforce this in the store helper and, where practical, with a SQLite `CHECK` constraint;
never persist a `running` process without both identity fields.

The first implementation keeps one process row per Attempt. The schema should not pretend that a target can never use multiple local
processes in future; this is a v1 runtime limitation, not a universal target capability statement.

This also fixes the v1 retry boundary: once an Attempt has created its provisional native-process row, that Attempt must never spawn a
second native process. If a pre-send process is later proven dead, uAgents may release its workspace guard and finish the Attempt with
`submission=not_sent`, but retrying native launch requires a new request/Attempt under a future explicit retry protocol. Only an unsent
Attempt that has never created a native-process row may use the existing same-Attempt dispatch recovery path.

### 6.3 Existing `native_sessions`

Do not merge process identity into `native_sessions`.

They represent different identities:

```text
Attempt
  ├─ Native Process   local OS execution identity
  └─ Native Session   target conversation/task identity
```

A process can exist before a session is accepted. A future target can also reconnect to a session through a different process. Keeping
the records separate is required for safe resume semantics.

## 7. Task files

Create an Attempt-specific native directory:

```text
tasks/<request-id>/native/<attempt-id>/
  stdout.log
  stderr.log
  exit.json          # optional atomic exit observation written by the owning Worker
```

The transcript files are append-only while the process is active. They inherit the same state-root access assumptions as `payload.json`.

Do not persist:

- the inherited environment;
- provider credentials;
- the process command line;
- Authorization headers;
- CLI login material.

The existing request/payload files remain the source for reconstructing target arguments when needed for a read-only reconcile helper.

## 8. Launch sequence

For CLI targets using the durable controller, the order is fixed.

### 8.1 Before prompt submission

```text
1. acquire task + global + target + workspace Worker leases
2. verify input snapshots
3. resolve/verify native installation
4. adapter.prepare()
5. create durable stdout/stderr files
6. persist a provisional native_processes row with process_state=starting and workspace guard held
7. spawn native CLI with stdout/stderr redirected to those files
8. verify native process identity (pid + start time + executable path)
9. bind the verified pid/start time to the provisional row and set process_state=running
```

The provisional row is deliberately persisted before `spawn()`. This closes the crash window where a Worker could create a native
process and die before the PID was durable, after which a lease expiry could otherwise admit a second writer.

If the Worker dies while the provisional row still has no PID, recovery cannot prove whether spawn happened. Keep the workspace guard
conservative (`unknown`) rather than redispatching automatically. This rare false-positive blockage is preferable to an untracked
possible writer. A future explicit repair command can resolve such abandoned launch records with stronger host evidence.

If step 8 cannot establish process ownership, terminate the newly created process before any task prompt is written and fail with
`submission=not_sent`.

Persisting the process row does not mean the task has been sent.

### 8.2 Prompt write boundary

Immediately before the first prompt byte can be written:

```text
10. await checkpoint("possibly_sent")
11. write prompt to stdin
12. close stdin
```

The current ordering guarantee is preserved: the durable `possibly_sent` checkpoint must commit before the irreversible stdin write.

### 8.3 Early native acceptance

The Worker tails `stdout.log` from byte zero. As soon as the target driver yields a valid native session/task identity:

```text
13. await checkpoint("accepted", native handle)
14. persist/update native_sessions immediately
15. dispatch() returns the durable handle
```

`dispatch()` must no longer wait for native process exit.

This is the central adapter-contract change in this milestone.

### 8.4 Observation

`observe()` continues tailing the same transcript and process identity until one of these happens:

- target terminal event is verified;
- target enters `waiting_user`;
- the configured observation window ends;
- cancellation is requested;
- process identity is lost;
- output limit is exceeded;
- a Worker lease/fencing error occurs.

Terminal artifact capture remains Runtime-owned and unchanged.

## 9. Durable transcript and cursor semantics

### 9.1 File-backed stdout/stderr

Native stdout and stderr must be redirected to Attempt files rather than existing only in Node pipe buffers. This allows a later Worker
to replay output emitted while the original Worker was gone.

### 9.2 Complete-line cursor

Persist byte cursors only after a complete UTF-8 line has been consumed. A crash may therefore replay the final complete line, but must
never skip an uncommitted partial line.

### 9.3 Cursor is an optimization, not the source of truth

The existing output cap is small enough that a recovered parser can rebuild its closure state from the beginning of the durable
transcript. This should be the first implementation because it avoids serializing target-parser internals.

Therefore:

- the transcript is authoritative;
- the cursor records observation progress and supports efficient normal tailing;
- recovery is allowed to instantiate a fresh parser and replay from byte 0;
- parser publication into the control plane must be idempotent when a replay re-emits a previously seen identity or model patch.

Do not persist arbitrary JavaScript parser state.

### 9.4 Output limits

The existing stdout/stderr limits remain safety limits. File-backed output must not remove them. The Worker periodically checks transcript
size and, when a configured limit is exceeded, enters the same conservative termination path used by the current transport.

## 10. Workspace guard

### 10.1 Why the current lease is insufficient

The current workspace lease is renewable and fenced, but its TTL can expire after Worker death. A native child process does not consult
the SQLite fencing token before editing files.

### 10.2 Guard rule

Before granting a workspace execution lease to a write-capable task, inspect all durable native process rows whose
`workspace_guard_state` is not `released`.

For every overlapping canonical workspace:

```text
same Attempt + verified same process
    -> observation/reconcile takeover may proceed

foreign Attempt + process confirmed alive
    -> reject/queue with workspace_execution_active

foreign Attempt + process identity unknown
    -> reject/queue with workspace_execution_unknown

foreign Attempt + process confirmed dead
    -> persist released guard, then normal lease acquisition may continue
```

Parent/child overlap uses the existing `canonicalWorkspacesOverlap()` implementation. No string-prefix shortcut is allowed.

### 10.3 Guard lifetime

The guard is released only after uAgents has sufficient evidence that the local process can no longer write:

- the owning Worker observed root-process exit and Windows process-tree inspection finds no surviving descendants attributable to that
  execution; or
- a later process inspection proves the recorded PID/start-time/executable identity no longer exists and process-tree inspection finds
  no surviving descendants attributable to the recorded root PID.

Root-process exit alone is not enough. OpenCode can execute tools through child processes, and an advisory “do not start background
work” prompt is not an enforcement boundary. The v1 ledger stores the verified root identity, while the Windows inspector must also
check descendant quiescence before releasing the workspace guard. If descendant enumeration is unavailable or ambiguous, keep the
guard conservative.

Task terminal status alone is not enough if process termination has not been established.

Conversely, a task may remain `indeterminate` after the process is proven dead. In that case the workspace guard may be released even
though the task result is still uncertain, because the purpose of the guard is preventing concurrent local writers, not proving the
task objective.

### 10.4 No automatic force release

The first implementation provides no “ignore guard and continue” switch in normal `submit`. If process inspection is unavailable, the
workspace stays conservative. A future administrative repair command can be designed separately with explicit ownership evidence.

## 11. Process inspection and ownership

### 11.1 Windows

Reuse the existing host action:

```text
inspect-process(pid)
  -> exists
  -> started_at_ms
  -> executable_path

inspect-process-tree(root_pid, root_started_at_ms)
  -> descendants[] { pid, parent_pid, started_at_ms }
```

Extend the existing Windows host script rather than adding a second PowerShell process-inspection implementation. The tree action is
read-only and must not return command lines or environment data.

The host action must distinguish an authoritative “PID does not exist” result from “process inspection failed”. A CIM/provider error
must surface as an inspection error, not as `exists=false`; otherwise a transient host-inspection failure could incorrectly release a
workspace guard while the native process is still alive. If necessary, tighten the existing `windows-host.ps1` implementation so a
successful query with no row yields `exists=false`, while query/provider failure yields `ok=false` and a stable inspection error.

The durable controller should consume a small process-inspector abstraction that calls the same host runner used by the Target
Supervisor.

Process-tree enumeration is conservative. If the recorded root PID has been reused, unrelated descendants of the reused PID may cause a
false-positive guard hold; that is acceptable. A false-positive block is safer than releasing a workspace while a descendant of the
original execution may still be active.

### 11.2 Identity match

For an existing row, a live process matches only when:

```text
observed pid == persisted pid
AND abs(observed started_at - persisted started_at) <= 1000 ms
AND canonical observed executable == expected verified executable
```

If the PID exists with a different start time, the PID has been reused and that is evidence that the originally recorded process ended;
do not adopt or kill the new process, but the old workspace guard can be released after recording the reuse evidence.

If PID and start time match but the executable identity does not, treat ownership as uncertain. Do not kill or adopt that process and
keep the old execution guard conservative until stronger evidence is available.

### 11.3 Other platforms

Keep the interface platform-neutral. A platform without equivalent ownership evidence must not claim durable adoption support merely
because `kill(pid, 0)` succeeds. That platform can retain conservative unknown behavior until a proper inspector is implemented.

## 12. Recovery matrix

The implementation must be tested against each crash window.

| Crash point | Persisted facts | Recovery rule |
| --- | --- | --- |
| before provisional launch guard | `submission=not_sent`, no process row | normal unsent recovery may redispatch same Attempt |
| after provisional guard, before verified PID | `submission=not_sent`, `process_state=starting`, PID may be unknown | no automatic redispatch; reconcile launch ownership or keep workspace guarded unknown |
| after process identity persisted, before `possibly_sent` | verified process row exists, prompt not sent | verify/terminate idle owned process and release guard; do not spawn again in this Attempt; finish a not-sent preflight failure and require a new request to retry |
| after `possibly_sent`, before native session identity | prompt may be executing, process row exists | never replay; inspect same process and replay transcript; if identity later appears, persist `accepted` |
| after `accepted`, process alive | process + session rows exist | reacquire same-Attempt observation ownership and continue tailing; never spawn another native run |
| after process exit, before task terminal persisted | durable transcript exists, process dead | replay transcript; target-specific read-only reconcile may strengthen evidence; no prompt replay |
| process identity mismatch / inspector unavailable | execution identity uncertain | task remains/enters `indeterminate`; workspace guard remains conservative |

## 13. `resume` and `reconcile`

### 13.1 `resume`

Extend `TaskService.resume()` routing:

```text
unsent registered/queued/preflight waiting
    -> existing dispatch recovery

sent or may-have-been-sent + durable process/session identity
    -> reconcile/observation recovery

terminal
    -> reject
```

`resume` must still never turn a possibly-sent Attempt into fresh dispatch.

### 13.2 `reconcile`

For durable CLI Attempts, reconciliation checks in this order:

1. persisted Attempt and native-process identity;
2. current process ownership;
3. durable transcript replay;
4. persisted native session identity;
5. optional target-specific read-only session query.

The workspace execution lease may be reacquired for the same Attempt so that one recovery observer has control-plane ownership. The
foreign-workspace guard remains in force for every other Attempt until process death is established.

## 14. OpenCode first target

OpenCode should be the first real target on the durable CLI substrate because the current release already has a verified implementation
E2E and emits `sessionID` in its JSON event stream.

Local OpenCode 1.18.13 also exposes these native commands/options:

```text
opencode run --session <session-id>
opencode run --continue
opencode export <session-id>
opencode session list --format json
```

For this milestone:

- `run --session` and `--continue` are **not** used for automatic recovery because they can create a new model turn;
- OpenCode `sessionID` from the original event stream is persisted immediately at acceptance;
- a read-only OpenCode reconciliation adapter may use `export <session-id>` only after a fixture proves that it performs local session
  inspection without submitting a new provider message;
- any exported session must match the exact persisted session ID and workspace/project identity before its evidence is accepted;
- no target-specific native query is allowed to create a new session or send a prompt.

The existing `OPENCODE_PROTOCOL_FLAGS` conflict map remains unchanged in this milestone unless new dispatcher-owned reconcile flags are
introduced by the implementation.

## 15. Parser contract changes

The parser must become replay-safe without becoming responsible for persistence.

The initial API can remain factory based:

```text
createParser(request, workspace, publish)
  .stderr(text)
  .event(json)
  .finish(exitInfo)
```

But the controller must be able to instantiate a fresh parser and replay the transcript from the beginning. Therefore target parsers
must satisfy:

- deterministic result for the same ordered transcript;
- no external side effects;
- stable native identity validation;
- repeated replay may emit duplicate `publish()` patches, and the caller must make their persistence idempotent;
- malformed or mixed-session events still fail closed.

A later refactor to a pure reducer is possible, but it is not required to land this milestone.

## 16. Observation timeout versus execution timeout

The current generic CLI transport uses `observation_timeout_ms` as a timer that also kills the local child. That conflates two different
semantics and should be corrected after durable observation exists.

### 16.1 Observation timeout

`observation_timeout_ms` means how long the current observer waits for progress/terminal evidence. Expiry stops this observation window;
it does not by itself prove or request native termination.

If the process is still verified alive, the task remains running/indeterminate according to available evidence and the workspace guard
remains held. A later explicit reconcile can continue observation.

### 16.2 Execution timeout

`execution_timeout_ms` remains rejected until a target exposes a verified termination primitive.

For Windows CLI targets, a later phase may use the existing owned-process verification plus `taskkill /T /F`, followed by process
reinspection. Even then, local process-tree termination is not provider cancellation acknowledgement. The task should fail with a stable
`execution_timeout` error unless the target independently reports a native cancelled terminal state.

Do not enable `execution_timeout` capability merely because `child.kill()` exists.

## 17. Cancellation

Cancellation gets the same process-ownership requirement as execution timeout.

For a durable local CLI process:

1. verify recorded PID/start-time/executable identity;
2. request target-native cancellation if a verified native method exists;
3. otherwise, if policy allows local process termination, terminate only the verified owned process tree;
4. re-inspect process identity;
5. release workspace guard only after death is confirmed;
6. do not label provider/native cancellation “confirmed” unless the target supplies that evidence.

The first implementation may preserve the current conservative `indeterminate` result after local cancellation while still gaining the
workspace-safety benefit of confirmed local process death.

## 18. Public status projection

Persist more detail internally than is exposed publicly.

Add an optional sanitized execution summary to `status`/`result`:

```json
{
  "execution": {
    "durable": true,
    "process_state": "running",
    "workspace_guard": "held",
    "observation_resumable": true,
    "stdout_cursor_bytes": 12345,
    "stderr_cursor_bytes": 0,
    "started_at_ms": 1788700000000
  }
}
```

Do not expose the inherited environment or full argv. PID and executable path should stay diagnostic-only unless a concrete public API
consumer requires them.

Existing Schema 1.0 request shape does not need a breaking version change for this milestone.

## 19. Error additions

Add stable codes only where callers need to distinguish recovery actions:

- `workspace_execution_active` — an overlapping workspace still has a verified live foreign native process;
- `workspace_execution_unknown` — an overlapping prior execution cannot yet be proven dead;
- `native_process_identity_mismatch` — PID exists but start time/executable does not match the persisted process;
- `native_process_inspection_failed` — ownership evidence could not be obtained;
- `native_observation_unavailable` — durable transcript/session exists but cannot currently be reconciled;
- `store_migration_blocked` — schema v2 contains an in-flight/ambiguous Attempt that cannot be given trustworthy v3 process identity;
- `execution_timeout` — reserved for the later independently verified execution-deadline phase.

All of these preserve the existing `submission` field. Workspace admission errors before a new task sends anything use `not_sent`.

## 20. Implementation phases

### Phase A — Store and workspace guard

Add schema v3 migration, `native_processes`, process-record helpers and foreign native-execution checks in workspace lease acquisition.

No real adapter changes in this phase. Fake records prove that an expired Worker lease cannot admit a second writer while a durable
foreign execution is alive/unknown.

Acceptance:

- v2 -> v3 migration preserves existing tasks;
- same Attempt can reacquire observation ownership;
- foreign live execution blocks parent/child overlapping workspaces;
- foreign dead execution releases the guard;
- PID reuse/mismatch never gets adopted;
- old fencing tokens still cannot mutate state.

### Phase B — Durable generic CLI transport

Refactor `cli-process.mjs` so stdout/stderr are file-backed, process identity is persisted before stdin submission, native acceptance is
checkpointed during execution, and `observe()` tails/replays the transcript independently of `dispatch()`.

Acceptance with injected drivers:

- crash after every launch/send/accept boundary preserves the recovery matrix;
- a recovered Worker parses a transcript written while the first observer was absent;
- prompt is sent exactly once;
- replayed output does not create a second native session row;
- output limits still apply.

### Phase C — OpenCode durable execution

Move OpenCode onto the durable controller, persist `sessionID` on first valid event, and add read-only session reconciliation fixtures.

Acceptance:

- real argv remains `opencode run ...` with caller-controlled `native_args`;
- no default `--pure` or `--auto`;
- a killed uAgents Worker does not cause a second OpenCode process to enter the same workspace;
- same Attempt recovery does not resend the original prompt;
- OpenCode session identity remains stable through replay/reconcile;
- declared output capture is unchanged.

### Phase D — Observation semantics

Separate observation timeout from local process termination. Extend `resume`/`reconcile` routing for durable CLI Attempts.

Acceptance:

- observation timeout alone does not kill a verified running native process;
- explicit reconcile can later reach the same Attempt;
- workspace guard remains held while the native process is alive;
- process death allows workspace release even if task outcome remains indeterminate.

### Phase E — Other CLI targets

Only after OpenCode and fake-driver crash tests are stable, evaluate agy and WorkBuddy separately.

Each target must prove:

- early native identity availability;
- replay-safe event parsing;
- same-session read-only reconciliation or an explicit statement that post-crash outcome stays indeterminate;
- no regression in target-specific model/cwd/permission validation.

Do not force all CLI targets to advertise identical recovery capability.

## 21. Expected code boundaries

Likely new/changed modules:

```text
plugins/uagents/src/store/schema.mjs
plugins/uagents/src/store/database.mjs

plugins/uagents/src/runtime/native-processes.mjs       # new durable process ledger
plugins/uagents/src/runtime/process-inspector.mjs      # new shared ownership facade
plugins/uagents/src/runtime/leases.mjs                 # workspace durable guard
plugins/uagents/src/runtime/task-service.mjs           # status/resume projection
plugins/uagents/src/runtime/worker.mjs                 # dispatch/observe lifecycle split
plugins/uagents/src/runtime/reconcile.mjs              # durable CLI recovery

plugins/uagents/src/transports/cli-process.mjs         # durable transcript controller
plugins/uagents/src/transports/opencode-driver.mjs     # early identity + read-only reconcile

plugins/uagents/scripts/windows-host.ps1               # reuse inspect-process; no duplicate ownership path
```

If implementation reveals that `process-inspector.mjs` can call existing Host Supervisor primitives without a new module, prefer reuse
over a second abstraction.

## 22. Test plan

Extend existing focused files rather than creating a parallel test framework:

```text
tests/sqlite-store.test.mjs
tests/workspace-locks.test.mjs
tests/runtime-crash.test.mjs
tests/cli-transports.test.mjs
tests/unified-cli-adapters.test.mjs
tests/managed-reconcile.test.mjs  # only if shared ownership helper changes
```

Add a dedicated durable execution suite only when existing files become unreadable.

Required destructive cases:

1. Worker dies after provisional workspace guard, before native spawn.
2. Worker dies after native spawn, before verified PID is persisted.
3. Worker dies after verified process identity, before possibly-sent.
4. Worker dies after possibly-sent, before stdin closes.
5. Worker dies after stdin closes, before session identity.
6. Worker dies after session identity, before accepted commit.
7. Worker dies after accepted while native process remains alive.
8. Worker dies after native process exit, before unified terminal transition.
9. Lease expires while native process remains alive; second workspace writer is rejected.
10. PID is reused with a different start time; no adoption or kill occurs and the old guard can be released.
11. PID/start time match but executable identity differs; no adoption or kill occurs and the guard stays conservative.
12. Parent and child workspaces remain mutually guarded.
13. Transcript ends with a partial UTF-8 line; recovery neither skips nor corrupts it.
14. Replaying the same transcript creates no duplicate session or terminal transition.
15. Cancellation during recovery never sends the original prompt again.

Keep normal tests provider-free. A real OpenCode crash/reconcile smoke requires explicit user authorization because it may consume
provider quota or modify a temporary workspace.

## 23. Release acceptance

This milestone is release-ready only when all of the following are true:

- standard uninterrupted OpenCode implementation still passes its existing artifact E2E;
- the native process identity is durable before prompt submission;
- `accepted` is persisted when session identity first appears, not after process completion;
- a Worker crash cannot allow another Attempt to write an overlapping workspace while the old process is verified alive/unknown;
- the same Attempt can recover observation without replaying the task prompt;
- process/session identity mismatches fail closed;
- schema v2 state migrates safely to v3;
- normal regression tests remain provider-free;
- plugin packaging and fresh-process installation verification continue to pass.

The decisive safety test is:

> Kill the uAgents Worker after OpenCode has accepted the request but while OpenCode is still running. Let the normal Worker lease expire.
> A second implementation request for the same workspace must not launch another OpenCode process. Reconciliation must attach only to
> the original Attempt's persisted process/session evidence and must never resend the original prompt.

## 24. Follow-up roadmap

After this design is implemented and verified, the next independent increments are:

1. verified local execution timeout and process-tree termination semantics;
2. richer target-native session reconciliation for agy/WorkBuddy;
3. explicit multi-turn session continuation as a new user action, never implicit recovery;
4. retention/cleanup policy for durable native transcripts;
5. multimodal input/output protocol.

These should not be bundled into the durable-execution foundation unless implementation evidence shows a direct dependency.
