# Council Cleanup provider-free 验证

日期：2026-09-12。

本验证只使用本地临时 Git repository 和 fixture Task，不调用任何 Agent provider。

已覆盖：

- clean member：删除 worktree + dedicated branch；
- Council manifest 和 succeeded Task 历史继续可读；
- `council-result` / `council-diff` 对已清理 member 返回 removed evidence；
- 已清理 candidate 不能继续 `council-adopt`；
- 同一 member 重复 cleanup 幂等返回 `already_removed`；
- dirty candidate 默认拒绝；
- committed/diverged candidate 默认拒绝；
- `--all` 在任何 member preflight 失败时不先删除其他 member；
- `--force --all` 显式丢弃 dirty/diverged candidates；
- cleanup 后 exact Council resubmit 不重建已删除 worktrees；
- CLI discovery 暴露 `--member | --all` 二选一与 `--force`；
- Unified MCP 暴露 `uagents_council_cleanup`。

最终完整测试计数见 [Council 历史状态快照](../history/status/2026-09-12-council-current.md)。

本轮最终门禁：Council + CLI targeted 26/26，Unified MCP targeted 7/7；完整 Core 297/297、Doubao MCP 11/11、TRAE MCP 9/9、Unified MCP 7/7，总计 324/324。
