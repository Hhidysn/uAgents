# Native Session Continuation 当前状态

日期：2026-09-10。本文记录当前仓库工作树，不以旧安装 cache 为准。

## 当前结论

WorkBuddy 和 OpenCode 已支持显式多轮 native session continuation。每一轮仍然是新的 uAgents Task / Attempt / `request_id`，调用方通过：

```json
"session": { "continue_from_task_id": "<previous-task-uuid>" }
```

指定上一轮 Task。uAgents 从上一 Task 已持久化的 `native_sessions` 记录解析 native session id，再把新的 prompt 交给目标自己的 continuation API；不会把旧 prompt/response/history 重新拼接发送。

## Capability

当前源码 CLI 输出：

```text
workbuddy resume = true   lifecycle.resume = false
opencode  resume = true   lifecycle.resume = false
agy       resume = false  lifecycle.resume = false
```

顶层 `resume` 表示 **native session continuation mapping**。`lifecycle.resume` 表示 uAgents managed lifecycle / same-Task 恢复能力，两者不同。

## 请求规则

- follow-up 必须使用新的 `request_id`。
- source Task 通过 `session.continue_from_task_id` 显式指定，不自动猜 latest session。
- source 与 follow-up 必须使用同一个 target。
- 必须使用同一个 workspace。
- source Task 当前必须已经进入 `succeeded` 或 `failed`。
- source Task 必须已经有持久化 native `session_id`。
- `status` / `result` 会回显请求的 `session.continue_from_task_id`。

## Native mapping

### WorkBuddy

本机当前 `codebuddy.js --help` provider-free 核实：

```text
-c, --continue
-r, --resume [sessionId]
--fork-session
```

新 Task 默认仍用 `--session-id <request-id>`。follow-up 改用：

```text
--resume <persisted-native-session-id>
```

不同时设置新的 `--session-id`。已有 stream-json text/file/image 输入路径完全复用。

### OpenCode

本机当前 `opencode run --help` provider-free 核实：

```text
-c, --continue
-s, --session <id>
--fork
```

follow-up 映射为：

```text
opencode run --session <persisted-native-session-id> ...
```

continuation 不重新设置 session title。structured continuation 与 caller 在 `execution.native_args` 中自己选择 `--session` / `--continue` / `--fork` 不能混用。

## 与现有 `resume` 命令的区别

`uagents resume <task-id>` / `uagents_resume` 仍然只恢复或重新观察**同一个 Task / Attempt**，不会发送新 prompt。

`session.continue_from_task_id` 则创建**新 Task / 新 Attempt / 新 prompt**，只是继续同一个目标 native session。

## 当前验证

provider-free 全量门禁：

```text
Core            278/278
Doubao MCP       11/11
TRAE MCP           9/9
Unified MCP        5/5
Total           303/303
```

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

1. 后续如有明确需求，再设计 fork/branch；当前不自动 fork。
2. agy / Doubao / TRAE 只有发现可靠 native continuation API 后才开放，不猜接口。
