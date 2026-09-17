# Council Worktree Isolation 设计

日期：2026-09-11。本文以当前仓库源码为准。

## 目标

在不增加第二套执行引擎的前提下，让 First-class Council 的成员可以拥有不同的 Git workspace，从而：

- analysis Council 可以选择真正并行读取同一提交；
- implementation Council 可以让多个 Agent 并行修改代码而互不覆盖；
- 每个成员仍然是普通 uAgents Task / Attempt / Worker；
- Council result 返回每个候选的 branch、HEAD 和 working-tree diff 证据；
- uAgents 不自动 merge、不自动选 winner、不自动提交 Agent 改动。

## 公开协议

Council 增加：

```json
{
  "mode": "analysis | implementation",
  "workspace_strategy": "shared | git-worktree"
}
```

兼容默认值：

```text
mode = analysis
workspace_strategy = shared
```

因此旧 Council 请求行为不变。`implementation` 必须使用 `workspace_strategy=git-worktree`；第一版不允许多个 implementation Task 直接写同一个 shared workspace。

## Git worktree 语义

`workspace_strategy=git-worktree` 要求顶层 `workspace` 位于 Git working tree 内。uAgents 在首次注册时：

1. `git rev-parse --show-toplevel` 找 repository root；
2. `git rev-parse HEAD` 固定 Council `base_head`；
3. 为每个 member 创建稳定 branch `uagents/council/<council-id>/<member-task-id>`；
4. 在 `<state-root>/councils/<council-id>/worktrees/<member-task-id>` 创建持久 worktree；
5. 若 source workspace 是 repository 子目录，成员 Task 指向成员 worktree 内相同相对子目录。

所有 worktree 都从同一个 committed `base_head` 创建。主 workspace 的未提交 tracked 修改和 untracked 文件不会被复制。需要携带的额外文件应使用现有 attachment `source`，或者先提交到 Git。

## Task mapping

成员 Task ID 继续由 `council_id + member_id` 确定性派生。

```text
shared       -> member workspace = council.workspace
git-worktree -> member workspace = member worktree
```

Task runtime、target adapter、attachment ingestion、native session、status/result、cancel/reconcile 不增加第二套逻辑。

## Permission 默认值

```text
analysis       -> advisory-read-only
implementation -> native
```

调用方仍可显式设置已有 `execution.permission`。uAgents 不新增执行权限 sandbox，也不自动添加 target-native permission bypass flags。

## Result evidence

`council-status` 暴露持久化 worktree metadata：branch、worktree root、effective workspace、base HEAD。

`council-result` 进一步实时读取 current HEAD、dirty flag、`git status --porcelain` changes 和 `git diff --stat <base-head>`。

这些都是候选证据；不自动 merge、commit 或 winner selection。

## 幂等

- manifest 保存 `mode`、`workspace_strategy`、`base_head` 与每个 member 的 worktree metadata；
- 相同 Council 重提复用 worktree，不 reset Agent 已有修改；
- 同 `council_id` 改内容仍 `request_conflict`；
- 升级前 manifest 没有新字段时，按旧 normalized hash 继续接受完全相同的旧 Council 请求。

## 并发

worktree member 的 canonical workspace 不重叠，因此 workspace-overlap lease 不再互相阻塞。已有 global / target concurrency limit 仍生效。

## 第一版明确不做

- 不复制 source workspace dirty diff；
- 不自动 `git add` / commit；
- 不自动 merge/cherry-pick；
- 不自动删除 worktree/branch；
- 不自动 winner selection / synthesis；
- 不新增权限 sandbox；
- 不改变普通单 Task workspace lease。
