# OpenCode Native Execution Design

Date: 2026-09-06
Status: Design approved; pending written-spec review

## Goal

Turn uAgents into a thin universal dispatcher for CLI-based subagents. uAgents owns task identity, workspace selection, lifecycle, persistence, observation, and optional artifact verification. Execution permissions and native behavior remain owned by the target framework (for example OpenCode or Codex) through target-native CLI arguments.

The immediate target is OpenCode: enable implementation tasks and file inputs/outputs without pretending uAgents provides a sandbox or permission boundary that it does not actually enforce.

## Non-goals

- Do not redesign SQLite task persistence, Task/Attempt/Native Session lifecycle, idempotency, leases/fencing, or managed target lifecycle.
- Do not add a new uAgents sandbox implementation.
- Do not translate every target into one artificial cross-agent permission model.
- Do not make `expected_outputs` mandatory for implementation tasks.
- Do not broadly refactor unrelated reliability work already present in the dirty worktree.

## Architectural Principle

uAgents is a protocol and orchestration layer, not an execution-policy layer.

It should distinguish two classes of arguments:

1. **Dispatcher-owned protocol arguments**: required for uAgents to launch and observe a task correctly. These cannot be overridden by callers.
2. **Target-native execution arguments**: passed to the target framework and interpreted by that framework. uAgents validates only that they do not replace dispatcher-owned protocol arguments.

For OpenCode, dispatcher-owned arguments include the command/subcommand and values required for observation and task routing, such as `run`, `--model`, `--format json`, `--dir`, and the generated task title. Native behavior such as `--pure`, `--auto`, `--agent`, and `--variant` is caller-controlled.

Task intent remains separate from target execution flags:

- `mode: analysis | implementation` describes what uAgents expects the task to do.
- `execution.native_args` controls how the selected subagent framework executes it.

uAgents must not infer `--pure` from `analysis` or `--auto` from `implementation`.

## Request Model

Extend the existing execution object with a native argument list:

```json
{
  "execution": {
    "permission": "native",
    "native_args": ["--auto"]
  }
}
```

### `execution.native_args`

- Optional array of CLI argument strings.
- Preserves order exactly.
- Passed only to targets that use a CLI transport.
- May contain target-specific flags and their values.
- Must not contain dispatcher-owned protocol flags that would override uAgents routing, workspace, model selection, structured event output, or generated task identity.

For the first implementation, perform a small denylist check for OpenCode protocol flags rather than trying to understand all possible OpenCode options. Reject conflicting arguments with a clear validation error. Treat both `--flag value` and `--flag=value` forms as conflicts for dispatcher-owned flags.

### Legacy `execution.permission`

Keep the field accepted and persisted for Schema 1.0 compatibility, but remove it from task admission decisions.

During this phase:

- Existing clients do not break.
- The value remains available in stored request metadata.
- uAgents does not claim to enforce it.
- Target-native permission behavior is controlled through `native_args`.

A later schema revision may formally deprecate/remove the field and registry permission matrix.

## Registry Changes

OpenCode becomes a normal implementation-capable target:

```js
modes: ['analysis', 'implementation']
inputs:  { text: true, files: true,  images: false }
outputs: { text: true, files: true,  images: false }
```

The existing OpenCode flags describing uAgents-enforced permission levels (`native`, `advisory_read_only`, `enforced_read_only`, `workspace_write`, `full_access`) should no longer gate OpenCode task admission.

Do not claim that uAgents itself provides `workspace-write` or `full-access` enforcement. Those concepts, when needed, belong to the native target CLI configuration.

## Policy Changes

Keep policy checks that protect protocol correctness:

- request schema validity;
- target exists;
- requested task mode is supported by the target;
- input/output media capabilities are supported by the target;
- paths are safe relative paths where required;
- native arguments do not replace dispatcher-owned protocol arguments.

Remove permission capability checks from the admission path. In particular, `requirePermission(...)` must no longer reject a task because a registry descriptor does not advertise a uAgents-level permission mode.

## OpenCode Driver

OpenCode-specific command construction and JSON event parsing should move out of the shared process transport into a dedicated target driver.

Suggested structure:

```text
src/transports/
  cli-process.mjs        # generic spawn/stdin/timeout/process lifecycle
  opencode-driver.mjs    # OpenCode argv construction + event parsing
  workbuddy-driver.mjs   # WorkBuddy-specific behavior (may be split now or later)
```

The generic process layer should know how to:

- spawn a command;
- stream prompt text to stdin;
- collect stdout/stderr;
- enforce runtime timeout/cancellation;
- forward structured native events to the selected driver;
- return process exit state.

The OpenCode driver should know how to:

- build OpenCode arguments;
- append file inputs;
- append caller-provided `native_args`;
- parse OpenCode JSON events;
- extract native session identity;
- identify final response text and terminal status;
- surface tool/permission errors when OpenCode emits them.

## OpenCode Command Construction

Base invocation:

