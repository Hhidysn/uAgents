# Council Worktree Isolation provider-free 验证

日期：2026-09-11。

## 已覆盖

- `analysis/shared` 旧默认保持不变；
- `implementation` 缺少 `git-worktree` 会在注册前拒绝；
- `git-worktree` 缺少 workspace 或 workspace 非 Git working tree 会在成员 Worker launch 前拒绝；
- 两成员从同一 `base_head` 创建不同 branch/worktree；
- 成员 Task 使用各自 worktree 作为 effective workspace；
- implementation 默认 permission 为 `native`，analysis 默认仍为 `advisory-read-only`；
- source workspace 的 dirty tracked 文件和 untracked 文件不会复制到成员 worktree；
- 两个 worktree 可同时获得现有 execution workspace lease，证明路径不再 overlap 阻塞；
- 修改一个 member 后，`council-result` 返回 dirty/changes/diff stat，另一个保持 clean；
- 相同 Council 重提复用原 worktree，不重新 launch Worker，也不 reset 修改；
- Unified MCP Council schema 暴露 `mode` / `workspace_strategy`，implementation 需要 git-worktree。

本验证不发送 Agent prompt。

## 测试结果

```text
Council + CLI targeted   22/22
Unified MCP targeted      7/7

Core                    293/293
Doubao MCP               11/11
TRAE MCP                  9/9
Unified MCP               7/7
Total                   320/320
```
