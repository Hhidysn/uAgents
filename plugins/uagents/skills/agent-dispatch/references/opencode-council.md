# OpenCode execution

Use `target=opencode` and one explicitly approved route returned by `uagents_list_models`. Both `analysis` and `implementation` are supported, and declared workspace-relative file inputs are passed to OpenCode as native `--file` arguments. The built-in routes are:

- `commandcode-goat/deepseek/deepseek-v4-flash`
- `commandcode-goat/z-ai/glm-5.3-flash`

The adapter runs a fresh `opencode run --model <route> --format json --dir <workspace> --title <task>` session and sends the prompt over stdin. It does not add `--pure` or `--auto`; pass those and other non-conflicting OpenCode options in `execution.native_args` in the requested order. Dispatcher-owned `run`, `--model`, `--format`, `--dir`, and `--title` arguments cannot be overridden. `--pure` disables OpenCode plugins; it is not an enforced read-only sandbox. Declared `expected_outputs` remain optional and use the shared artifact capture/verification pipeline when present.

On Windows, the current source runs fresh OpenCode tasks through the durable execution controller. uAgents persists a provisional workspace/process guard before spawn, verifies PID + start time + executable before the first prompt byte, writes stdout/stderr to task-local transcript files, and stores the native session as soon as the first valid OpenCode event exposes it. If the observing Worker disappears, `resume`/`reconcile` can recover the same Attempt by reading that persisted process/transcript evidence. Recovery never automatically starts `opencode run --session` or `--continue` and never resends the original prompt; it may remain `indeterminate` when terminal evidence is insufficient.

An alive or uncertain durable OpenCode process keeps overlapping workspaces guarded even after the Worker lease expires. `observation_timeout_ms` and a cancel request stop the current observer but are not proof of native/provider cancellation; uAgents does not kill the durable process merely because observation ended. Platforms without equivalent PID/start-time/executable ownership inspection currently keep the previous uninterrupted OpenCode transport.

Windows OpenCode also supports `execution_timeout_ms` in the current source. A detached per-Attempt timeout guardian must persist a ready handshake before uAgents records `possibly_sent` or writes the first prompt byte. The deadline begins at that durable send checkpoint and survives Worker death. At expiry uAgents terminates only a PID/start-time/executable-matched process tree, then re-inspects the root and descendants; the workspace guard is released only after quiescence is proved. `execution_timeout` means that local owned-tree termination was confirmed, not that the OpenCode provider/session acknowledged cancellation, so the unified task result remains conservative (`indeterminate`) unless stronger native terminal evidence exists. `execution_timeout_termination_unconfirmed` keeps the workspace guarded.

The JSON event stream identifies the native session and final message parts but does not independently report the actual model. Therefore successful calls normally keep `model_reported=null` and `model_verified=false`; the selected route remains visible in `model_requested`, `provider`, and `route_id` without being misrepresented as runtime verification.

Provider error events are reduced to a redacted structured failure. Authentication rejection is reported as `authentication_required` with the HTTP status and native error class only; response headers, response bodies, and credential material are discarded. The version-only probe does not authenticate with the provider, so a successful probe does not establish that a live model call will succeed.

On the preferred local path, the OpenCode process inherits the invoking terminal environment through the detached uAgents worker. Provider-specific subscription variables are not named in plugin code. A plugin MCP server may receive a restricted environment even when direct OpenCode works; use the local uAgents CLI when available instead of treating that MCP-only authentication failure as a Provider outage.

For a council, record the primary proposal first, give independent candidates the same bounded brief, use a distinct UUID per intentionally separate candidate, and synthesize by evidence rather than vote. A failed or rate-limited route is not automatically replaced.
