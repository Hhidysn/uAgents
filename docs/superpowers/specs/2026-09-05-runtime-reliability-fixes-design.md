# Runtime reliability fixes

## Scope and acceptance

Repair the four confirmed audit defects: stranded unsent tasks after resource contention, Doubao observation using the wrong connection, desktop reconciliation losing managed identity, and advisory read-only requests silently becoming native edit requests. The user authorized design and GPT-5.6 Luna Max implementation together. Existing unrelated working-tree edits must be preserved.

Acceptance is behavioral: contention eventually permits one send after resources are released; queued cancellation sends nothing; an interrupted unsent task can resume with the same UUID and attempt; competing workers cannot send twice; possibly-sent tasks never replay. Desktop observation and reconciliation must use the original managed instance and reject missing or changed identity. Advisory read-only must reach every backend and must not enable WorkBuddy automatic edit acceptance.

## Approach

Reuse the existing SQLite transactions, fencing leases, task state machine, Supervisor and adapter interfaces. A patch that only catches lease errors would still strand tasks. Replacing the scheduler with a daemon or adding a queue dependency would introduce unnecessary deployment and migration work. Instead, add bounded contention waiting plus safe explicit recovery of unsent work using the existing control database.

## Scheduling and recovery

Resource acquisition stays before all native work. A worker waits with bounded backoff on resource contention, checking cancellation and current task state. Exhausted waiting remains visibly queued and recoverable. Recovering a registered or queued unsent attempt preserves its UUID, effective request and attempt identity. Dispatch eligibility and ownership are checked atomically so duplicate workers cannot take turns sending the same task. A live owner is not displaced. Once `possibly_sent` is durable, no submit or resume operation may redispatch it.

The public CLI remains nonblocking. Duplicate submissions may recover abandoned unsent work, but do not create a new attempt or change model/provider. The implementation must keep launch failures recoverable without reporting an unobserved native result.

## Managed desktop identity

Doubao observation uses the managed bridge selected for its task. For later reconciliation, read the persisted dispatch lifecycle identity and ask the Supervisor to attach to that exact recorded instance under a host lease. Verify ownership and profile generation; acquire the original gateway connection and token only in memory. This attach operation never launches, replaces, repairs or sends a prompt. Missing identity, a replaced instance or an unavailable Supervisor produces a structured error rather than a default-port fallback.

Task and host leases cover reconciliation and are released on all outcomes. Existing tasks without managed lifecycle metadata retain their explicit legacy adapter behavior. CLI `reconcile` and `resume` construct the same Supervisor as MCP. Native identity remains the lookup key; connection metadata does not replace session validation.

## Advisory permission

Keep the original persisted request and idempotency hashes unchanged. At dispatch preparation, a shared helper adds an explicit read-only instruction only for `advisory-read-only`: inspect and explain, do not modify files or execute mutating commands, and report any work requiring writes. It is a behavioral instruction, not an enforced sandbox. Other permissions preserve the prompt exactly. Preserve the requested permission through the CLI conversion and suppress `acceptEdits` for advisory requests.

## Validation and delivery

Use fake agents, isolated state databases and injected transport endpoints. Cover non-default Doubao ports through the real bridge selection path; fresh-adapter reconciliation with original instance metadata; identity mismatch and unavailable-host errors; lease cleanup; contention, cancellation and same-UUID races; and advisory versus native permissions. Run the repository test script including new regression files, rebuild the distributed MCP bundles and validate plugin packaging.

No live agent messages, authentication changes, installation, release or git commit are part of this repair. Existing environment inheritance, backend/model allowlists, CLI streaming architecture and new interaction/response APIs remain separate work.
