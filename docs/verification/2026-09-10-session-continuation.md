# Native Session Continuation provider-free 验证

日期：2026-09-10。范围：当前仓库源码中的 WorkBuddy/OpenCode 多轮 native session continuation。**没有执行 provider-billable E2E。**

## Native CLI 契约

- OpenCode `opencode run --help`：存在 `--continue`、`--session <id>`、`--fork`；当前实现使用确定性的 `--session <persisted-id>`。
- WorkBuddy `codebuddy.js --help`：存在 `--continue`、`--resume [sessionId]`、`--fork-session`；当前实现使用确定性的 `--resume <persisted-id>`。
- 上述命令均为本机只读 help，没有向 provider 发送 prompt。

## 已验证实现

- Schema 1.0 新增可选 `session.continue_from_task_id`；每个 follow-up 仍使用新 UUID。
- Registry 只对 WorkBuddy/OpenCode 暴露顶层 `resume=true`。
- TaskService 从 source Task 的 `native_sessions` 解析 session id；source 必须结束、同 target、同 workspace并已有 session id。
- continuation 仅保存 `{from_task_id,native_session_id}` metadata；不复制历史 transcript。
- WorkBuddy 使用 `--resume <source-session>`，OpenCode 使用 `run --session <source-session>`。
- 两个 parser 都把 native event identity 绑定到 source session。
- `status` / `result` 回显 `session.continue_from_task_id`，且 status 仍然只读 SQLite。
- Unified MCP request schema 同步支持 continuation。

Provider-free runtime fixture 完成两轮 WorkBuddy Task：第一轮成功并持久化 native session；第二轮用新 UUID 引用第一轮 Task，最终 `native.session_id` 与第一轮一致。测试同时覆盖 cross-target、不同 workspace 和未结束 source Task。

## 门禁

```text
Targeted core     46/46
Core             278/278
Doubao MCP        11/11
TRAE MCP            9/9
Unified MCP         5/5
Total            303/303
```

本文件只记录 provider-free contract 验证。用户后续明确授权的真实 WorkBuddy/OpenCode continuation E2E 已通过，见 `2026-09-10-real-session-continuation-e2e.md`。仍未实现 fork/branch、implicit `latest`，也没有为 agy/Doubao/TRAE 猜 continuation API；没有新增 permission bypass 或 uAgents sandbox。
