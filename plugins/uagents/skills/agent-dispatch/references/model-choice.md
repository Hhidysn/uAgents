# Choosing a model in the Codex conversation

Use this before a new Task or Council member is registered. The choice is one Task's `model`; it does not edit the target's configured default. Obtain rows with `models <target>` (or `uagents_list_models`). Use `--refresh` / `refresh=true` when the user requests fresh evidence; the ordinary call may use the existing discovery cache. Model listing must not call `ensure`, submit a prompt, or open a desktop window.

## Conversation

1. If the user supplied a concrete model ID, use that exact selector for this Task. A missing catalog row is not a reason to replace or reject it when the target accepts explicit passthrough. Validate target/mode/attachment policy as usual. If the user said “default”, submit `model:"default"` rather than copying a backend-default row's selector.
2. If the user asked to choose a model, display the admitted `selector` values and identify the `default=true` row. For each displayed group or row, include `discovery.source` and its observation time (`discovery.observed_at_ms`, or `discovery.snapshot_file_mtime_ms` for a local TRAE snapshot). Say “time unavailable” when neither exists. Mark `partial`, `stale`, or `configured_only` evidence plainly. Wait for the user's selector, “default”, or a concrete ID typed outside the list before registering the Task.
3. If the user supplied no model and did not ask to choose, use the configured target default when `default=true` exists. Briefly state the chosen route in the normal progress update and continue. If there is no target default, show the available choices and ask for one; do not guess a default.

The list is evidence, not a whitelist. `admission_allowed=false` rows must not be offered as executable options. A displayed row with `usable=null` or `provider_availability=unconfirmed` is a candidate, not a guarantee of login, quota, or successful execution. Do not infer a model from a UI label, credit balance, or last successful Task. A user-selected concrete ID is a one-time override; changing the lasting default requires a separate explicit configuration request.

Example when the user says “use TRAE, let me choose the model”:

> TRAE default: `trae-default` (uses the current native selection). Other selectors: `GLM-5.3`, … . Source: native picker, observed at 10:20; account/quota availability is unconfirmed. Reply `default`, a listed selector, or another concrete model ID.

Use actual rows and timestamps from this call. Never copy the example's model or time into a real menu. When the user chooses, submit once with a new UUID and the selected `model`, then report the Task's persisted model fields and result evidence.
