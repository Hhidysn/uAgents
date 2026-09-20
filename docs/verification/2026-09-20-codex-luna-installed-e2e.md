# Codex CLI / GPT-5.6 Luna installed-plugin E2E — 2026-09-20

## Model selector and scope

The installed native CLI reported `codex-cli 0.153.4` and `codex login status` reported `Logged in using ChatGPT`. With an isolated `.local/verification/codex-luna/workspace`, a *real provider-bearing* native `codex exec --json --model gpt-5.6-luna --cd <workspace> --skip-git-repo-check --sandbox read-only -` returned:

```text
thread.started: 01a0be71-0d10-76a0-a395-7bc0356d0576
agent_message: UAGENTS_LUNA_NATIVE_OK
turn.completed: yes
native CLI exit: 0
```

This evidence approves the explicit `codex/gpt-5.6-luna` route in the builtin registry; `gpt-6-astra` remains available. It does not add a default model or assert `model_reported`/`model_verified` from native events.

## Published installation

- New release version: `0.2.0-alpha.1+codex.202609201839luna`.
- Personal marketplace: `C:\Users\24590\plugins\uagents` (previous source backed up to sibling `uagents-backup-before-202609201839luna`).
- Installed using `codex plugin add uagents@personal --json`, whose response selected `C:\Users\24590\.codex\plugins\cache\personal\uagents\0.2.0-alpha.1+codex.202609201839luna`.
- Release file count: 142; all installed files matched repo and personal marketplace source by exact byte comparison (0 mismatches).
- `scripts/verify-installed-plugin.mjs` was updated to assert the current 20 Unified MCP tools and 7 target references, then succeeded against installed cache. The installed-cache CLI returned both approved Codex models and succeeded at `probe codex --model gpt-5.6-luna` (`version_only / not_sent`).
- After all tests, `codex plugin list --json` reported `uagents@personal` installed/enabled on the new version; all 142 installed files still matched repo and marketplace source byte-for-byte.

## Regression evidence

- Codex/registry/TaskService/plugin-package targeted tests: 49/49 passed.
- Full `package.json` test pipeline executed successfully with the Core `node --test` stage capped at concurrency 4; the Doubao MCP, TRAE MCP and Unified MCP suites passed 11/11, 9/9 and 14/14 respectively. Those MCP pretest build steps also completed successfully.
- `git diff --check` exited 0 (Windows line-ending conversion warnings were emitted but no whitespace errors).

## Real uAgents submit/result through installed cache

Request source: `.local/verification/codex-luna/request.json` (local ignored verification directory).

```text
task_id:           1d5dcebe-bd7c-44b1-86a5-ec85a34d9f57
target:            codex
model_requested:   gpt-5.6-luna
model_resolved:    gpt-5.6-luna
route_id:          codex/gpt-5.6-luna
native_session_id: 01a0be74-67ad-7d83-9645-ecab9b795496
attempt.submission: sent
result.status:     succeeded
native_outcome:    succeeded
objective_verdict: succeeded
response.text:     UAGENTS_LUNA_UAGENTS_OK
usage:             input_tokens=15201, cached_input_tokens=11008, output_tokens=13
```

The CLI returned a persisted result, not a fixture or no-prompt version check. `model_reported=null`, `model_verified=false` remain accurate because native JSONL does not self-report the selected model. The explicit native argv and successful provider execution are independent evidence of route usability at the time of this test, not a guarantee of future availability.

The E2E request was read-only by instruction, used the isolated local workspace, and declared no output files. It does not test native image attachments, resume/fork, durable process-tree termination, or the success of a real code-editing task.
