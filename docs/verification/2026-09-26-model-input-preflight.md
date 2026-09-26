# Model input preflight verification

Date: 2026-09-26 to 2026-09-27 (Asia/Shanghai). Scope: `models <target>` and the Codex model-choice instructions.

## Behavior

- Each model row now includes `input_support.files` and `input_support.images` with `allowed`, `verification`, `source`, `observed_on`, and `evidence_ref`. Claude Code also lists accepted native MIME formats.
- `allowed` is recomputed from the current target and route policy on every listing. Native catalog discovery does not upgrade a route to model-level attachment verification, and the catalog remains advisory rather than an allowlist.
- Positive evidence is scoped to the tested native route: Codex Luna has native byte-delivery evidence; Claude Code DeepSeek Flash and WorkBuddy DeepSeek V4.1 Flash have sample model replies. The tested DSH `deepseek-official/deepseek-flash` image Task remains indeterminate; other DSH routes only inherit transport mapping evidence. WorkBuddy's default route has native file/image rejection evidence; other WorkBuddy models are not described as having been tested for generic file input.
- `discovery.observed_at_ms` is the native model-list observation time. `input_support.observed_on` is the date of a separate attachment verification record, or null if none exists. Neither proves present account authentication, quota, or Provider availability.

## Checks

- `node --test tests/model-discovery.test.mjs tests/registry-policy.test.mjs tests/unified-cli.test.mjs`: **62/62 passed**. Cases cover built-in and newly discovered routes, target restrictions, native-model passthrough, WorkBuddy route-specific evidence, and a custom route that reuses a built-in route ID without inheriting that model's positive evidence.
- Local no-prompt CLI: `node plugins/uagents/bin/uagents.mjs models claudeCode`, `models workbuddy`, and `models dsh` returned `ok=true` with the new fields. WorkBuddy help discovery listed the installed CLI's supported labels; Claude Code and DSH remained configured-only. No Task or Provider request was sent.
- The personal Codex plugin was refreshed to `0.2.0-alpha.1+codex.20260926181206`. All 152 plugin files checked from the repository (151 tracked plus the new source module) had matching SHA-256 in the personal source and installed cache. The installed CLI's `models dsh` returned `images.allowed=true`, `verification=indeterminate`, and the evidence date above.
- Real model acceptance was **not** re-tested for this listing-only change. The evidence dates and limits come from the linked historical verification records; a model catalog row does not establish current multimodal execution.
