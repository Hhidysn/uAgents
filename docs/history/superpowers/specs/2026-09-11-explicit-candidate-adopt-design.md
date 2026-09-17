# Explicit Candidate Adopt 设计

日期：2026-09-11。

## 目标

在 First-class Council + git-worktree isolation + `council-diff` 之后，增加一个显式本地动作，把用户/Codex 明确选中的一个候选实现应用到指定 Git workspace。

uAgents 仍保持薄 orchestration：不自动选 winner，不自动 merge，不自动 commit，不再调用模型。

## CLI / MCP

```text
council-adopt <council-id> --member <member-id> --workspace <absolute-dir> [--state-dir <dir>]
uagents_council_adopt { council_id, member_id, workspace }
```

CLI effect 为 `local_state_change`。操作不会联系 native Agent/provider。

## 语义

Adopt 只支持 `workspace_strategy:"git-worktree"` Council，并要求被选 member 的 Task 已经 `succeeded`。

destination 必须是绝对 Git workspace，并且当前 `HEAD` 必须精确等于 Council `base_head`。destination 可以有与候选不冲突的本地 dirty 改动；tracked 候选 patch 会先通过 `git apply --check`。

候选内容分两部分应用：

1. tracked changes：从 candidate worktree 对 `base_head` 生成完整 `git diff --binary`，用 `git apply` 应用到 destination repository root；
2. untracked files：使用 Git `ls-files --others --exclude-standard` 枚举普通文件，预先确认 destination 路径不存在，再复制字节并保留文件 mode。

这样能够覆盖 modified/deleted/renamed/binary tracked changes，以及 Agent 新建但尚未 `git add` 的文件。

## 冲突行为

以下情况在修改 destination 前拒绝：

- shared Council；
- member_id 不存在；
- member Task 未成功完成；
- destination 不是绝对 Git workspace；
- destination `HEAD != base_head`；
- candidate untracked 文件路径已存在于 destination；
- tracked patch 无法通过 `git apply --check`。

重复 adopt 同一候选通常会因 tracked patch 已应用或 untracked 路径已存在而返回 `request_conflict`。第一版不维护额外 adoption receipt，也不把重复操作伪装成幂等成功。

## 输出

返回 Council/member/target/model、source branch/worktree/base/current HEAD、destination workspace/repository/HEAD/dirty changes，以及 applied tracked patch bytes 和 copied untracked file path/bytes。

## 明确不做

- winner selection；
- synthesis/reviewer model call；
- branch checkout/switch；
- merge/cherry-pick/rebase；
- `git add` / commit；
- worktree cleanup；
- filesystem transaction/rollback framework。
