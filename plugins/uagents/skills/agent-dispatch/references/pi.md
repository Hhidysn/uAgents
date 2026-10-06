# pi (`pi`)

Use `target=pi` with an explicit `provider/model` selector, for example:

```text
model=openai/gpt-5.6-luna
model=antigravity/gemini-3-8-flash
```

uAgents resolves the selector to provider `openai`/`antigravity` and model id `gpt-5.6-luna`/`gemini-3-8-flash`, then runs the installed `@earendil-works/pi-coding-agent` bundle (`dist/bundle/cli.js`) with the current Node host as `--mode json`. Prompt text is written to stdin, never argv. `models pi` reads the native `--list-models` catalog; a concrete ID may still be passed through even when absent from the catalog. There is no built-in default route, so `model=default` fails until a default is configured.

Supported modes are `analysis` and `implementation`. The workspace is the process cwd. Native `@path` arguments map verified file and image inputs; whether a given provider/model accepts them is decided natively, and the `antigravity` bridge was observed crashing on an attached file (`agy exited with status 143`) while `openai/gpt-5.6-luna` delivered the same file and a solid-color image. `execution.effort` maps to `--thinking`.

Completion requires native evidence: the latest assistant `message_end` with `stopReason=stop` or `length`, a normal process exit, an `agent_settled` event, and matching session-guard evidence at completion. A new `agent_start` discards the previous answer. Final `message_end.provider` and `message_end.model` must both match the requested route; missing or mismatched values fail with `native_model_mismatch` and cannot be marked verified.

The driver explicitly loads the bundled session guard alongside the user's extensions. It blocks runtime new/resume/fork/tree changes through Pi's supported extension context APIs; initial CLI continuation/fork remains supported. A blocked change stays `indeterminate/native_session_change_blocked`, while missing guard evidence stays `indeterminate/native_session_guard_unconfirmed`. Reload invalidates old guard evidence. The guard rechecks session ID and cwd at settlement and shutdown; it is a protocol constraint, not a sandbox against arbitrary JavaScript extensions running in the same process. It does not disable the user's permission extensions or approve tools.

pi supports cross-Task continuation and fork:

```json
"session": { "continue_from_task_id": "<previous-task-id>" }
"session": { "fork_from_task_id": "<previous-task-id>" }
```

Continuation passes `--session <session-id>`; fork passes `--fork <session-id>` into a new native session. The follow-up must use a new `request_id`, the same target and workspace, and exactly one selector.

`probe pi --model <selector>` is version-only and sends no prompt. `native_args`, `execution_timeout_ms`, and automatic tool/approval policy are not exposed: pi uses its native project-trust and permission defaults, and uAgents does not inject `--approve` or a tool allowlist.
