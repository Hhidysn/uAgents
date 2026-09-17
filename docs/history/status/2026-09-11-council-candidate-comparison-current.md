# Council Candidate Comparison 当前状态

> 历史阶段快照。Council 当前统一状态请读 [2026-09-12-council-current.md](2026-09-12-council-current.md)。本文保留 Candidate Comparison 阶段的实现与验证背景。

日期：2026-09-11。本文以当前工作树源码为准。

## 当前能力

git-worktree Council 已支持纯本地候选比较：

```text
council-diff <council-id>
uagents_council_diff
```

输出按 member 聚合 Task response/usage/artifacts 与 Git evidence：tracked file status、tracked unified patch、untracked 文件及小型 UTF-8 文本内容、branch、base/current HEAD。

这补足了 `council-result` 的一个实际缺口：`git diff --stat` 不包含 untracked 新文件，而 implementation Agent 经常直接创建新文件。

`council-diff` 是 `local_only`，不启动 Agent、不发送 prompt、不修改 worktree。shared Council 明确不支持该操作。

## 当前边界

- tracked patch 内联上限：1 MiB/member；
- untracked 文本内联上限：256 KiB/file；
- binary untracked 只返回 metadata；
- 不自动 winner selection / synthesis / commit / merge / cleanup；显式 adopt 由独立 `council-adopt` 命令完成。

## 实际验证

已对 2026-09-11 真实 WorkBuddy + OpenCode implementation Council 留下的两个 worktree 执行 `council-diff`，未产生任何新 provider 调用。

结果正确读取：

```text
WorkBuddy: workbuddy-result.txt -> WB-WT-33146F15
OpenCode:  opencode-result.txt  -> OC-WT-1B7E4A31
```

两个文件都属于 untracked 文件；此前 `council-result.diff_stat` 为空，而 `council-diff` 现在可以直接看到 path、bytes 与文本内容。

## 当前验证

```text
Council + CLI targeted   24/24
Unified MCP targeted      7/7

Core                    295/295
Doubao MCP               11/11
TRAE MCP                  9/9
Unified MCP               7/7
Total                   322/322
```
