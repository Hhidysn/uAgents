# Codex CLI transport hardening — 2026-09-20

## Scope

Continue the initial v1 Codex integration without changing its admitted model, native permissions, image/file inputs or session continuation capability. Existing dirty Git state was preserved; no Codex provider prompt was sent, and no plugin cache was republished.

## Changes

- JSONL parser rejects duplicate `turn.started`, post-completion assistant messages, post-completion failures and invalid pre-turn assistant messages. An explicit native `turn.failed` may occur before `turn.started` and still counts as native failure.
- Timeout/cancellation/stream or spawn errors request process termination and wait up to two seconds for `close`; if the JS launcher fails to close, the worker can return an uncertain result instead of hanging indefinitely. The result/event exposes `launcher_close_confirmed`; this is **not** proof that any descendant process or the provider turn was cancelled.
- The first transport error is preserved when later stdin errors arrive during shutdown.
- `tests/fixtures/fake-codex-cli.mjs` runs in a real local Node process. It verifies stdin request delivery, cwd, explicit model args, JSONL native thread, response, usage and version-only probe without reaching any provider.
- Added TaskService integration using the same real local process fixture, besides the existing injected-process unit fixtures.

## Validation

Run from repo root:

```text
node --test --test-concurrency=4 tests/codex-cli.test.mjs tests/agent-locator.test.mjs tests/registry-policy.test.mjs tests/unified-cli-adapters.test.mjs tests/unified-cli.test.mjs tests/plugin-package.test.mjs
git diff --check
node plugins/uagents/bin/uagents.mjs probe codex --model gpt-6-astra
```

Result: 79/79 tests PASS, `git diff --check` exit 0, and native installed Codex 0.153.4 probe `succeeded / version_only / not_sent`.

The native `@openai/codex` `exec --help` and `login status` commands were also inspected without sending a prompt. The first supports image and resume/fork flags, but those mappings remain deliberately closed at uAgents v1. Login state alone does not prove availability of `gpt-6-astra`, quota, or successful dispatch.

## Remaining limitations

The spawned Codex npm JS entry launches a native CLI descendant. A launcher exit or kill does not by itself verify process-tree quiescence. Cross-process durable reconciliation, native image mapping and real provider task acceptance still need independent implementation/validation before the capabilities can be advertised.

Later on the same date, the separate [Luna installed-plugin E2E](2026-09-20-codex-luna-installed-e2e.md) verified real model-task acceptance and response persistence through the published plugin. Native image mapping and durable process-tree reconciliation remain unsupported.
