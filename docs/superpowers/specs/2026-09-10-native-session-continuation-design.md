# Native Session Continuation 设计

日期：2026-09-10

## 目标

让一个新的 uAgents Task 可以显式继续上一轮 WorkBuddy/OpenCode 的原生会话，同时保持现有 Task / Attempt / artifact / idempotency 模型不变。

多轮对话不是“把一个 Task 重新 submit”。每一轮仍然使用新的 `request_id`，上一轮只作为 native session 的来源。

## 请求契约

Schema 1.0 新增可选字段：

```json
{
  "session": {
    "continue_from_task_id": "<previous-uagents-task-uuid>"
  }
}
```

第一阶段规则：

- source Task 与新 Task 必须是同一个 target。
- 必须使用同一个 workspace。
- source Task 必须已经结束（当前接受 `succeeded` / `failed`）。
- source Task 必须已经持久化非空 native `session_id`。
- continuation 不表示 retry；新一轮必须使用新的 `request_id`。
- 不提供 implicit `latest`，调用方必须明确指定 source Task。

## 数据流

```text
new request
  session.continue_from_task_id
        |
        v
TaskService reads previous native_sessions row
        |
        v
payload.json.continuation = { from_task_id, native_session_id }
        |
        v
Worker -> adapter context
        |
        +--> WorkBuddy: --resume <native_session_id>
        |
        `--> OpenCode: run --session <native_session_id>
```

uAgents 不读取、复制或重放旧对话 transcript。历史上下文仍由目标自己的 session persistence 负责。

## Target mapping

### WorkBuddy

本机当前 `codebuddy.js --help` 明确提供：

```text
-r, --resume [sessionId]  Resume a conversation
```

新会话继续使用 `--session-id <new-task-uuid>`；continuation 改为 `--resume <persisted-session-id>`，不同时传新的 `--session-id`。stream-json prompt 和 attachment block 继续走已有路径。

### OpenCode

本机当前 `opencode run --help` 明确提供：

```text
-s, --session  session id to continue
```

continuation 使用 `run --session <persisted-session-id>`。新会话仍使用 uAgents title；continuation 不重新设置 title。structured continuation 与 caller 自己提供的 `--session` / `--continue` / `--fork` session-selection 参数不能混用。

## 与 `resume <task-id>` 的区别

`resume <task-id>` 是**同一 Task / 同一 Attempt 的本地恢复或重新观察**，不会发送新的 prompt。

`session.continue_from_task_id` 是**新的 Task / 新的 Attempt / 新的一条用户消息**，只是目标 native session 与上一轮相同。

## Capability

Registry 顶层 `resume` 表示 target 是否有经过映射的 native session continuation：

- WorkBuddy: `true`
- OpenCode: `true`
- agy / Doubao / TRAE: `false`

`lifecycle.resume` 仍表示 uAgents 自己的 managed task/lifecycle 恢复能力，两者不是同一概念。

## 本阶段不做

- 不自动选择“最近会话”。
- 不实现 fork/branch session。
- 不把历史 response 拼进下一轮 prompt。
- 不给 agy、Doubao、TRAE 猜测 continuation API。
- 不新增权限 flag 或权限沙箱。
- 不执行 provider-billable continuation E2E，除非用户另行明确授权。
