# agy / Gemini

Use `target=agy` with an explicit native model ID. Supported modes are `analysis` and `implementation`. The current verified agy 1.2.5 CLI exposes workspace access through `--add-dir`, but no native file/image attachment flag or other attachment mapping verified by uAgents. Accordingly `inputs.files=false` and `inputs.images=false`; `inputs.workspace_readable=true` describes the separate fact that the agent can read workspace files with its normal tools.

`uagents models agy` runs the native no-prompt `agy models` catalog and caches the validated snapshot in the per-user HostStore for 10 minutes. `uagents models agy --refresh` bypasses that catalog cache. `gemini-3.8-flash-medium` is a verified configured route; other discovered model IDs can be selected directly for text + workspace Tasks.

agy performs a pre-send native handshake and verifies the reported model, cwd, and conversation ID. `model_verified=true` requires the runtime-reported model to equal `model_resolved`. Implementation enables the native accept-edits mode; analysis inherits native permissions and is not enforced read-only. The adapter keeps `--sandbox` and never adds a skip-all-permissions flag.

The CLI must already be installed and authenticated. Probe checks only the preflight handshake and does not submit a user message. A model or cwd mismatch, permission request, malformed stream, timeout, or lost final identity is not silently retried.

Declare every required output in `expected_outputs` and provide the intended project as `workspace` when the Agent should edit it. uAgents snapshots declared inputs, serializes overlapping write-capable workspaces, captures outputs after completion, and verifies captured copies; this is acceptance evidence, not a security sandbox against a same-user process.
