# Claude Code CLI

Use `target=claudeCode`. List routes with `uagents models claudeCode`; the `selector` field is the exact Task `model` value. Built-in selectors are `claude-sonnet-4-6`, `claudeCode/deepseek-v4-pro[1m]`, `claudeCode/deepseek-v4-pro`, and `claudeCode/deepseek-v4-flash`. This installation routes the DeepSeek IDs through Claude Code's user gateway settings. The model listing is configured-only; it does not enumerate account/gateway availability.

Claude Code has no built-in uAgents default. A user config may set `defaults.claudeCode` to one approved selector. Omitting `model` then uses that route; setting a concrete selector overrides it for this Task. CLI `--config <absolute-file>` or process environment `UAGENTS_CONFIG=<absolute-file>` loads the same config. Do not assume Claude Code's own native default is identical to the uAgents route default.

The current adapter supports text + workspace in analysis and implementation. It inherits native Claude Code permissions and never auto-approves. It records native session/model/result evidence, but does not expose cross-Task continuation or fork, or native file/image attachments. A `model_verified=true` result means Claude Code self-reported the requested model ID; it does not independently identify the upstream provider. Do not retry an indeterminate sent Task with a new UUID.
