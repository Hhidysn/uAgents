# Redundant Execution-Timeout Guardian Release Acceptance

Date: 2026-09-07

Release candidate: `0.2.0-alpha.1+codex.20260907011733`

Source commits:

- `c20172d feat: make timeout guardians redundant`
- `553c8cd chore: version redundant guardian release candidate`

## Scope

This acceptance verifies the redundant timeout-guardian follow-up for Windows OpenCode. It does not run a real OpenCode/provider timeout request.

The follow-up replaces the single timeout guardian with two detached slots (`primary` and `secondary`) and an Attempt-scoped fenced timeout claim. Fresh send requires valid durable ready evidence for both spawned guardian PIDs. At the execution deadline, only the current claim holder may persist timeout/process/workspace-guard convergence. If the claimant dies, the surviving guardian may take over after the claim TTL.

## Provider-free test gate

`npm.cmd test` passed:

- Core: `257/257`
- Doubao MCP: `11/11`
- TRAE MCP: `9/9`
- Unified MCP: `2/2`
- Total: `279/279`

The suite includes the destructive Windows fixture that kills one ready guardian and then kills the Worker. The surviving guardian still enforces the original deadline, terminates only the verified owned process tree, leaves prompt count at one, and permits same-Attempt reconcile without spawn/resend.

## Installation

`codex plugin list --json` reports `uagents@personal` installed and enabled at:

`C:\Users\24590\.codex\plugins\cache\personal\uagents\0.2.0-alpha.1+codex.20260907011733`

Marketplace source:

`C:\Users\24590\plugins\uagents`

Previous marketplace source backup:

`C:\Users\24590\plugins\uagents-backup-before-20260907011733`

Older plugin caches were retained.

## Three-way file verification

The repository release set is defined only by `git ls-files -- plugins/uagents`.

- tracked files: `120`
- tracked bytes: `4,142,065`
- marketplace files: `120`
- installed cache files: `120`
- repository ↔ marketplace SHA-256 mismatch: `0`
- repository ↔ cache SHA-256 mismatch: `0`

Both the marketplace source and installed cache pass the plugin validator.

## Fresh-host validation

A new `codex exec --ephemeral --sandbox read-only` process explicitly loaded:

`C:\Users\24590\.codex\plugins\cache\personal\uagents\0.2.0-alpha.1+codex.20260907011733\skills\agent-dispatch\SKILL.md`

It ran only these local uAgents discovery operations from that exact cache:

- `targets`
- `capabilities opencode`
- `models opencode`

The fresh process reported:

- targets: `agy`, `workbuddy`, `opencode`, `doubao`, `trae`
- OpenCode modes: `analysis`, `implementation`
- file input/output: `true / true`
- `execution_timeout=true`
- routes:
  - `commandcode-goat/deepseek/deepseek-v4-flash`
  - `commandcode-goat/z-ai/glm-5.3-flash`

No uAgents `submit`, `probe`, `ensure`, `resume`, `reconcile`, `cancel`, or `stop` operation was used, and no OpenCode/agy/WorkBuddy/Doubao/TRAE provider task was invoked.

## Remaining boundary

This release tolerates one guardian-process failure after both guardians are durably ready. Simultaneous external loss of both guardian processes remains outside the guarantee. Eliminating that final local-process failure class would require a stronger host primitive (for example a persistent host supervisor/service or an OS-native Job-object deadline) and is a separate architecture decision.
