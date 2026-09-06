# Verified Execution Timeout and Owned Process-Tree Termination

Date: 2026-09-06

Status: Implemented and provider-free source verified. Core `254/254` plus MCP `11/9/2` (`276/276` total) pass. Release packaging/install acceptance for this follow-up is still pending.

Baseline: `841d87b docs: record durable execution release acceptance`

## 1. Problem

Durable OpenCode separates observation lifetime from native execution lifetime. `observation_timeout_ms` and cancel intent therefore cannot safely be implemented by killing a child process: an observer can disappear while the verified native execution continues, and the process can survive its original Worker.

`execution_timeout_ms` needs a different contract. It is an execution deadline that remains enforceable after Worker death, but only when uAgents can prove ownership of the exact local process tree.

## 2. Scope

The first implementation supports only Windows OpenCode because that path already has durable PID, process start time, canonical executable path, process-tree inspection, and workspace guards.

The following remain unsupported by this milestone:

- execution timeout for agy or WorkBuddy;
- execution timeout for non-Windows OpenCode;
- provider/native cancellation acknowledgement;
- automatic `opencode run --session` or `--continue`;
- cancellation by execution timeout for desktop targets;
- a global uAgents daemon.

## 3. Safety invariants

1. `observation_timeout_ms` never implies native termination.
2. A cancel request never implies provider/native cancellation.
3. `execution_timeout_ms` is admitted only when the target descriptor exposes a verified termination capability.
4. The timeout guardian must become durably ready before `dispatch.possibly_sent` and before the first prompt byte.
5. The execution deadline starts at the durable `dispatch.possibly_sent.created_at_ms` timestamp.
6. A persisted PID alone is never ownership evidence.
7. `taskkill` is never invoked until PID + start time + executable identity still match the durable process record.
8. Workspace guard release requires root death plus descendant process-tree quiescence.
9. Local process-tree death is not provider/native cancellation acknowledgement.
10. A confirmed execution timeout therefore yields unified `indeterminate + execution_timeout` unless stronger native terminal evidence exists.
11. If termination cannot be proved, the result is `execution_timeout_termination_unconfirmed` and the workspace guard remains conservative.

## 4. Deadline boundary

The deadline is:

```text
dispatch.possibly_sent.created_at_ms + execution_timeout_ms
```

The guardian is launched before `possibly_sent`, but the ready/setup interval is not charged to the user's execution deadline. This prevents installation/process-inspection latency from consuming execution budget before uAgents reaches the irreversible send boundary.

## 5. Per-Attempt timeout guardian

Each durable OpenCode Attempt with a non-null timeout receives one detached timeout guardian. It is not a scheduler daemon and does not own task dispatch.

The guardian argv contains only:

```text
node execution-timeout-guardian.mjs <state-root> <attempt-id>
```

It never receives the prompt, target-native args, provider response data, or credentials. Its environment is restricted to Windows/process-control essentials (`SystemRoot`/`WINDIR`, PATH/PATHEXT, ComSpec, TEMP/TMP).

Before the parent Worker is allowed to checkpoint `possibly_sent`, the guardian opens the existing control store, validates the Attempt/request/native-process identity, and persists:

```text
execution.timeout_guardian_ready
```

The launcher waits for this durable evidence. Process creation without the ready event is insufficient. A guardian that exits or fails to become ready causes `execution_timeout_guardian_unavailable` with `submission=not_sent`; the just-created native child is terminated through the pre-send child-handle path and the prompt is not written.

## 6. Timeout evidence state

No Store schema bump is required. The timeout protocol is represented by append-only events:

- `execution.timeout_guardian_ready` — guardian initialization completed before send;
- `execution.timeout_started` — deadline reached and termination interpretation now owns the native-close race;
- `execution.timeout` — final timeout evidence with `termination_confirmed` and a stable reason;
- `execution.timeout_cleared` — the process was already naturally complete when deadline enforcement inspected it.

`execution.timeout_started` is important because a Windows process close can become visible before `taskkill` tree verification finishes. While timeout enforcement is pending, the normal close tracker must not reinterpret that close as an ordinary native completion.

## 7. Owned process-tree terminator

The Windows terminator follows this sequence:

1. inspect persisted PID;
2. classify against persisted start time with the existing ±1000 ms tolerance and persisted executable path;
3. refuse termination on identity mismatch or inspection uncertainty;
4. invoke the absolute `%SystemRoot%\\System32\\taskkill.exe /PID <pid> /T /F` with `shell:false`;
5. re-inspect the root process until the old identity is gone;
6. inspect descendants for the original root identity;
7. report success only when the root is dead/reused and the descendant tree is quiescent.

A non-zero `taskkill` exit code is not itself success or failure. Post-action ownership evidence is authoritative.

## 8. Workspace and Task semantics

When owned-tree termination is confirmed, uAgents persists timeout evidence first, then marks the local process exited and releases the workspace guard after quiescence proof.

When ownership or termination is uncertain, timeout evidence is persisted with `termination_confirmed=false`, the native process record becomes/retains `unknown`, and the workspace guard is not released.

The guardian deliberately does not mutate Task state without a Worker fencing lease. If the normal Worker is alive, durable observation consumes timeout evidence and transitions the Task to `indeterminate`. If the Worker died first, the guardian can still terminate the local writer and record evidence; later `resume`/`reconcile` performs the legal state-machine convergence without spawning or resending the prompt.

## 9. Error semantics

### `execution_timeout`

The configured execution deadline was reached and the owned local process tree was confirmed dead/quiescent after timeout enforcement. This does **not** mean the provider/native session acknowledged cancellation.

### `execution_timeout_termination_unconfirmed`

The execution deadline was reached but ownership/termination evidence did not become strong enough. The workspace remains guarded conservatively.

### `execution_timeout_guardian_unavailable`

The timeout contract could not be established before the send checkpoint. Submission remains `not_sent` and the prompt is never written.

## 10. Capability gating

The OpenCode built-in descriptor exposes `execution_timeout: true` only on Windows. Registry restrictions may disable it but cannot enable it where the built-in target does not support it.

Policy continues to reject a non-null `execution_timeout_ms` for all targets/platforms whose descriptor does not expose that capability.

## 11. Provider-free acceptance

Required tests include:

- identity mismatch never invokes `taskkill`;
- real harmless Windows Node process tree can be terminated and proven quiescent;
- guardian creation without durable ready evidence fails before send;
- execution deadline survives reopening the Store;
- confirmed timeout releases guard only after quiescence;
- unconfirmed timeout retains an unknown guard;
- a live Worker observes `execution_timeout` rather than `native_terminal_missing`;
- the Worker can be forcibly killed before the deadline and the detached guardian still terminates the original native process;
- the timed-out Attempt prompt count remains exactly 1;
- a second overlapping workspace task is admitted only after confirmed tree quiescence;
- reconcile of the original Attempt never spawns or resends.

Normal acceptance remains provider-free. A real OpenCode provider timeout smoke requires explicit authorization.

## 12. Known limitation

The guardian is intentionally independent of the task Worker, but it is still a local process. External forced termination of the guardian itself after the ready handshake is outside the first implementation's guarantee. The design avoids claiming stronger fault tolerance than the local host can prove; future work could add a host-level guardian supervisor/heartbeat if this failure mode becomes operationally important.
