# Runtime reliability repair plan

Design: `docs/superpowers/specs/2026-09-05-runtime-reliability-fixes-design.md`.

1. **Queue recovery — GPT-5.6 Luna Max worker.** Repair resource contention and cancellation, guard attempt ownership, recover unsent attempts, and test duplicate-worker races. Own worker/task-service/leases and related runtime tests.
2. **Managed connection — GPT-5.6 Luna Max worker.** Keep Doubao observation on the selected bridge; implement exact-instance Supervisor attach for reconciliation; propagate managed context and hold leases; add transport and host regression tests. Own desktop adapters/Supervisor/reconcile and the runtime reconcile method.
3. **Advisory permissions — GPT-5.6 Luna Max worker.** Add shared advisory prompt rendering, preserve permission during CLI conversion, suppress implicit edit acceptance and test native/advisory differences. Own advisory helper/CLI adapter/CLI transport and their tests.
4. **Integration — primary agent.** Wire launch/recovery APIs and CLI/MCP entrypoints, include all regression tests in package scripts, update protocol documentation, review shared boundaries and run complete validation.
5. **Delivery — primary agent.** Rebuild bundles, run plugin validation and report exact verification counts and limits. Preserve pre-existing changes; do not publish or install this working tree.

Workers share the workspace and must preserve each other's edits. Test code uses temporary isolated state and fake transports, never live Agent submissions. No new model routes or credentials are needed for this work.
