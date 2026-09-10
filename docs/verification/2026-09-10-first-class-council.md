# First-class Council provider-free 验证

日期：2026-09-10

## 验证内容

- Council Schema 1.0：2–16 members、`strategy=fanout`；兼容默认 `analysis + shared`，后续 Worktree Isolation 扩展支持 `implementation + git-worktree`。
- `schema council` 和 `describe council-submit` machine-readable discovery。
- `council_id + member_id` 确定性成员 Task UUID。
- 两成员 fan-out 会立即注册两个普通 Task，而不会等待前一成员完成。
- 相同 Council 重提复用成员 Task，不再次 launch Worker。
- 同 `council_id` 改变内容返回 `request_conflict`。
- 所有成员 static admission 在 fan-out 前完成；例如 common file attachment 遇到不支持 native files 的 member 时不会先 launch 其他成员。
- Council manifest 跨 Runtime reopen 可继续读取。
- fan-in 在成员完成时返回 `complete`，并按 member 原样保留 response / usage / artifacts；没有 `summary` 或额外 synthesis call。
- Unified MCP 暴露 `uagents_council_submit/status/result`，schema 与 CLI/Core Council schema 的顶层结构保持 parity。

## Provider 边界

本验证只使用本地 Task registration stub / fake result，不执行真实 Agent prompt，不验证 provider 并发或真实多 Agent 结果质量。

由于现有 overlapping-workspace lease 未改变，共享同一 workspace 的 Council 成员在真实 runtime 中仍可能被串行化；`fanout` 仅表示注册/调度不等待前一成员完成。

真实 WorkBuddy + OpenCode 验证已在后续用户明确授权后单独执行，见 [First-class Council 实机 E2E（2026-09-11）](2026-09-11-real-first-class-council-e2e.md)。

## 测试结果

```text
Council + CLI targeted   19/19
Unified MCP targeted      7/7

Core                    290/290
Doubao MCP               11/11
TRAE MCP                  9/9
Unified MCP               7/7
Total                   317/317
```
