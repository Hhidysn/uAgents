# Native Session Continuation / Fork 当前状态

日期：2026-09-10。本文记录当前仓库工作树，不以旧安装 cache 为准。

## 当前结论

WorkBuddy 和 OpenCode 已支持显式 native session continuation 和 fork。每一轮仍然是新的 uAgents Task / Attempt / `request_id`。

继续同一 native session：

```json
"session": { "continue_from_task_id": "<previous-task-uuid>" }
```

从上一轮上下文创建独立 native branch：

```json
"session": { "fork_from_task_id": "<previous-task-uuid>" }
```

两个 selector 严格二选一。uAgents 从 source Task 已持久化的 `native_sessions` 记录解析 native session id，再把新 prompt 交给目标自己的 native continuation/fork API；不会把旧 prompt/response/history 重新拼接发送。

## Capability

当前源码 CLI 输出：

```text
workbuddy resume = true   fork = true   lifecycle.resume = false
opencode  resume = true   fork = true   lifecycle.resume = false
agy       resume = false  fork = false  lifecycle.resume = false
```

顶层 `resume` 表示 **native session continuation mapping**，顶层 `fork` 表示 **native session branch mapping**。`lifecycle.resume` 表示 uAgents managed lifecycle / same-Task 恢复能力，三者不同。

## 请求规则

- follow-up 必须使用新的 `request_id`。
- source Task 通过 `session.continue_from_task_id` 或 `session.fork_from_task_id` 显式指定，不自动猜 latest session。
- 两个 session selector 不能同时存在。
- source 与 follow-up 必须使用同一个 target。
- 必须使用同一个 workspace。
- source Task 当前必须已经进入 `succeeded` 或 `failed`。
- source Task 必须已经有持久化 native `session_id`。
- continuation 的 native session ID 必须与 source 相同；fork 的 native session ID 必须与 source 不同。
- `status` / `result` 会回显请求的 session selector。

## Native mapping

### WorkBuddy

本机当前 `codebuddy.js --help` provider-free 核实：

```text
-c, --continue
-r, --resume [sessionId]
--fork-session
```

新 Task 默认仍用 `--session-id <request-id>`。continuation 使用：

```text
--resume <persisted-native-session-id>
```

fork 使用：

```text
--resume <persisted-native-session-id> --fork-session
```

fork 返回的第一条有效 native identity 必须不同于 source session。已有 stream-json text/file/image 输入路径完全复用。

### OpenCode

本机当前 `opencode run --help` provider-free 核实：

```text
-c, --continue
-s, --session <id>
--fork
```

continuation 映射为：

```text
opencode run --session <persisted-native-session-id> ...
```

fork 映射为：

```text
opencode run --session <persisted-native-session-id> --fork ...
```

structured continuation/fork 与 caller 在 `execution.native_args` 中自己选择 `--session` / `--continue` / `--fork` 不能混用。Windows durable reconcile 会恢复持久化的 session action 用于 parser identity 校验，但不会再次发送 prompt 或重新执行 fork。

## 与现有 `resume` 命令的区别

`uagents resume <task-id>` / `uagents_resume` 仍然只恢复或重新观察**同一个 Task / Attempt**，不会发送新 prompt。

`session.continue_from_task_id` 创建**新 Task / 新 Attempt / 新 prompt**并继续同一个 native session；`session.fork_from_task_id` 同样创建新 Task，但要求目标派生新的 native session。

## 当前验证

provider-free 全量门禁：

```text
Core            290/290
Doubao MCP       11/11
TRAE MCP           9/9
Unified MCP        7/7
Total           317/317
```

Fork 的 provider-free runtime fixture 已覆盖 WorkBuddy 和 OpenCode：`source S1 -> fork S2 -> continue S2`，并验证 S2 必须不同于 S1。详见 [Native Session Fork provider-free 验证](../verification/2026-09-10-session-fork.md)。

真实 fork provider E2E 也已在用户明确授权后通过，详见
[Native Session Fork 实机验证](../verification/2026-09-10-real-session-fork-e2e.md)：

- WorkBuddy 父 Task `066ebc69-87b3-4c16-b289-33c15d2e0477` 的 native session 为同名 UUID，fork Task
  `bb8884f8-c158-4316-8aaf-f3f283e70c58` 得到新的 native session
  `191158e0-1bd7-4fcd-9ae2-82e4f9ce7063`；fork prompt 未包含 marker，仍正确返回 `WB-FORK-7R2N5M`。
- OpenCode 父 Task `4b58a656-036d-4b31-bb3b-8357000fa4c2` 的 native session 为
  `ses_f74380eb8ffeI6CEdUdNF1h9nC`，fork Task `02cd35f7-9ca2-4cd6-ac9f-13bbcc80d90c` 得到新的
  `ses_f743772ecffep1YX4fiCdJEzSv`；fork prompt 未包含 marker，仍正确返回 `OC-FORK-6K9Q4T`。

两家目标都证明了 source context 被继承且 fork identity 发生变化。测试 workspace 最终为空，没有 Agent 文件写入。

真实 provider E2E 也已在用户明确授权后完成，详见
[Native Session Continuation 实机验证](../verification/2026-09-10-real-session-continuation-e2e.md)：

- WorkBuddy 第一轮 Task `fc71c8a0-acca-4bfc-a5ee-7d9a9ed98597` 返回 `ACK WB-CONT-9X2M7Q`；
  第二轮 Task `fb554a1a-2c19-4461-80fb-c6615059ff2b` 通过 `continue_from_task_id` 继续同一 native
  session，并在 prompt 未重复 marker 的情况下返回 `WB-CONT-9X2M7Q`。
- OpenCode 第一轮 Task `05ae2fd2-00a4-4ee7-b750-0aea635baa5c` 获得 native session
  `ses_f7892de20ffehTk0a7kxUnlqmZ` 并返回 `ACK OC-CONT-4K8P3R`；第二轮 Task
  `3ade39cb-964b-40e3-93e3-17c7af0f3830` 继续同一 native session，并在 prompt 未重复 marker 的情况下
  返回 `OC-CONT-4K8P3R`。

两家目标的第二轮 `native.session_id` 都与第一轮完全一致。实机请求使用 `analysis + advisory-read-only`，
没有声明输出文件，也没有增加 native permission bypass 或 uAgents 权限沙箱。

## 下一步

1. 下一产品能力可基于已验证的 continuation/fork 设计 First-class Council。
2. 如 Council 需要多个 implementation 分支并行写代码，再增加 worktree isolation，而不是放宽同 workspace lease。
3. agy / Doubao / TRAE 只有发现可靠 native continuation/fork API 后才开放，不猜接口。
