# OpenCode Native Execution Implementation Plan

Date: 2026-09-06
Design: `docs/superpowers/specs/2026-09-06-opencode-native-execution-design.md`
Status: Implementation and verification complete in the working tree; installed and verified in a fresh Codex CLI process; one authorized DPF standard-submit provider E2E passed; not released

## Objective

Implement the approved thin-dispatcher design for OpenCode without disturbing unrelated reliability work already present in the dirty worktree.

## Constraints

- Treat the current dirty worktree as authoritative; do not reset, checkout, revert, or overwrite unrelated edits.
- Keep uAgents responsible for task protocol, lifecycle, persistence, workspace selection, observation, and optional artifact verification.
- Move target execution policy to target-native CLI flags. Do not recreate a cross-target permission sandbox in uAgents.
- `execution.native_args` is caller-controlled except for conflicts with dispatcher-owned protocol flags.
- Preserve existing behavior for non-OpenCode targets unless a shared permission admission check must be relaxed.
- Do not make `expected_outputs` mandatory for implementation tasks.

## Work Items

1. **Schema**
   - Add optional `execution.native_args: string[]` with reasonable count/string-size validation.
   - Keep `execution.permission` accepted and persisted for compatibility.

2. **Policy**
   - Remove uAgents permission-capability rejection from request admission.
   - Keep target/mode/media/path/capability validation.
   - Add validation that native args cannot override dispatcher-owned OpenCode flags (`--model`, `--format`, `--dir`, `--title`, and subcommand ownership as applicable), including `--flag=value` forms.

3. **Registry**
   - Mark OpenCode as supporting `analysis` and `implementation`.
   - Enable file inputs and file outputs for OpenCode.
   - Stop using the OpenCode permission matrix as an admission gate; preserve legacy descriptor fields only if removing them would cause needless compatibility churn.

4. **OpenCode driver**
   - Extract OpenCode argv construction and JSON event parsing from the generic CLI process transport into a focused driver module.
   - Base argv: `run --model <route> --format json --dir <workspace> --title <task>`.
   - Remove default `--pure`.
   - Append each verified file input as `--file <absolute-path>`.
   - Append validated `execution.native_args` in caller order.
   - Preserve/sessionize current event parsing and expose existing response/error/session information.

5. **Generic CLI transport**
   - Keep spawn/stdin/cancellation/timeout/process lifecycle generic.
   - Delegate OpenCode-specific argv/event behavior to the driver without broadly rewriting other targets.

6. **Adapter/runtime integration**
   - Ensure the legacy request passed to the CLI layer includes `native_args` and file inputs needed for OpenCode construction.
   - Do not require expected outputs for implementation success.
   - Reuse the current artifact capture pipeline when expected outputs are declared.

7. **Tests**
   - Replace the current test that expects OpenCode implementation rejection.
   - Cover implementation admission/dispatch, no-default-`--pure`, pass-through `--pure`/`--auto`, repeated `--file`, conflicting protocol arg rejection, legacy permission non-blocking behavior, optional expected outputs, and existing analysis behavior.
   - Keep current WorkBuddy/agy/TRAE/Doubao tests green.

8. **Verification**
   - Run focused OpenCode/unified adapter tests first.
   - Run the broader project test suite if focused tests pass.
   - Review `git diff` and `git status` to ensure only intended files were changed by this implementation worker.

## Acceptance Checks

- OpenCode `mode: implementation` reaches its adapter/driver.
- File inputs become native OpenCode `--file` arguments.
- `--pure` is absent unless requested.
- `--auto` and other non-conflicting native args pass through unchanged.
- Legacy uAgents permission metadata no longer blocks dispatch.
- Dispatcher-owned flags cannot be overridden by `native_args`.
- Existing artifact verification remains optional and functional.
- Relevant tests pass without reverting unrelated dirty-worktree edits.
