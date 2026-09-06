# Redundant Execution-Timeout Guardian Design

Date: 2026-09-07

Baseline: `eb34812 docs: record verified timeout release acceptance`

Status: Source implementation is committed as `c20172d` and provider-free verified. Core `257/257` plus MCP `11/9/2` (`279/279` total) pass. Release-candidate metadata is `0.2.0-alpha.1+codex.20260907011733`; installation/fresh-cache acceptance is pending. The currently installed `...20260906234542` cache remains the preceding single-guardian build until that acceptance completes.

## 1. Problem

The first verified execution-timeout implementation separated the timeout guardian from the observing Worker, so a Worker crash cannot silently disable `execution_timeout_ms`. The guardian itself, however, is still one local process. If that process is externally terminated after its durable ready handshake, the native OpenCode process can outlive the requested execution deadline.

The follow-up must tolerate one guardian-process failure without introducing a global daemon, replaying the prompt, weakening process ownership checks, or allowing two timeout actors to race control-plane state.

## 2. Goals

1. Require two independent detached guardians before the first prompt byte.
2. Persist distinct ready evidence for `primary` and `secondary` guardian slots.
3. Bind each ready record to the PID of the child the launcher actually spawned.
4. Allow either guardian to enforce the same durable deadline after Worker death.
5. Serialize process-tree termination through a short-lived Attempt-scoped claim.
6. Heartbeat that claim while termination is in progress.
7. Allow the surviving guardian to take over after the claim TTL if the claimant dies.
8. Fence a stale claimant from writing timeout/process/guard state after takeover.
9. Keep prompt count exactly one and preserve same-Attempt reconcile semantics.

## 3. Non-goals

- no global uAgents daemon;
- no Windows service or Task Scheduler dependency;
- no guarantee against simultaneous external destruction of both guardians;
- no provider/native cancellation acknowledgement;
- no automatic OpenCode `run --session` or `--continue`;
- no agy/WorkBuddy migration;
- no Store schema migration;
- no multimodal work.

## 4. Redundant launch contract

The production launcher owns two slots:

```text
primary
secondary
```

Each guardian receives only:

```text
<state-root> <attempt-id> <slot> <execution-timeout-ms>
```

The numeric timeout is the only request-derived value passed to the guardian. It receives no prompt, native argv, provider credentials, or request body, and it no longer reads `request.json`. The existing minimal guardian environment remains unchanged.

The launcher starts the slots independently and waits for a durable `execution.timeout_guardian_ready` event whose payload contains the exact slot and exact spawned child PID. A ready event for the wrong PID is not accepted.

Fresh execution may continue to `dispatch.possibly_sent` only after both slots have produced valid ready evidence. If the second slot fails after the first is ready, the launcher terminates the first guardian and fails closed with `execution_timeout_guardian_unavailable` / `submission=not_sent`.

After both slots are ready, one guardian may fail without invalidating the already-sent Attempt; the other remains responsible for the same persisted deadline.

## 5. Durable ready evidence

No Store schema change is needed. The existing event table holds one idempotent ready record per slot:

```json
{
  "phase": "ready",
  "slot": "primary",
  "pid": 1234
}
```

Ready evidence is internal control/diagnostic evidence. It is not provider identity and is not permission evidence.

## 6. Timeout termination claim

Reuse the existing generic `leases` table with one resource key per Attempt:

```text
execution-timeout:<attempt-id>
```

The resource type is `execution_timeout`.

Initial parameters:

- TTL: 5 seconds;
- heartbeat: 1 second;
- guardian poll: 250 ms.

Only the guardian holding the current claim may persist timeout evidence or mutate native-process / workspace-guard state. Existing lease epoch + fencing-token semantics therefore protect timeout convergence just as Worker leases protect normal runtime writes.

If a claimant dies, its heartbeat stops. After TTL expiry the surviving guardian acquires a higher epoch and continues enforcement. A stale guardian that later resumes cannot overwrite the new claimant's control-plane facts.

## 7. Deadline and takeover semantics

Both guardians derive the deadline only from:

```text
dispatch.possibly_sent.created_at_ms + execution_timeout_ms
```

They never derive it from their own launch time.

At or after the deadline:

1. persist/replay `execution.timeout_started`;
2. try to acquire the Attempt timeout claim;
3. if another unexpired claimant owns it, wait and re-check durable evidence;
4. after acquisition, heartbeat the claim;
5. run the existing PID + start-time + executable verified process-tree terminator;
6. persist `execution.timeout` and process/guard changes only while the claim fencing token is valid;
7. release the claim when finished.

If a takeover guardian first observes the owned tree already quiescent after the durable deadline has begun, it cannot prove that the tree exited before the deadline. The conservative result is therefore still `execution_timeout`, not `timeout_cleared`. This also closes the crash window where a previous claimant may have started termination but died before persisting its final result.

## 8. Observation settle window

The observer must not declare termination unconfirmed before one normal claim failover can complete.

The settle window is 20 seconds, covering:

- one 5-second claim expiry;
- one full 10-second owned-tree termination budget;
- Windows inspection/scheduling margin.

Observation remains a consumer of durable timeout facts, not the execution-timeout authority.

## 9. Safety invariants

- two distinct slot/PID ready records are required before send;
- one guardian death after ready does not replay or abort the native request;
- only current claim fencing can mutate timeout/process/guard state;
- PID alone is never ownership evidence;
- process-tree termination still requires PID + start time + executable match;
- workspace guard release still requires root death + descendant quiescence;
- confirmed local deadline enforcement is not provider/native cancellation acknowledgement;
- same Attempt recovery never spawns another OpenCode process or resends the prompt.

## 10. Acceptance tests

Provider-free acceptance must prove:

1. launcher waits for `primary` and `secondary` ready with matching PIDs;
2. primary-ready + secondary-launch failure kills the primary and stays `not_sent`;
3. claim is exclusive while live;
4. claim heartbeat extends ownership;
5. expired claim can be taken over with a higher fencing epoch;
6. stale claim release cannot delete the new owner's claim;
7. a secondary guardian takes over a simulated dead claimant and enforces exactly once;
8. real Windows fixture: kill one ready guardian, then kill the Worker, and the surviving guardian still terminates the original owned native tree at the same deadline;
9. prompt count remains one;
10. workspace guard releases only after quiescence;
11. reconcile of the original Attempt performs zero spawn and zero resend.

No real OpenCode/provider timeout request is required for normal acceptance.

## 11. Remaining limitation

This design tolerates one guardian-process failure. Simultaneous destruction of both guardians remains outside the guarantee. Removing that final local-process failure class would require a stronger host primitive such as a persistent host supervisor/service or an OS-native deadline/Job-object mechanism; that should be a separate design decision rather than silently turning uAgents into a daemon.
