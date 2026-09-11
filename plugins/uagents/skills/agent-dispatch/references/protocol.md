# Unified request and result protocol

## Request

Local Codex should normally use the CLI. `uagents_submit` is the MCP fallback and takes the same request fields directly. CLI file input is:

For machine-readable discovery, use `node "<plugin-root>/bin/uagents.mjs" describe submit` / `describe council-submit` for CLI contracts and `schema request` / `schema council` for the current Task and Council JSON Schemas. This document explains semantics and examples; the Core parsers remain authoritative.

```powershell
node "<plugin-root>/bin/uagents.mjs" submit --request "<request-json>" --state-dir "<absolute-state-dir>"
```

Callers that can write stdin separately from the process command may use:

```powershell
node "<plugin-root>/bin/uagents.mjs" submit --request-stdin --state-dir "<absolute-state-dir>"
```

Exactly one of `--request FILE` and `--request-stdin` is required. Do not inline the JSON or prompt in a shell command. The stdin request is capped at 1 MiB and is still validated by Schema 1.0.

## Council

For independent multi-Agent work, Council is a thin fan-out/fan-in layer over ordinary Tasks:

```json
{
  "schema_version": "1.0",
  "council_id": "<uuid>",
  "strategy": "fanout",
  "prompt": "Review this bounded change.",
  "workspace": "F:\\project",
  "members": [
    { "member_id": "architecture", "target": "workbuddy", "model": "default", "instruction": "Focus on architecture." },
    { "member_id": "implementation", "target": "opencode", "model": "commandcode-goat/deepseek/deepseek-v4-flash", "instruction": "Focus on feasibility." }
  ]
}
```

Use CLI `council-submit`, `council-status`, `council-result`, `council-diff`, `council-adopt`, or MCP `uagents_council_submit`, `uagents_council_status`, `uagents_council_result`, `uagents_council_diff`, `uagents_council_adopt`. The compatibility default is `mode:"analysis"` + `workspace_strategy:"shared"`, with `advisory-read-only` permission. `mode:"implementation"` requires `workspace_strategy:"git-worktree"` and an explicit Git workspace; implementation defaults to native permission. uAgents creates one persistent branch/worktree per member from the source committed HEAD. Dirty tracked changes and untracked source files are not copied automatically; pass extra material through attachment `source` or commit it first. A member may carry the existing `session` selector, but normal same-target/same-workspace session rules still apply. `council_id + member_id` deterministically derives the member Task UUID, so exact resubmission reuses the same Tasks/worktrees without reset. `council-result` returns each member's normal Task result plus basic worktree evidence. For git-worktree Council, `council-diff` is local-only and adds tracked file status/unified patch plus untracked file metadata and small UTF-8 file contents. Once a succeeded member is explicitly chosen, `council-adopt` applies its full binary tracked patch and Git-visible untracked regular files to an explicitly supplied destination workspace whose HEAD equals the Council base HEAD; destination branch/HEAD are not changed and no commit/merge is performed. Shared Council is unsupported for both diff and adopt. None of these paths votes, selects a winner, deletes worktrees, or adds a synthesis model call.

```json
{
  "schema_version": "1.0",
  "request_id": "9de3b16c-f16f-44a0-8c5a-a436a35d6d4f",
  "target": "workbuddy",
  "model": "default",
  "mode": "implementation",
  "prompt": "Complete the bounded task and produce the declared output.",
  "workspace": "F:\\absolute\\project",
  "inputs": [
    { "type": "file", "path": "requirements.md" },
    { "type": "image", "source": "F:\\Downloads\\screenshot.png" }
  ],
  "expected_outputs": [{ "type": "file", "path": "result.md", "required": true, "max_bytes": 10485760 }],
  "execution": {
    "observation_timeout_ms": 120000,
    "execution_timeout_ms": null,
    "effort": "medium",
    "permission": "native",
    "native_args": []
  },
  "policy": { "fallback": "none", "max_cost_usd": null }
}
```

Unknown fields and unsupported capability combinations are rejected before registration. Each attachment input contains exactly one of `path` or `source`. `path` is the existing workspace-relative form, uses `/`, and may not escape `workspace`. `source` is an absolute local path for callers that already have the attachment materialized outside the workspace. This includes Unified MCP callers whose host/connector layer has materialized a chat attachment to a local path. On submit, uAgents copies a source attachment into `.uagents/inputs/` under the declared workspace using a content-addressed filename, then stores and dispatches only the normalized `{type,path}` form. Existing `{type:"file",path}` and `{type:"image",path}` requests remain valid without changes. `source` is ingestion convenience only; target adapters never receive or interpret it directly, and uAgents does not resolve opaque connector file IDs by itself.

