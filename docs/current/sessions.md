# 当前会话能力

WorkBuddy 和 OpenCode 支持把新 Task 映射到已有 native session。

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

## 与 `uagents resume` 的区别

`uagents resume <task-id>` 恢复的是同一个 uAgents Task / Attempt，主要用于继续本地调度或观察已有 native execution，不表示发送新的 follow-up prompt。

`session.continue_from_task_id` / `fork_from_task_id` 创建新的 Task，并发送新的 prompt。

当前其它 target 没有经过验证的 continuation/fork mapping，因此保持关闭。
