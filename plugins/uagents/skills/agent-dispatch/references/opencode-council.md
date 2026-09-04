# OpenCode independent analysis

Use `target=opencode`, `mode=analysis`, and one explicitly approved route returned by `uagents_list_models`. The built-in routes are:

- `commandcode-goat/deepseek/deepseek-v4-flash`
- `commandcode-goat/z-ai/glm-5.3-flash`

The adapter runs a fresh `opencode run --pure --model <route> --format json` session, sends the prompt over stdin, and never adds `--auto`, `--continue`, or provider fallback. `--pure` disables OpenCode plugins; it is not an enforced read-only sandbox. Implementation and file inputs are rejected before launch.

The JSON event stream identifies the native session and final message parts but does not independently report the actual model. Therefore successful calls normally keep `model_reported=null` and `model_verified=false`; the selected route remains visible in `model_requested`, `provider`, and `route_id` without being misrepresented as runtime verification.

Provider error events are reduced to a redacted structured failure. Authentication rejection is reported as `authentication_required` with the HTTP status and native error class only; response headers, response bodies, and credential material are discarded. The version-only probe does not authenticate with the provider, so a successful probe does not establish that a live model call will succeed.

For a council, record the primary proposal first, give independent candidates the same bounded brief, use a distinct UUID per intentionally separate candidate, and synthesize by evidence rather than vote. A failed or rate-limited route is not automatically replaced.
