# Verified Execution Timeout Implementation Plan

Date: 2026-09-06

Design: `docs/superpowers/specs/2026-09-06-verified-execution-timeout-design.md`

Baseline: `841d87b docs: record durable execution release acceptance`

Status: Source implementation complete. Core `254/254` plus MCP `11/9/2` (`276/276` total) pass provider-free. Source validators/commit and then version bump, installation, and fresh-cache acceptance remain.

## 1. Commit boundary

Keep this milestone separate from multi-turn continuation, agy/WorkBuddy durable migration, multimodal work, and provider-native cancellation.

The source commit should include only:

- Windows owned process-tree terminator;
- per-Attempt execution-timeout guardian;
- durable controller integration;
- Windows OpenCode capability gate;
- runtime indeterminate observation fix required by timeout correctness;
- provider-free tests and documentation.

## 2. Step A — owned process-tree primitive

Files:

- add `plugins/uagents/src/host/process-terminator.mjs`;
- add `tests/process-terminator.test.mjs`.

Acceptance:

- exact PID/start/executable match required before `taskkill`;
- mismatch/inspection failure never starts taskkill;
- absolute System32 taskkill path and `shell:false`;
- root death alone is insufficient;
- descendant quiescence is mandatory;
- real harmless Node fixture passes on Windows.

## 3. Step B — persistent deadline/evidence helpers

Files:

- add `plugins/uagents/src/runtime/execution-timeout.mjs`;
- add `tests/execution-timeout.test.mjs`.

Use existing event timestamps instead of Store v4. Derive deadline from the first `dispatch.possibly_sent` event.

Acceptance:

- deadline is stable after Store reopen;
- timeout evidence is idempotent;
- confirmed termination records evidence before guard release;
- unconfirmed termination cannot release guard;
- already-complete native tree is cleared rather than mislabeled timeout.

## 4. Step C — detached guardian and ready handshake

Files:

- add `plugins/uagents/src/runtime/execution-timeout-guardian.mjs`;
- add `tests/execution-timeout-guardian.test.mjs`.

Ordering:

```text
verified native PID/start/exe
  -> spawn detached timeout guardian
  -> guardian validates persisted Attempt/process/request
  -> persist execution.timeout_guardian_ready
  -> parent observes ready
  -> checkpoint dispatch.possibly_sent
  -> first prompt byte
```

Acceptance:

- guardian argv carries no prompt;
- minimal environment has no provider secrets;
- exit before ready fails closed;
- ready timeout fails closed;
- guardian survives task Worker death;
- deadline remains based on durable evidence rather than parent timers.

## 5. Step D — durable controller integration

Files:

- `plugins/uagents/src/transports/durable-cli-execution.mjs`;
- `plugins/uagents/src/adapters/cli-base.mjs`.

Requirements:

- launch required guardian before `possibly_sent` when timeout is requested;
- do not alter behavior when timeout is null;
- make `execution.timeout_started` own the native-close interpretation race;
- durable observation/reconcile return timeout evidence as indeterminate outcome;
- retain `observation_timeout_ms` semantics as observer-only;
- close callbacks must tolerate a control database that has already been closed during test/process teardown.

## 6. Step E — capability gate

Files:

- `plugins/uagents/src/registry/builtins.mjs`;
- `plugins/uagents/src/registry/registry.mjs`;
- `tests/registry-policy.test.mjs`.

Requirements:

- only Windows OpenCode built-in descriptor advertises `execution_timeout`;
- user registry config may only disable the built-in capability;
- agy, WorkBuddy, desktop targets, and non-Windows OpenCode keep policy rejection.

## 7. Step F — Runtime convergence

File:

- `plugins/uagents/src/runtime/worker.mjs`.

An explicit adapter `indeterminate` event is a completed observation result for the current Worker turn. `runTask()` must return it directly and must not append a later `native_terminal_missing` fallback event.

The timeout guardian does not bypass fencing to mutate Task state. A live Worker performs the transition; a dead Worker leaves timeout evidence for later same-Attempt reconcile.

## 8. Step G — destructive OpenCode fixtures

File:

- `tests/opencode-durable-recovery.test.mjs`.

Required cases:

1. live Worker + hanging native fixture + timeout -> owned tree terminated -> Task `indeterminate/execution_timeout`;
2. Worker killed after acceptance but before deadline -> guardian survives -> same native PID dies -> guard releases -> second overlapping request succeeds;
3. original timed-out Attempt reconcile performs zero spawn calls and prompt count remains 1.

No real provider request is permitted in normal tests.

## 9. Documentation

Update:

- `README.md`;
- `docs/README.md`;
- `docs/status/2026-09-06-current-status.md`;
- `plugins/uagents/skills/agent-dispatch/references/protocol.md`;
- `plugins/uagents/skills/agent-dispatch/references/opencode-council.md`;
- previous durable design/plan sections that said execution timeout was still future work.

The docs must distinguish current source from the already installed durable RC until a new plugin build is installed.

## 10. Final source gate

Run:

```powershell
npm.cmd test
python C:\Users\24590\.codex\skills\.system\skill-creator\scripts\quick_validate.py plugins/uagents/skills/agent-dispatch
python C:\Users\24590\.codex\skills\.system\plugin-creator\scripts\validate_plugin.py plugins/uagents
git diff --check
```

Then inspect the full diff and commit the timeout source milestone from a clean, reviewed scope.

## 11. Release-candidate gate

After source commit:

1. generate a new Codex plugin build-metadata timestamp;
2. rerun source tests/validators;
3. sync only tracked plugin files to the personal marketplace source;
4. preserve the previous marketplace source and caches;
5. install through normal `codex plugin add`;
6. compare repository plugin / marketplace source / new cache by per-file SHA-256;
7. validate the new cache directly;
8. run a fresh read-only Codex process and verify `capabilities opencode` exposes execution timeout on Windows;
9. do not run a provider timeout smoke without explicit user authorization.
