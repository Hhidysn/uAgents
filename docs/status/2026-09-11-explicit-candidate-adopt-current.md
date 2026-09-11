# Explicit Candidate Adopt 当前状态

> 历史阶段快照。Council 当前统一状态请读 [2026-09-12-council-current.md](2026-09-12-council-current.md)。本文保留 Explicit Candidate Adopt 阶段的实现与验证背景。

日期：2026-09-11。本文以当前工作树源码为准。

## 当前能力

git-worktree Council 已支持显式候选采纳：

```text
council-adopt <council-id> --member <member-id> --workspace <absolute-dir>
uagents_council_adopt
```

只有明确指定的 member 会被应用；uAgents 不自动选择 winner。

Adopt 使用候选相对 Council `base_head` 的完整 binary tracked patch，并复制 Git 可见的 untracked 普通文件。destination `HEAD` 必须仍等于 `base_head`，但允许存在不冲突的 dirty 内容。tracked patch 会先执行 `git apply --check`，untracked 路径冲突会在 tracked patch 真正应用前拒绝。

操作后 destination 保持原 branch/HEAD，不自动 `git add`、commit、merge 或 cherry-pick。

## 当前边界

- 仅 `workspace_strategy:"git-worktree"`；
- 仅 `succeeded` member；
- destination 必须显式给出绝对 Git workspace；
- untracked symlink/非普通文件第一版不采纳；
- Git ignored 文件不属于候选 adopt 输入；
- 不维护 adoption receipt；重复执行发生实际冲突时返回 `request_conflict`；
- 不自动 cleanup Council worktree/branch。

## Provider 边界

该功能是纯本地 Git/filesystem 操作，不需要 provider 调用。

## 实际零-provider 验证

已对 2026-09-11 真实 WorkBuddy + OpenCode implementation Council 留下的 WorkBuddy candidate 执行 adopt，但没有发送任何新 provider prompt：

```text
council_id = 8ce9f171-f3c6-4a87-9fc4-18c80614381f
member_id  = workbuddy-implementation
base_head  = 31e9907171ad24a03ddc7489fe53cb68d29cf9ad
```

采纳到新的 detached destination 后，只出现 `workbuddy-result.txt`，内容为 `WB-WT-33146F15`；`opencode-result.txt` 不存在，destination HEAD 仍等于 base HEAD。

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
