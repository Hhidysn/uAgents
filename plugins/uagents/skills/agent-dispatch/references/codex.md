# Codex CLI (`codex`)

Use `target=codex` with an explicit model ID. Built-in routes include `gpt-6-astra` and `gpt-5.6-luna`; Luna's exact native selector was checked with an actual Codex CLI provider request on 2026-09-20. Codex uses its installed npm package JS entry (`@openai/codex/bin/codex.js`) and the user's existing Codex authentication and native configuration. uAgents invokes `codex exec --json --model <model-id> --cd <workspace> -` with the task prompt on stdin. Never pass the prompt in argv.

V1 supports `analysis` and `implementation` text tasks and workspace access; existing uAgents `expected_outputs` capture files after completion. The adapter does not inject Codex sandbox, bypass, automatic approval, login or credential options. Native Codex permissions remain those of the local Codex configuration; `analysis` is not an enforced filesystem restriction.

Native evidence: `thread.started.thread_id` becomes `native_session_id`; final assistant text comes from completed `agent_message`, and successful execution requires `turn.completed`, an exit code of zero and non-empty text. The JSONL output has no trusted model self-report, so `model_reported=null` and `model_verified=false` are expected even when `model_requested`/`model_resolved` match the explicit selector.

JSONL events for this v1 route must describe one thread and one turn. Duplicate turns, changed thread IDs, or assistant messages after completion are not evidence of success. When cancellation, timeout or transport failure occurs, uAgents waits a bounded period for the CLI launcher to close; if it does not, execution stays indeterminate. `launcher_close_confirmed` only describes the spawned npm JS process, **not** independently verified termination of every native descendant or the provider turn. Do not replay an indeterminate task automatically.

`probe codex --model gpt-5.6-luna` (or `gpt-6-astra`) only runs `--version` and returns `scope=version_only`, `submission=not_sent`. `models codex` is configured-only until a reliable native no-prompt catalog is available. V1 does not expose native file/image attachments, cross-Task `resume/fork`, or durable Codex thread reconciliation. `cancel` stops local execution but must not claim that remote generation has been confirmed cancelled. Do not automatically retry a sent/indeterminate task.

## Explicit app-server preview

On Windows, `gpt-6-astra` can opt into a separate app-server stdio transport by including `"codex_transport":"app-server"` in `execution`. The default request remains the exec route. The preview supports a new Task with either `session.continue_from_task_id` or `session.fork_from_task_id`; every source and follow-up Task in the chain must use the same app-server route, workspace, and verified CLI installation. Use a new UUID for each intended Turn. Luna and non-Windows requests with this field fail before sending.

For example, a follow-up request includes:

```json
{
  "target": "codex",
  "model": "gpt-6-astra",
  "execution": { "codex_transport": "app-server" },
  "session": { "continue_from_task_id": "<previous-task-uuid>" }
}
```

The full request also needs `schema_version`, a new `request_id`, `mode`, `prompt`, and an absolute `workspace`; inspect `schema request`. Continuation checks that the source is the latest native Turn. Fork pins the source Turn with `lastTurnId`, so it can branch from an earlier completed Task. The transport persists Thread ID, Turn ID, installation fingerprint, and process evidence. An accepted or possibly sent Turn is never replayed automatically after a crash. Approval requests and uncertain native termination need user inspection; an interrupt RPC reply alone is not proof of cancellation. `model_verified=false` remains expected because a trusted native model self-report is not yet available.

Codex owns its sandbox and approval policy through its native configuration. uAgents does not broker app-server approvals. If the native app-server sends an interactive approval request, the sent Task becomes `indeterminate` with `native_approval_required`; uAgents sends no approval response and never replays that Prompt. Inspect the Task and native Codex configuration before starting a separate Task. `resume` only observes or recovers the existing Task.