```text
opencode run
  --model <route-id>
  --format json
  --dir <workspace>
  --title <generated-task-title>
  [--file <absolute-input-path>]...
  [execution.native_args...]
```

The prompt continues to be written over stdin.

### Remove hard-coded `--pure`

`--pure` must not be included by default. A caller who wants it can request:

```json
{"execution":{"native_args":["--pure"]}}
```

### `--auto`

uAgents does not add or remove `--auto` by policy. If the caller includes it, OpenCode receives it. If omitted, OpenCode uses its own normal permission behavior.

## File Inputs

The runtime already snapshots and verifies declared input files before dispatch. Reuse that pipeline.

For each file input, resolve the verified workspace-relative input to an absolute path and append:

```text
--file <absolute-path>
```

Do not create a second file upload/copy subsystem in the OpenCode adapter.

## File Outputs and Implementation Success

Implementation tasks do not require `expected_outputs`.

When `expected_outputs` is empty:

- OpenCode native success is sufficient for the uAgents task to succeed.

When `expected_outputs` is provided:

- run the existing artifact capture pipeline;
- verify requested files remain inside the canonical workspace;
- capture immutable artifacts and SHA-256 metadata;
- fail the objective verdict if declared outputs are missing or invalid.

This keeps artifact verification as an optional stronger contract rather than a mandatory execution condition.

## Event Parsing and Observability

The existing OpenCode parser already recognizes JSON events including text, steps, tool use, and errors. Preserve compatibility, but make the target driver expose richer structured observations when present:

- session ID;
- final response text;
- tool name and state;
- permission request/denial signals;
- tool errors;
- touched paths if OpenCode provides them in stable event fields.

Do not require touched-path reporting for task success in this phase because OpenCode event stability for that data is not yet a protocol guarantee.

## Error Handling

Use fail-fast validation for arguments that would break uAgents protocol ownership. Examples include caller attempts to provide a competing OpenCode `--format`, `--dir`, `--model`, or task title flag through `native_args`.

Native execution errors remain native target failures. uAgents should record stderr/event details and map them to the existing attempt/task failure state without reinterpreting them as uAgents permission policy violations.

## Compatibility

The first version should minimize migration cost:

- Keep Schema 1.0 request compatibility.
- Add `native_args` as optional.
- Keep accepting `execution.permission` but stop enforcing it.
- Keep current task persistence and result shapes unless a small additive observation field is required.
- Preserve behavior for non-OpenCode targets except where shared permission admission logic must be relaxed.

If removing a shared permission check changes another target unexpectedly, keep admission behavior stable for that target through target-specific capability checks unrelated to permission semantics. Do not preserve the old permission matrix as a hidden security gate.

## Testing Strategy

Add or update tests for:

1. OpenCode `implementation` is accepted by policy and reaches the adapter.
2. OpenCode file inputs are accepted and converted to repeated `--file` arguments.
3. OpenCode declared file outputs use the existing artifact capture path.
4. OpenCode implementation succeeds without `expected_outputs` when the native run succeeds.
5. `--pure` is absent by default and is present only when requested in `native_args`.
6. `--auto` is passed through unchanged when requested.
7. Conflicting protocol arguments in `native_args` are rejected.
8. The legacy `execution.permission` field no longer blocks OpenCode dispatch.
9. Existing analysis tasks continue to work.
10. Existing WorkBuddy/agy/TRAE/Doubao regressions remain green.

Use injected/fake drivers for deterministic unit tests. Add a focused live OpenCode smoke test only if credentials/quota are available and the invocation is explicitly intended for live verification.

## Implementation Sequence

1. Extend schema parsing/validation with optional `execution.native_args`.
2. Stop enforcing the registry permission matrix during request admission while preserving compatibility metadata.
3. Update OpenCode registry capabilities for implementation and files.
4. Extract OpenCode command/event logic into `opencode-driver.mjs` with a small generic driver interface.
5. Remove hard-coded `--pure` and append validated `native_args`.
6. Map declared file inputs to OpenCode `--file` arguments.
7. Update OpenCode adapter/runtime tests for implementation and optional artifacts.
8. Run focused tests, then the broader uAgents test suite.
9. Perform one final diff review to ensure unrelated dirty-worktree changes were not rewritten.

## Acceptance Criteria

The work is complete when all of the following are true:

- An OpenCode task with `mode: implementation` passes policy admission and is dispatched.
- OpenCode can receive workspace file inputs through its native CLI.
- `--pure` and `--auto` are caller-controlled rather than hard-coded by uAgents.
- uAgents no longer rejects tasks based on its previous OpenCode permission matrix.
- `expected_outputs` remains optional, and when present, existing artifact verification still applies.
- Dispatcher-owned OpenCode arguments cannot be overridden through `native_args`.
- Existing target task lifecycle, persistence, leases, idempotency, cancellation, and artifact capture remain intact.
- Relevant automated tests pass without requiring unrelated current worktree changes to be reverted.
