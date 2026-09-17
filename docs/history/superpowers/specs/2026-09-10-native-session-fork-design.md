# Native Session Fork / Branch 设计

日期：2026-09-10

## 目标

在现有显式 continuation 之上增加显式 branch：新 uAgents Task 可以继承一个已结束 Task 的 native conversation context，但目标必须创建新的 native session。uAgents 不复制 transcript、不拼历史 prompt，也不实现自己的 conversation clone。

## 请求契约

现有 continuation 保持不变：

```json
"session": { "continue_from_task_id": "<task-uuid>" }
```

新增：

```json
"session": { "fork_from_task_id": "<task-uuid>" }
```

二者严格二选一。两种操作都创建新 Task / Attempt / `request_id`，source Task 必须已结束、target/workspace 相同，并且已经持久化 native session ID。

## 内部 session context

TaskService 把外部 selector 解析成：

```json
{
  "action": "fork",
  "from_task_id": "<source-task>",
  "native_session_id": "<source-native-session>"
}
```

该 context 保存在 Task payload，传给 Worker / Adapter；status/result 继续回显用户提交的 `session` selector。

## Native mapping

WorkBuddy：

```text
continue: --resume S1
fork:     --resume S1 --fork-session
```

OpenCode：

```text
continue: opencode run --session S1 ...
fork:     opencode run --session S1 --fork ...
```

Continuation 的结果 identity 必须仍为 S1。Fork 的第一条有效 native event 必须绑定 S2，且 S2 != S1；之后该 Task 的所有 native events 都必须保持 S2。

## Capability

Registry 顶层能力分开表达：

- WorkBuddy: `resume=true`, `fork=true`
- OpenCode: `resume=true`, `fork=true`
- agy / Doubao / TRAE: `resume=false`, `fork=false`

`lifecycle.resume` 仍然只表示 same-Task managed lifecycle 恢复，与 native conversation continuation/fork 无关。

## Durable OpenCode

Windows durable execution 的 reconcile 必须读取 Task payload 中已持久化的 session context，使 Worker 重启后的 parser 仍知道 continuation 应保持 source session，fork 应拒绝 source session。Reconcile 只观察同一 Attempt，不会再次执行 `--fork` 或重发 prompt。

## 非目标

- 不支持 implicit latest session。
- 不允许同时 continue + fork。
- 不实现自动多分支调度或 Council。
- 不复制 native transcript。
- 不为 agy/Doubao/TRAE 猜测 fork API。
- 不进行 provider-billable fork E2E，除非用户另行明确授权。
