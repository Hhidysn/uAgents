# Unified request and result protocol

## Request

`uagents_submit` takes the request fields directly. The CLI equivalent is:

```powershell
node "<plugin-root>/bin/uagents.mjs" submit --request "<request-json>" --state-dir "<absolute-state-dir>"
```

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

- `uagents_status({task_id})`: SQLite-only status read.
- `uagents_result({task_id})`: status plus persisted response, usage, and artifact capture records.
- `uagents_cancel({task_id})`: records cancellation intent.
- `uagents_list_tasks({cursor, limit})`: cursor pagination, maximum 200.
- `uagents_reconcile({task_id})`: explicitly queries the stored native identity; never sends the prompt again.

CLI equivalents use `status <task-id>`, `result <task-id>`, `cancel <task-id>`, `list`, and `reconcile <task-id>` with the same `--state-dir`.

## Interpretation

- `submission=not_sent`: no external send boundary was crossed.
- `submission=may_have_been_sent`: the durable pre-send checkpoint exists, but native acceptance is unconfirmed.
- `submission=sent`: a stable native handle was accepted and stored.
- `indeterminate`: the remote outcome is unknown. Only stronger evidence for the same native identity may refine it.
- `waiting_user`: native approval or interaction is required; do not approve automatically.

`model_requested` is the caller's value; `model_resolved` is the route selected by policy; `model_reported` is only what the native runtime actually emitted; `model_verified` is true only when available evidence matches the resolved identity. This is per-call evidence, not a provider-wide availability scan.
