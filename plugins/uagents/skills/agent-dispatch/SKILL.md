---
name: agent-dispatch
description: Delegate tracked tasks to agy/Gemini, WorkBuddy, OpenCode, Doubao Work, or TRAE CN through one persistent uAgents protocol. Use for external-agent execution, independent model proposals, capability discovery, or connection checks.
---

# Agent dispatch

Use the local `bin/uagents.mjs` CLI as the primary entrypoint when Codex has a local shell. This preserves the caller's environment for installed Agent CLIs. Derive `<plugin-root>` from this loaded Skill's location (`skills/agent-dispatch` is two levels below the plugin root); never hard-code a cache version. Use the unified `uagents_*` MCP tools only when a local shell is unavailable or the user explicitly requests MCP. Both entrypoints call the same Core and can share the same state root.

Run CLI commands as `node "<plugin-root>/bin/uagents.mjs" <command>`. JSON is the default output. Omit `--state-dir` to use the normal local state, or keep one explicit absolute state directory unchanged across submit and every later query. For submit, use `--request FILE`; use `--request-stdin` only when the caller can provide stdin separately from the command text. Never place prompt text, credentials, or serialized requests in process arguments.

Before submitting, read [references/protocol.md](references/protocol.md) and only the selected target reference:

- [agy / Gemini](references/agy.md): explicit Gemini model, text or file work.
- [WorkBuddy](references/workbuddy.md): backend-default model, text or file work.
- [OpenCode](references/opencode-council.md): explicit approved Command Code route, independent text analysis only.
- [Doubao Work](references/doubao-work.md): backend-default desktop Agent over a prepared loopback CDP connection.
- [TRAE CN](references/trae-cn.md): backend-default Solo Agent over the prepared local gateway.

Do not invent an unsupported target, capability, model, or fallback. Do not automatically install tools, sign in, approve native dialogs, buy quota, or replace a failed route. Send only task-relevant text and authorized files; never forward credentials or the entire conversation by default. Desktop targets (Doubao Work, TRAE CN) are launched and managed by uAgents itself in dedicated isolated profiles; uAgents never touches the user's own windows.

## Workflow

1. Inspect CLI `targets`, `capabilities <target>`, and `models <target>` when routing is unclear. On the MCP fallback, use `uagents_list_targets`, `uagents_get_capabilities`, and `uagents_list_models`. Registry presence is not proof that a provider is currently usable.
2. Create one UUID for each intentionally new task and submit the complete versioned request. Reuse the same UUID only for the exact same effective request. `submit` auto-prepares the target: it discovers and verifies the local installation and, for desktop targets, starts or reuses the dedicated managed instance. Use `probe` for a read-only check that never starts anything.
3. Treat `registered`/`queued`/`starting` as local lifecycle states, not proof of native receipt. `submission=may_have_been_sent` or `status=indeterminate` forbids automatic replay or changing UUID to retry.
4. A desktop task that stops at `waiting_user` with `interaction.phase=preflight_login` means first login is required in the dedicated window. The user logs in once; then resubmitting the same UUID or calling `resume <task-id>` (MCP `uagents_resume`) resumes the same attempt. Never create a new UUID or attempt for a login wait.
5. Poll CLI `status <task-id>`, which is local and read-only. Use `result <task-id>` for response, model evidence, usage, and captured artifacts. Call `reconcile <task-id>` only when explicitly checking the stored native identity is appropriate; it may contact the target but never resubmits. Use the corresponding `uagents_*` tools only on the MCP fallback.
6. `ensure <target> [--refresh]` (MCP `uagents_ensure`) pre-warms or re-verifies a target without sending anything. `stop <target>` (MCP `uagents_stop`) stops only the ownership-proven managed instance; it refuses user-owned windows and unknown processes.
7. For `waiting_user` after send, report the exact required native action and wait for the user. CLI `cancel <task-id>` or MCP `uagents_cancel` records cancellation intent; do not call a sent task cancelled unless the result confirms it.
8. Validate outputs against the original acceptance criteria. Native success and a plausible answer do not prove requested files or behavior are correct.

Every status/result includes `model_requested`, `model_resolved`, `model_reported`, and `model_verified`. `model_reported=null` and `model_verified=false` are valid evidence states, especially for backend-default or non-reporting targets; never fill them by inference.

The MCP host may expose only explicitly declared environment variables to a plugin server. Do not interpret an MCP authentication failure as proof that the same native CLI is unusable. When local CLI execution is available, keep the request on the CLI path rather than switching entrypoints after registration.
