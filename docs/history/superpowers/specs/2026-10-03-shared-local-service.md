# Shared local service implementation design

Baseline: `892da2c`. The service runs under one logged-in OS user and serves callers
in that user's trust domain. Agent callers use MCP; execution targets retain the
existing native adapters and permission settings.

## Boundaries

- Keep request schema 1.0, Task/Attempt identity, envelopes, CLI and stdio behavior.
- Add a loopback-only HTTP MCP service and a stdio bridge. Use the installed MCP
  SDK's `createMcpHandler`, including stateless legacy compatibility.
- Store a generated Bearer credential in a local file, never argv or native child
  environment. Authenticate and validate Host/Origin before protocol handling.
- Require explicit workspace roots and allowed targets. Authorize submitted paths,
  attachments, session parents and persisted Task/Council IDs before operations.
  These controls govern the dispatcher API; they are not a native execution sandbox.
- Invoke existing tool handlers in bounded child processes. The HTTP process does
  not execute synchronous Git, model discovery, attachment loading or SQLite work.
- Run queue recovery in another child. Reuse Core leases, fencing and
  `recoverUnsent`; only registered/queued, not-sent tasks without live ownership
  or native evidence may be dispatched on the original Attempt. Never replay
  sent/ambiguous tasks, auto-approve interaction or invent recovery evidence.
- Preserve native leaf-task instructions. Do not introduce nested delegation or
  expose service credentials to executed agents.

## Delivery

1. Async no-prompt version/catalog runner; parser-only OpenCode reconciliation.
2. Service configuration/init, authorization, isolated tool execution, scheduler.
3. HTTP MCP and stdio bridge; generic caller setup and user-session startup docs.
4. Deterministic tests plus local subprocess/HTTP lifecycle verification.

## Acceptance

- CLI, stdio and HTTP share the same Task/Attempt for the same effective UUID.
- HTTP/bridge disconnect does not cancel accepted tasks.
- Service restart and contention recover safe queued tasks without a new UUID.
- Live leases, native identity/process and possibly-sent markers prevent replay.
- Invalid credentials, origins, targets and paths are rejected before file reads.
- Slow tools do not block health; credentials do not enter native child inputs/env.
- Modern MCP and legacy initialize/list/call work; bridge accepts JSON or SSE.
- Tests use fixtures without paid Provider calls. Actual WorkBuddy sandbox and
  application-exit behavior must be reported separately from these tests.

## Review context

Astra reviewed the shared-runtime architecture, Luna supplied an independent
proposal, and Sol performed adversarial read-only review. Final Sol review
confirmed the original bridge ambiguity and Council diff/adopt scope issues
were resolved. This is historical implementation context; executed checks and
remaining verification limits are recorded in [service verification](../../../verification/2026-10-03-shared-local-service.md).
