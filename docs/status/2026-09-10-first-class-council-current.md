# First-class Council 当前状态

日期：2026-09-10。本文以当前仓库源码为准。

## 当前结论

uAgents 已提供第一版一等 Council：一个 Council 持久化自己与成员 Task 的关系，但每个成员仍然使用现有 Task / Attempt / Worker / native session / result / artifact 管线。

CLI：

```text
council-submit (--request <file> | --request-stdin)
council-status <council-id>
council-result <council-id>
schema council
```

Unified MCP：

```text
uagents_council_submit
uagents_council_status
uagents_council_result
```

## 第一版 contract

- Council 固定 `analysis`，不接受 implementation。
- `strategy` 当前只有 `fanout`。
- 成员数 2–16。
- 顶层共享 prompt / workspace / inputs / observation timeout / effort / permission。
- permission 默认 `advisory-read-only`。
- 每个成员声明稳定 `member_id`、target、model，可选 focus instruction 和现有 session selector。
- `council_id + member_id` 确定性派生 UUIDv8 作为成员 Task request ID。
- 完全相同的 Council 重提复用同一组成员 Task；同 `council_id` 内容改变返回 `request_conflict`。
- fan-out 前对所有成员先跑普通 Core static admission；可预知的 target/model/attachment capability 错误不会先发送部分成员。
- `council-status` 只读取本地 Council manifest + Task 状态。
- `council-result` 原样聚合 Task result，不自动调用额外模型总结。

## 状态

Council 聚合状态：

```text
running    所有成员已注册，仍有正常非终态成员
attention  至少一个成员 waiting_user / indeterminate
complete   所有成员都 succeeded / failed / cancelled
partial    至少一个成员没有成功注册
```

成员对象仍包含普通 `task_id` 与 Task status/result，因此需要时可以直接对单个成员使用既有 `status`、`result`、`resume`、`reconcile`、`cancel`。

## Session 边界

成员可以复用现有 `session.continue_from_task_id` / `session.fork_from_task_id`，但普通 Task 的 same-target / same-workspace 规则完全不变。

Native session 不能跨 target 共享。例如 WorkBuddy session 不能直接 fork 成 OpenCode session。跨 target 会审的共同背景由顶层 prompt / attachments 提供。

## 并发边界

`fanout` 表示 Council 不等待一个成员完成才注册下一个成员。它不是“所有 provider 必须同时执行”的承诺。

当前 runtime 的重叠 workspace lease 仍然适用于 Council 成员，所以多个成员读取同一个 project workspace 时可能串行执行。这一版没有为 Council 放松 workspace ownership，也没有新增写入并发语义。

真正的 implementation Council / 并行写入应在后续用独立 worktree 设计，而不是复用同一个 workspace。

## Provider 调用边界

Council 本身是会触发成员 Agent 的 provider-billable 调度入口。当前实现和自动化测试只使用 stub/fixture，没有因为实现 Council 自动执行真实 provider E2E。真实 Council E2E 仍需用户明确授权。

## 当前验证

```text
Council + CLI targeted   19/19
Unified MCP targeted      7/7

Core                    290/290
Doubao MCP               11/11
TRAE MCP                  9/9
Unified MCP               7/7
Total                   317/317
```