Generic files are capped at 32 MiB. Image inputs use the same attachment contract with `type:"image"`; the current image whitelist is PNG, JPEG, GIF and WebP, verified from file headers rather than filename, with a 20 MiB limit, maximum width/height of 16,384 px, and maximum canvas area of 64 Mi pixels. If `inputs` are declared, `workspace` is required and their normalized identity is snapshotted before dispatch. Snapshots record attachment kind, path, media type, byte size and SHA-256; image snapshots also record verified width/height. Attachment bytes are not stored in SQLite. If no workspace is supplied and there are no attachment inputs, uAgents creates one under the task directory.

WorkBuddy and OpenCode support explicit continuation and fork contracts:

```json
"session": { "continue_from_task_id": "<previous-uagents-task-uuid>" }
```

or:

```json
"session": { "fork_from_task_id": "<previous-uagents-task-uuid>" }
```

Exactly one selector may be present. Both forms use a **new** `request_id` and identify a finished previous Task whose persisted native session supplies context. The source Task must use the same target and workspace and must have a persisted native `session_id`. Continuation keeps the same native session; fork requires the target to return a new native session identity. uAgents does not copy old responses into the prompt. WorkBuddy maps continuation to `--resume <session-id>` and fork to `--resume <session-id> --fork-session`; OpenCode maps continuation to `run --session <session-id>` and fork to `run --session <session-id> --fork`. `status` / `result` expose the requested session selector. CLI/MCP `resume` is different: it recovers or observes the same existing Task/Attempt and never sends a new prompt. Targets expose continuation and fork separately as top-level `resume` and `fork` capabilities.

`fallback` must remain `none`. Non-null `max_cost_usd` and unsupported execution timeouts are rejected rather than estimated. On Windows OpenCode, a non-null `execution_timeout_ms` is supported by the durable process path; other targets/platforms still reject it. `analysis` is task intent, not a hard read-only sandbox. `execution.permission` remains accepted and persisted for Schema 1.0 compatibility but is not a uAgents admission gate; target-native permission behavior belongs in `execution.native_args`.

`execution.native_args` is an optional ordered list of target CLI arguments. This release exposes it for OpenCode only; other targets reject a non-empty list until they have their own protocol-argument mapping. For OpenCode, uAgents appends declared verified file and image inputs as `--file <absolute-path>` and rejects native args that try to replace the dispatcher-owned `run`, `--model`, `--format`, `--dir`, or `--title` arguments. When structured continuation or fork is requested, caller-supplied `--session`, `--continue`, or `--fork` selection conflicts with dispatcher-owned session selection. Other non-conflicting OpenCode options, including `--pure`, `--auto`, `--agent`, and `--variant`, pass through unchanged. `expected_outputs` is optional; when declared, the shared artifact capture pipeline verifies and records the files.

Input capability is intentionally about **native attachment mapping**, not mere filesystem visibility. `inputs.workspace_readable` reports whether a target can access the task workspace through its normal tools. `inputs.files` / `inputs.images` are true only when uAgents has an explicit target-specific attachment mapping. Current agy 1.1.27 exposes no verified native attachment flag/message field, so its file/image attachment flags remain false even though its workspace is readable. WorkBuddy's installed `codebuddy.js` stream-json parser is locally verifiable: uAgents now sends file inputs as native base64 `document` blocks (which WorkBuddy converts to `input_file`) and image inputs as native base64 `image` blocks. OpenCode maps both kinds through its native repeated `--file` arguments. uAgents does not fall back to putting unsupported attachment paths into prompt text.

`advisory-read-only` adds an explicit instruction to inspect and explain without changing files or running mutating commands. WorkBuddy does not receive automatic edit acceptance for this permission, even in implementation mode. This is a prompt-level instruction, not an enforced sandbox; native permissions still apply. The stored request and its idempotency hashes retain the caller's original prompt.

## Queries

