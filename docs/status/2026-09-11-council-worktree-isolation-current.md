# Council Worktree Isolation 当前状态

日期：2026-09-11。本文以当前工作树源码为准。

## 当前能力

First-class Council 已扩展支持：

```json
{
  "mode": "implementation",
  "workspace_strategy": "git-worktree",
  "workspace": "F:\\project"
}
```

每个成员获得独立 Git branch/worktree，再作为普通 Task 的 effective workspace 执行。旧请求默认仍是 `analysis + shared`。

成员 worktree 从 source workspace 当前 committed `HEAD` 创建；source workspace 的 dirty tracked/untracked 内容不会自动复制。

不同成员 worktree canonical workspace 不重叠，所以现有 workspace lease 不再把它们串行化；global / target concurrency limit 仍生效。

`council-result` 会返回 branch、worktree root、effective workspace、base/current HEAD、dirty、changes、diff stat。

不自动 merge、commit、删除 worktree 或选择 winner。

## Provider 边界

当前实现与自动化验证只调用本地 Git 和 fixture/stub，没有发送真实 implementation Council provider prompt。真实 implementation Council E2E 仍需新的明确授权。

## 当前验证

```text
Council + CLI targeted   22/22
Unified MCP targeted      7/7

Core                    293/293
Doubao MCP               11/11
TRAE MCP                  9/9
Unified MCP               7/7
Total                   320/320
```
