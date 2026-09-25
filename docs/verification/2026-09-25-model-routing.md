# Model discovery, defaults, and per-Task selection — 2026-09-25

Verified source working tree in `F:\documents\software\uAgents` (uncommitted). This record covers the model-routing changes after the Claude Code CLI integration.

## Deterministic checks

- `node --test tests/registry-policy.test.mjs tests/model-discovery.test.mjs tests/protocol.test.mjs tests/unified-cli.test.mjs tests/council.test.mjs tests/claude-code.test.mjs tests/cli-transports.test.mjs`: 102 passed, 0 failed. Includes adapter-to-native `--model` forwarding for WorkBuddy.
- `npm --prefix plugins/uagents/mcp/unified test`: bundle built; 14 passed, 0 failed. CLI and MCP request schema alignment checked.

## Real CLI check

A temporary local config set `defaults.claudeCode` to `claudeCode/deepseek-v4-pro[1m]`. `uagents config validate --config <file>` succeeded. `uagents models claudeCode --config <file>` showed that selector with `default=true`; discovery remained `configured_only`, with Provider availability unconfirmed.

Submitted one analysis Task through the source CLI with no `model` field, using the same config. Task ID: `1fbc6b75-f5f4-43d7-8314-b7c9443b68b3`. `submit` registered it with `model_requested=default`, `model_resolved=deepseek-v4-pro[1m]`, and `route_id=claudeCode/deepseek-v4-pro[1m]`. `status` showed `starting` with `submission=may_have_been_sent`. `result` showed `succeeded`, response `UAGENTS_DEFAULT_MODEL_OK`, native `model_reported=deepseek-v4-pro[1m]`, and `model_verified=true` (CLI runtime self-report). The native session ID was persisted.

The live Task ran before the final config-validation hardening edit; the complete targeted tests above ran against the final working tree.

The local test fixture is under `.local/model-routing-live/` and is ignored by Git. No provider credential was copied into the fixture.

## WorkBuddy and TRAE listing on this host

`uagents models workbuddy --refresh` read 16 labels from the installed CLI help: `auto`, `deepseek-v4.1-flash`, `hy4-preview`, `hy3`, `hy3-x`, `glm-5.3`, `glm-5.3-flash`, `glm-5.2`, `glm-5.1`, `glm-5v-turbo`, `minimax-m3`, `kimi-k3-1`, `kimi-k2.8-preview`, `kimi-k2.7`, `kimi-k2.6`, and `deepseek-v4-pro`. The built-in `workbuddy-default` route matched `auto`; it and `deepseek-v4.1-flash` were admitted. The other 14 labels were discovery-only and not admitted.

`uagents models trae` returned only `trae-default`, marked `configured_only` with no native model discovery. Neither listing established Provider login, quota, or live availability.

## Limits

- `models` discovery has a no-prompt native catalog only for agy, WorkBuddy, and OpenCode. Other targets remain configured-only or backend-default. Catalog/help output is not a live authentication, quota, or provider availability check.
- User-configured routes are explicit admission choices. Their text + workspace mapping is allowed, while file/image attachments remain closed until separately verified. No automatic fallback is added.
- A per-Task explicit override was checked through policy and CLI registration tests. This run did not make a second live provider call for an explicit override; earlier [Claude Code verification](2026-09-25-claude-code-cli.md) contains live explicit-model Tasks.
