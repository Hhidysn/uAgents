# Runtime reliability repair verification

Date: 2026-09-06 (Asia/Shanghai). Workspace: `F:\documents\software\uAgents`.

## Implemented scope

- Contended workers wait with a task lease and bounded backoff, observe cancellation and leave recoverable queued work when the wait expires. Registered/queued unsent tasks can resume on the original attempt; duplicate queued submission can restart abandoned work. Atomic attempt ownership and existing durable send checkpoints prevent replay.
- Doubao observation uses its managed port. Desktop reconciliation resolves the accepted attempt's original instance and profile generation through the Supervisor, with host lease ownership checks and no launch/replacement/default-port fallback.
- Advisory read-only instructions reach all five targets at dispatch without changing the stored request or idempotency hashes. WorkBuddy advisory requests no longer enable `acceptEdits` implicitly.
- CLI/MCP launch and recovery integration is wired. Synchronous and asynchronous worker startup failures remain recoverable with the same UUID. Rejected reconciliation evidence cannot overwrite the prior response.

Design and plan: [design](../superpowers/specs/2026-09-05-runtime-reliability-fixes-design.md), [plan](../superpowers/plans/2026-09-05-runtime-reliability-fixes.md). Three GPT-5.6 Luna Max workers implemented bounded slices; the primary integrated and verified the result.

## Executed checks

`npm test` completed with exit code 0:

| Suite | Passed | Failed |
| --- | ---: | ---: |
| Core and integration | 169 | 0 |
| Doubao MCP | 11 | 0 |
| TRAE MCP | 9 | 0 |
| Unified MCP | 2 | 0 |
| Total | 191 | 0 |

The original audit baseline was 169 total tests. The repair adds 22 regression tests. The npm script rebuilds all three MCP packages before their tests. Full local output: `.local/runtime-repair-tests-20260906.log`.

Additional checks passed:

- Skill `quick_validate.py` for `plugins/uagents/skills/agent-dispatch`.
- Plugin `validate_plugin.py` for `plugins/uagents`.
- `git diff --check`.

## Regression evidence

- Resource release during a wait completes the original task once; timeout leaves an unsent recoverable attempt; queued cancellation performs no send.
- Two independent Node processes contend for one UUID in one SQLite store. Their combined send count is one; `dispatch.possibly_sent` and `dispatch.accepted` each occur once; the attempt is unchanged and no lease remains.
- Fresh CLI subprocesses execute `reconcile` and `resume` with isolated host state and reach the original-instance identity check without launching an Agent.
- Actual `DoubaoDesktopBridge` construction is exercised against injected CDP transport, ensuring managed-port selection is not hidden by a generic fake bridge.
- Fresh TRAE adapters receive the original gateway port, nonce and an in-memory fixture capability; reconciliation never calls submit. Wrong identity is rejected.
- A failed observation followed by a confirmed same-identity terminal response converges. Weak or foreign evidence is rejected before overwriting the trusted response.
- Advisory/native dispatch tests cover agy, WorkBuddy, OpenCode, Doubao and TRAE, including original prompt and hash preservation.

## Verification limits

Tests use fake agents, injected transports and isolated local state. No real Agent prompt, login, account action or deployment was performed. The working-tree fixes are not installed into the user's plugin cache. Existing unrelated working-tree changes were preserved. Live message round trips remain a separate verification step.

This repair does not add new target/model registration, native CLI session reconciliation, enforced read-only isolation or a general interaction-response API. A worker that disappears after a possibly-sent checkpoint is never automatically replayed.
