# Unified request and result protocol

## Request

Local Codex should normally use the CLI. `uagents_submit` is the MCP fallback and takes the same request fields directly. CLI file input is:

```powershell
node "<plugin-root>/bin/uagents.mjs" submit --request "<request-json>" --state-dir "<absolute-state-dir>"
```

Callers that can write stdin separately from the process command may use:

```powershell
node "<plugin-root>/bin/uagents.mjs" submit --request-stdin --state-dir "<absolute-state-dir>"
```

Exactly one of `--request FILE` and `--request-stdin` is required. Do not inline the JSON or prompt in a shell command. The stdin request is capped at 1 MiB and is still validated by Schema 1.0.

```json
{
  "schema_version": "1.0",
  "request_id": "9de3b16c-f16f-44a0-8c5a-a436a35d6d4f",
  "target": "agy",
  "model": "gemini-3.1-pro-low",
  "mode": "implementation",
  "prompt": "Complete the bounded task and produce the declared output.",
  "workspace": "F:\\absolute\\project",
  "inputs": [{ "type": "file", "path": "requirements.md" }],
  "expected_outputs": [{ "type": "file", "path": "result.md", "required": true, "max_bytes": 10485760 }],
  "execution": {
    "observation_timeout_ms": 120000,
    "execution_timeout_ms": null,
    "effort": "medium",
    "permission": "native"
  },
  "policy": { "fallback": "none", "max_cost_usd": null }
}
```

Unknown fields and unsupported capability combinations are rejected before registration. File paths are relative to `workspace`, use `/`, and may not escape it. If `inputs` are declared, `workspace` is required and their identity is snapshotted before dispatch. If no workspace is supplied, uAgents creates one under the task directory.

`fallback` must remain `none`. Non-null `max_cost_usd` and unsupported execution timeouts are rejected rather than estimated. `analysis` is task intent, not a hard read-only sandbox; request `enforced-read-only` only when the target advertises it.

## Queries

- `status <task-id>`: SQLite-only status read.
- `result <task-id>`: status plus persisted response, usage, and artifact capture records.
- `cancel <task-id>`: records cancellation intent.
- `list [--cursor <cursor>] [--limit <n>]`: cursor pagination, maximum 200.
- `reconcile <task-id>`: explicitly queries the stored native identity; never sends the prompt again.
- `ensure <target> [--refresh]`: discover, verify and cache the installation; start or reuse the managed instance for desktop targets. Never sends a prompt. `--refresh` forces rediscovery instead of the cached path.
- `resume <task-id>`: for a task in `waiting_user` with `interaction.phase=preflight_login`, resumes the same attempt after the user completes first login; for a task with a native identity, reconciles it. Everything else is refused with `resume_not_allowed`.
- `stop <target>`: stops only the ownership-proven managed instance (pid + start time + canonical path). User windows and unknown processes are never touched.

MCP equivalents are `uagents_status`, `uagents_result`, `uagents_cancel`, `uagents_list_tasks`, `uagents_reconcile`, `uagents_ensure`, `uagents_resume`, and `uagents_stop`. Keep the same explicit `--state-dir` on every CLI command when using a non-default state root. Managed-lifecycle state lives separately in `%LOCALAPPDATA%\uAgents\host-v1` and is shared by every entrypoint regardless of `--state-dir`.

## Managed lifecycle

`submit` auto-prepares the target: the Worker resolves a trusted installation through the per-user host control plane and, for desktop targets, starts or reuses a dedicated isolated-profile instance before any adapter runs. Two different state dirs can never control the same desktop instance because both must hold the same Host lease. A fresh desktop profile that surfaces a login or setup screen parks the task in `waiting_user` with `interaction.phase=preflight_login` and `submission=not_sent`; after the user logs in once, the same UUID `submit` or `resume` requeues the same attempt. Status and result responses expose a `lifecycle` summary (`state`, `instance_id`, `installation_id`, `profile_generation`, `started_by_uagents`, `reused`) for managed targets.

`status` and `result` always include `error`. It is `null` when the current state has no recorded failure. Native failures use the same structured fields as protocol errors: `code`, `category`, `message`, `retryable`, `schema_version`, `submission`, and `details`. Provider headers, response bodies, credentials, and tokens are never persisted in this record.

The local uAgents CLI and its detached worker inherit the invoking terminal environment, preserving arbitrary provider subscription variables without hard-coding credential names. Environment values are process-local: uAgents does not add them to requests, task files, SQLite rows, events, logs, or results. Codex may restrict the environment of plugin MCP servers to names declared by the plugin host; MCP therefore remains a compatibility entrypoint, not the preferred local path for environment-authenticated native CLIs.

## Interpretation

- `submission=not_sent`: no external send boundary was crossed.
- `submission=may_have_been_sent`: the durable pre-send checkpoint exists, but native acceptance is unconfirmed.
- `submission=sent`: a stable native handle was accepted and stored.
- `indeterminate`: the remote outcome is unknown. Only stronger evidence for the same native identity may refine it.
- `waiting_user`: native approval or interaction is required; do not approve automatically.
- `native.status=accepted` only proves that a stable native identity was observed. Later native evidence updates it to a terminal status when the adapter can determine one.

`model_requested` is the caller's value. `model_resolved` is the concrete normalized model selected by policy and may be `null` for a backend default. `route_id` is the full executable provider/model route. `model_reported` is only what the native runtime actually emitted; `model_verified` is true only when available evidence matches the resolved identity. This is per-call evidence, not a provider-wide availability scan.
