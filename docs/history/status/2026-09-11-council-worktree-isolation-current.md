# Council Worktree Isolation 当前状态

> 历史阶段快照。Council 当前统一状态请读 [2026-09-12-council-current.md](2026-09-12-council-current.md)。本文保留 Worktree Isolation 阶段的实现与实机证据边界。

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

`council-result` 会返回 branch、worktree root、effective workspace、base/current HEAD、dirty、changes、diff stat。`council-diff` 在此基础上专门比较候选：返回 tracked file status/unified patch，并把此前 Git diff 看不到的 untracked 文件单独列出；小型 UTF-8 新文件会直接带正文。

不自动 merge、commit、删除 worktree 或选择 winner。

## Provider 边界

2026-09-11 已完成一次明确授权的真实 WorkBuddy + OpenCode implementation Council E2E，详见 [实机 implementation E2E](../../verification/2026-09-11-real-council-worktree-implementation-e2e.md)。两个 member 均在各自 worktree 内成功写入独立文件并返回精确 acknowledgement；source repo 保持干净，两个 worktree 互相看不到对方文件，且没有自动 commit/merge。该实机验证共两次 provider prompt，没有额外 synthesis call。

一次状态采样中 WorkBuddy 已结束而 OpenCode 仍为 `running/submission=sent`；这说明 OpenCode 没有被同一个 source workspace lease 保持在 `queued/not_sent`，但单次采样不用于声称 provider 远端计算严格同时发生。

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
