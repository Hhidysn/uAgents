# Redundant Execution-Timeout Guardian Implementation Plan

Date: 2026-09-07

Design: `docs/superpowers/specs/2026-09-07-redundant-timeout-guardian-design.md`

Baseline: `eb34812 docs: record verified timeout release acceptance`

Status: Source implementation is committed as `c20172d` and provider-free verified. Core `257/257` plus MCP `11/9/2` (`279/279` total) pass. Release-candidate metadata is `0.2.0-alpha.1+codex.20260907011733`; installation/fresh-cache acceptance remains.

## 1. Commit boundary

Keep this follow-up independent from target expansion and provider-native cancellation.

Expected source changes:

- `plugins/uagents/src/runtime/execution-timeout.mjs`
- `plugins/uagents/src/runtime/execution-timeout-guardian.mjs`
- `plugins/uagents/src/transports/durable-cli-execution.mjs`
- timeout and OpenCode durable recovery tests
- protocol/OpenCode/status documentation.

No Store schema change is expected.

## 2. Step A — multi-slot ready evidence

Change guardian ready persistence from one event per Attempt to one idempotent event per slot.

Acceptance:

- `primary` and `secondary` can coexist;
- duplicate ready for one slot is idempotent;
- launcher validates ready PID against the spawned child PID;
- the only request-derived guardian argv value is the numeric timeout; prompt/provider data never appears in guardian argv/environment/events and the guardian does not read `request.json`.

## 3. Step B — redundant launcher

Launch the two guardian slots before `possibly_sent`.

Acceptance:

- both ready -> dispatch may proceed;
- first ready + second failure -> first guardian is killed and dispatch remains `not_sent`;
- launcher returns only sanitized PID/slot diagnostics, not ChildProcess objects.

## 4. Step C — Attempt timeout claim

Reuse task DB leases with resource key `execution-timeout:<attempt-id>`.

Acceptance:

- active foreign claimant blocks another guardian;
- heartbeat renews the claim;
- expired claim takeover increments epoch;
- stale release cannot remove the new claim;
- no new schema/migration is required.

## 5. Step D — claim-fenced termination

Run owned-tree termination only after claim acquisition and heartbeat the claim while termination is active.

Pass the claim fencing token through timeout evidence, process exit, and workspace guard release writes.

Acceptance:

- stale claimant cannot overwrite takeover state;
- unconfirmed identity keeps process/guard unknown;
- quiescent tree after deadline converges conservatively to `execution_timeout`;
- provider/native cancellation remains unconfirmed.

## 6. Step E — observer settle budget

Increase timeout settle to cover one claim failover plus one full termination budget.

Acceptance:

- observer does not pre-empt healthy failover with premature `execution_timeout_termination_unconfirmed`;
- observation timeout semantics remain unchanged.

## 7. Step F — destructive provider-free validation

Upgrade the existing Windows OpenCode timeout fixture:

1. start timeout-enabled fake OpenCode;
2. wait for two guardian ready events;
3. kill one guardian PID;
4. prove that guardian is absent;
5. kill the observing Worker;
6. wait past the durable deadline;
7. surviving guardian terminates the original native tree;
8. prompt count remains one;
9. original Attempt reconcile performs zero spawn/resend;
10. overlapping workspace becomes admissible only after quiescence.

## 8. Final gates

Before source commit:

- focused guardian/timeout/OpenCode durable tests;
- full root + MCP suite;
- Skill validator;
- Plugin validator;
- `git diff --check` and staged `git diff --check`;
- one final combined diff review.

After source commit, use a separate release-metadata scope:

- bump only Codex plugin build metadata;
- rerun provider-free gates;
- sync only tracked plugin files to personal marketplace source;
- preserve previous source/cache for rollback;
- install through normal plugin flow;
- repository/marketplace/cache per-file SHA-256 comparison;
- fresh read-only Codex host load and capability queries;
- no real OpenCode/provider timeout smoke without explicit authorization.
