# Council Cleanup 设计

日期：2026-09-12。

## 目标

为 persistent git-worktree Council 增加显式生命周期收尾，而不删除 Council / Task 历史，也不引入后台 GC。

CLI：

```text
council-cleanup <council-id> --member <member-id> [--force]
council-cleanup <council-id> --all [--force]
```

MCP：`uagents_council_cleanup`。

## 语义

- 仅 `workspace_strategy:"git-worktree"` Council；
- 非终态 member Task 不允许 cleanup；
- 默认仅清理 clean 且 `HEAD == base_head` 的候选；
- dirty 或有独立 commit 的 candidate 需要显式 `--force`；
- `--all` 先 preflight 所有目标 member，再执行删除，避免先删一半后才发现冲突；
- 删除 member worktree 和 dedicated `uagents/council/...` branch；
- manifest / request / Task / result 保留，并持久化 cleanup evidence；
- cleanup 后 exact Council resubmit 不重建已清理 worktree；
- 不自动 adopt、commit、merge、删除 Council 状态或后台回收。

## 历史读取

清理后 `council-status` / `council-result` 仍可读 Task 与 cleanup metadata。`council-diff` 标记 candidate worktree 已移除；`council-adopt` 对已清理 member 返回冲突。

## 实现边界

Git 删除使用 worktree 的 common git dir 操作 linked worktree，然后删除 dedicated branch。branch 名由 uAgents 创建并持久化，不从用户分支猜测。
