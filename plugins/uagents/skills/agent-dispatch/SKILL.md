---
name: agent-dispatch
description: Delegate tracked tasks to agy/Gemini, WorkBuddy, OpenCode, Doubao Work, or TRAE CN through one persistent uAgents protocol. Use for external-agent execution, independent model proposals, capability discovery, or connection checks.
---

# Agent dispatch

Use the unified `uagents_*` MCP tools when available. They and `bin/uagents.mjs` call the same Core and share task state. Codex remains responsible for task decomposition, explicit target/model choice, result evaluation, and final synthesis.

Before submitting, read [references/protocol.md](references/protocol.md) and only the selected target reference:

- [agy / Gemini](references/agy.md): explicit Gemini model, text or file work.
- [WorkBuddy](references/workbuddy.md): backend-default model, text or file work.
- [OpenCode](references/opencode-council.md): explicit approved Command Code route, independent text analysis only.
- [Doubao Work](references/doubao-work.md): backend-default desktop Agent over a prepared loopback CDP connection.
- [TRAE CN](references/trae-cn.md): backend-default Solo Agent over the prepared local gateway.

Do not invent an unsupported target, capability, model, or fallback. Do not automatically install tools, sign in, launch desktop apps, approve native dialogs, buy quota, or replace a failed route. Send only task-relevant text and authorized files; never forward credentials or the entire conversation by default.

## Workflow

1. Inspect `uagents_list_targets`, `uagents_get_capabilities`, and `uagents_list_models` when routing is unclear. Registry presence is not proof that a provider is currently usable.
2. Create one UUID for each intentionally new task and submit the complete versioned request. Reuse the same UUID only for the exact same effective request.
3. Treat `registered`/`queued`/`starting` as local lifecycle states, not proof of native receipt. `submission=may_have_been_sent` or `status=indeterminate` forbids automatic replay or changing UUID to retry.
4. Poll `uagents_status`, which is local and read-only. Use `uagents_result` for response, model evidence, usage, and captured artifacts. Call `uagents_reconcile` only when explicitly checking the stored native identity is appropriate; it may contact the target but never resubmits.
5. For `waiting_user`, report the exact required native action and wait for the user. `uagents_cancel` records cancellation intent; do not call a sent task cancelled unless the result confirms it.
6. Validate outputs against the original acceptance criteria. Native success and a plausible answer do not prove requested files or behavior are correct.

Every status/result includes `model_requested`, `model_resolved`, `model_reported`, and `model_verified`. `model_reported=null` and `model_verified=false` are valid evidence states, especially for backend-default or non-reporting targets; never fill them by inference.

The CLI fallback is `node "<plugin-root>/bin/uagents.mjs" <command>`. Prompt text belongs in a JSON request file or MCP arguments, never in command-line arguments. Runtime state defaults to `%LOCALAPPDATA%\uAgents\v1`; `--state-dir` may select another absolute directory.
