# Council Candidate Comparison 设计

日期：2026-09-11。

## 目标

在不增加模型调用、不修改成员 worktree 的前提下，让 Codex 一次比较 implementation Council 的候选实现。

公开入口：

```text
uagents council-diff <council-id>
uagents_council_diff
```

两者都是纯本地只读操作，只读取 Council manifest、成员 Task result 与 Git worktree。

## 第一版范围

`council-diff` 只支持 `workspace_strategy:"git-worktree"` 的 Council。shared Council 没有独立候选工作树，因此明确返回 `unsupported_capability`，而不是伪造空 diff。

每个 member 返回：

- `member_id` / target / model / task ID；
- Task terminal/lifecycle 摘要；
- response / usage / artifacts；
- branch、worktree root、effective workspace、base/current HEAD；
- tracked file status；
- tracked unified patch；
- untracked file path / byte size；
- 小型 UTF-8 untracked 文本文件的原始内容。

Tracked patch 使用 Git 原生 `git diff <base-head>`，所以既覆盖未提交 tracked 修改，也覆盖 member 已经提交到其分支的修改。Untracked 文件不伪造成 Git patch，而是单独列出。

## 输出边界

单个 member 的 tracked patch 最多内联 1 MiB；超过时保留总 byte 数并设置 `tracked_patch_truncated:true`。

单个 untracked 文件最多内联 256 KiB 文本内容；更大的文件仍返回 path / bytes，但不内联内容。二进制文件返回 `binary:true`，不展开正文。

这些限制只约束比较结果大小，不改变 member worktree，也不删除任何文件。

## 非目标

- 不自动选择 winner；
- 不自动调用 synthesis/reviewer 模型；
- 不自动 commit；
- 不自动 merge/cherry-pick/apply；
- 不清理 branch/worktree；
- 不修改普通 Task runtime 或 workspace lease。

下一阶段如果需要采用候选，应设计独立、显式的 `council-adopt`，而不是让 `council-diff` 带写操作。
