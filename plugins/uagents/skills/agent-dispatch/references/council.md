# Council workflow

Use Council for independent multi-Agent work instead of manually creating unrelated Tasks. The Core machine-readable contracts are `schema council` and `schema council-validation`; command syntax comes from `describe council-submit`, `describe council-diff`, `describe council-validate`, `describe council-adopt`, and `describe council-cleanup`.

Minimal analysis Council:

```json
{
  "schema_version": "1.0",
  "council_id": "<uuid>",
  "strategy": "fanout",
  "prompt": "Review this bounded change.",
  "workspace": "F:\\project",
  "members": [
    { "member_id": "architecture", "target": "workbuddy", "model": "default" },
    { "member_id": "implementation", "target": "opencode", "model": "commandcode-goat/deepseek/deepseek-v4-flash" }
  ]
}
```

Compatibility defaults are `mode:"analysis"` and `workspace_strategy:"shared"`. For parallel implementation candidates use `mode:"implementation"`, `workspace_strategy:"git-worktree"`, and an explicit Git workspace. uAgents creates one persistent branch/worktree per member from the committed source HEAD; uncommitted source changes are not copied.

The normal workflow is:

```text
council-submit
  -> council-status / council-result
  -> council-diff
  -> council-validate when local test evidence is useful
  -> explicitly choose one member
  -> council-adopt
  -> council-cleanup when candidates are no longer needed
```

`council-diff` is local-only and compares tracked patches plus untracked files. `council-adopt` applies one explicitly selected succeeded candidate to a destination whose HEAD still equals the Council base HEAD; it does not commit, merge, switch branch, or select a winner.

`council-validate` is also local-only. The legacy validation JSON uses `schema_version:"1.0"`, `command:[executable,...args]`, and optional `timeout_ms`. Multi-step validation instead uses `checks:[{name,command,timeout_ms?}, ...]` plus optional top-level `timeout_ms` and `on_failure:"continue"|"stop"`. Checks run in declaration order without a shell in each selected member's effective worktree workspace. `continue` (the default) collects later evidence after a failed/timeout/error check; `stop` records the remaining checks as `skipped`. Latest evidence, including each named check's outcome, exit code, duration and bounded stdout/stderr, is exposed through status/result/diff. A failed validation is evidence for comparison; Council still does not choose the winner automatically.

`council-cleanup` removes selected member worktrees and dedicated Council branches while keeping Council/Task history. Clean, non-diverged candidates can be removed normally. Dirty or committed/diverged candidates require explicit `--force`. `--all` preflights all selected members before removing any. Never clean up a nonterminal member Task.

Council never adds an automatic vote, synthesis, fallback provider, merge, or background garbage collector. A member may use the normal same-target session continue/fork selector; native sessions are not shared across targets.