- `status <task-id>`: SQLite-only status read.
- `result <task-id>`: status plus persisted response, usage, and artifact capture records.
- `cancel <task-id>`: records cancellation intent.
- `list [--cursor <cursor>] [--limit <n>]`: cursor pagination, maximum 200.
- `reconcile <task-id>`: explicitly queries the stored native identity; never sends the prompt again.
- `ensure <target> [--refresh]`: discover, verify and cache the installation; start or reuse the managed instance for desktop targets. Never sends a prompt. `--refresh` forces rediscovery instead of the cached path.
- `resume <task-id>`: recovers a `registered/queued` task only when it is unsent, has no native identity/process and has no live worker lease; also resumes first-login waits on the same attempt. If a nonterminal task already has a durable native process (currently Windows OpenCode), `resume` routes to same-Attempt reconcile for `starting`/`running`/`waiting_user`/`indeterminate` instead of dispatch. It never sends the original prompt again or creates another native process. A non-durable `waiting_user` task with a native identity is reconciled as before.
- `stop <target>`: stops only the ownership-proven managed instance (pid + start time + canonical path). User windows and unknown processes are never touched.

MCP equivalents are `uagents_status`, `uagents_result`, `uagents_cancel`, `uagents_list_tasks`, `uagents_reconcile`, `uagents_ensure`, `uagents_resume`, and `uagents_stop`. Keep the same explicit `--state-dir` on every CLI command when using a non-default state root. Managed-lifecycle state lives separately in `%LOCALAPPDATA%\uAgents\host-v1` and is shared by every entrypoint regardless of `--state-dir`.

## Managed lifecycle

`submit` auto-prepares the target: the Worker resolves a trusted installation through the per-user host control plane and, for desktop targets, starts or reuses a dedicated isolated-profile instance before any adapter runs. Two different state dirs can never control the same desktop instance because both must hold the same Host lease. A fresh desktop profile that surfaces a login or setup screen parks the task in `waiting_user` with `interaction.phase=preflight_login` and `submission=not_sent`; after the user logs in once, the same UUID `submit` or `resume` requeues the same attempt. Status and result responses expose a `lifecycle` summary (`state`, `instance_id`, `installation_id`, `profile_generation`, `started_by_uagents`, `reused`) for managed targets.

Resource contention keeps the worker queued with a task lease and bounded backoff (up to 30 seconds by default). If the wait expires, the task remains queued with a retryable error; resubmit the identical request with the same UUID or use `resume` after resources become available. Duplicate submission of a newly registered task is read-only; if its worker failed to start, use `resume`. A live worker is not displaced, and a possibly-sent attempt is never redispatched. Queued workers observe cancellation before sending.

Managed desktop reconciliation uses the original instance and profile generation saved at acceptance. The Supervisor verifies that exact instance and supplies the original connection to the adapter; it never starts, repairs or replaces an instance during reconciliation. An unavailable or changed instance produces a structured error without falling back to the default port. Gateway capabilities remain in memory and are not written to task records.

Windows OpenCode reconciliation is process/transcript observation, not a new session turn. It reuses the persisted Attempt, process identity, transcript and accepted session evidence; it does not automatically call `opencode run --session`, `opencode run --continue`, `opencode run --fork`, or resend the stored prompt. A caller that intentionally wants a new message creates a new Task with either `session.continue_from_task_id` or `session.fork_from_task_id`. Platforms without an equivalent process ownership inspector retain the legacy uninterrupted OpenCode transport for now.

For durable OpenCode, `observation_timeout_ms` bounds how long the current observer waits; expiry does not kill the native process. `cancel` likewise records cancellation intent and stops current observation without claiming provider/native cancellation. A still-running or uncertain process remains workspace-guarded.

On Windows OpenCode only, `execution_timeout_ms` is an independently enforced native execution deadline. Current source starts two detached per-Attempt timeout guardians (`primary` and `secondary`) and requires PID-bound durable ready evidence from both before the send checkpoint. The deadline starts at the persisted `dispatch.possibly_sent` timestamp. At expiry the guardians serialize through a short-lived fenced Attempt claim; the claimant verifies the persisted PID + process start time + executable, invokes the owned Windows process-tree termination path, and releases the workspace guard only after root death and descendant quiescence are proved. If a claimant guardian dies, the surviving guardian can take over after claim expiry without replaying the prompt. Confirmed local deadline enforcement is reported conservatively as `indeterminate` with `execution_timeout`; it is not provider/native cancellation acknowledgement. If termination cannot be proved, the error is `execution_timeout_termination_unconfirmed` and the workspace remains guarded. Failure to establish both guardians before send is `execution_timeout_guardian_unavailable` with `submission=not_sent`.

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
