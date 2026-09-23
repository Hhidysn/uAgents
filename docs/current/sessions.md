# 当前会话能力

WorkBuddy 和 OpenCode 支持把新 Task 映射到已有 native session。Codex 在 Windows 上显式选择 `gpt-6-astra` 的 app-server 预览路线也支持此操作。

继续同一 native session：

```json
"session": { "continue_from_task_id": "<previous-task-uuid>" }
```

从已有上下文创建独立 native branch：

```json
"session": { "fork_from_task_id": "<previous-task-uuid>" }
```

两个 selector 严格二选一。

## 规则

- follow-up 必须使用新的 `request_id`。
- source Task 必须显式指定，不自动选择“最近一次会话”。
- source 与 follow-up 必须使用相同 target 和 workspace。
- source Task 必须已经结束，并拥有已持久化 native session id。
- continuation 必须保持 native session identity。
- fork 必须得到新的 native session identity。
- uAgents 不会把旧 prompt/response/history 重新拼接进新 prompt。

## Native mapping

WorkBuddy continuation 使用 native `--resume <session-id>`；fork 在此基础上增加 `--fork-session`。

OpenCode continuation 使用 `run --session <session-id>`；fork 增加 `--fork`。

Codex 预览路线需在每条 Task 的 `execution` 中显式加入 `"codex_transport": "app-server"`，并选择 `target=codex`、`model=gpt-6-astra`。不填此字段时，Codex 仍使用 `exec --json`，且不接受跨 Task 会话。来源 Task 也必须来自 app-server 路线；Luna 和非 Windows 平台不开放此预览路线。

Codex continuation 用持久化的 Thread/Turn ID 续接，并在发送前核对来源是原生线程最新 Turn；fork 用 `thread/fork.lastTurnId` 固定来源边界，可以从较早的已完成 Turn 创建新分支。源工作区和 CLI 安装指纹必须匹配。缺少确定终态或无法确认进程树静止时，Task 保持不确定，不自动重发 Prompt。

Codex 的沙箱和审批策略由本机 Codex 原生配置控制，uAgents 不提供审批代理。app-server 若发出需要交互答复的原生审批请求，uAgents 不作决定，也不发送同意或拒绝；该已发送 Task 保持 `indeterminate`，错误码为 `native_approval_required`。检查 Codex 原生权限配置与工作区后，可另行决定如何处理；对原 Task 使用 `resume` 只做恢复观察，不重发 Prompt。

## 与 `uagents resume` 的区别

`uagents resume <task-id>` 恢复的是同一个 uAgents Task / Attempt，主要用于继续本地调度或观察已有 native execution，不表示发送新的 follow-up prompt。

`session.continue_from_task_id` / `fork_from_task_id` 创建新的 Task，并发送新的 prompt。

`capabilities codex` 的顶层 `resume=false`、`fork=false` 描述默认 exec 路线；`opt_in_transports.app-server` 单独声明预览路线的模型、平台和会话能力。
