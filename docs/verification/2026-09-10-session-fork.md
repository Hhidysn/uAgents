# Native Session Fork provider-free 验证

日期：2026-09-10

## 验证范围

本文件验证当前源码中的 WorkBuddy/OpenCode session fork mapping，不发送真实 provider prompt。用户后续明确授权的
真实 fork E2E 已通过，见 `2026-09-10-real-session-fork-e2e.md`。

公开请求契约：

```json
"session": { "fork_from_task_id": "<finished-task-uuid>" }
```

它与 `continue_from_task_id` 严格二选一。

## Native mapping

本轮再次用本机 CLI `--help` 做 provider-free 核实，输出仍明确包含：

```text
WorkBuddy: --resume [sessionId], --fork-session
OpenCode:  --session <id>, --fork
```

WorkBuddy help 同时说明 `--fork-session` 是“resuming 时创建新 session ID”；OpenCode help 说明 `--fork` 会在 continuing 前 fork，且要求配合 `--continue` 或 `--session`。这些命令没有发送 prompt。

当前源码映射：

```text
WorkBuddy fork: --resume S1 --fork-session
OpenCode fork:  run --session S1 --fork ...
```

parser 对 continuation 要求 native identity 保持 S1；对 fork 则拒绝 source S1，并把第一条新的有效 session S2 绑定为当前 Task identity。

## Runtime fixture

`tests/unified-cli-adapters.test.mjs` 对 WorkBuddy 和 OpenCode 都运行三 Task 链：

```text
Task A fresh        -> native S1
Task B fork A       -> native S2, S2 != S1
Task C continue B   -> native S2
```

这证明 fork 结果可以继续作为后续 conversation branch 使用，而不是一次性 transport flag。

同时覆盖：

- Schema 接受 continue 或 fork，拒绝空 session、同时指定两者、非法 UUID 和 self-reference。
- Policy 只对 `fork=true` 的 target 放行 `fork_from_task_id`。
- WorkBuddy/OpenCode capability 均为 `resume=true, fork=true`；agy 为 false。
- OpenCode structured fork 与 caller-supplied `--session` / `--continue` / `--fork` 冲突。
- Unified MCP schema 与 CLI `schema request` 都暴露 `fork_from_task_id`。
- Windows OpenCode reconcile context 保留 persisted session action；恢复只观察原 Attempt，不重新 fork、不重发 prompt。

## 测试结果

Targeted：

```text
Core relevant      65/65
Unified MCP         6/6
```

全量：

```text
Core              285/285
Doubao MCP         11/11
TRAE MCP            9/9
Unified MCP         6/6
Total             311/311
```

## 证据边界

本文件自身仍只记录 provider-free contract / fixture 证据。真实 provider 的 source -> fork 上下文继承与新 session
identity 已在用户明确授权后验证通过，见 [Native Session Fork 实机 E2E](2026-09-10-real-session-fork-e2e.md)。
当前实机验证没有额外执行 fork branch 的第三轮 continuation；该链路目前由本文件的三 Task fixture 覆盖。
