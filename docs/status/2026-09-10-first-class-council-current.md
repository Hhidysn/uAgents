# First-class Council 当前状态

> 历史阶段快照。Council 当前统一状态请读 [2026-09-12-council-current.md](2026-09-12-council-current.md)。本文保留第一阶段 fan-out/fan-in 的实现与验证背景。

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

- Council 默认 `analysis + shared`；现在也支持 `implementation + git-worktree`。
- `strategy` 当前只有 `fanout`。
- 成员数 2–16。
- 顶层共享 prompt / workspace / inputs / observation timeout / effort / permission。
- analysis permission 默认 `advisory-read-only`；implementation 默认 `native`。
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

`fanout` 表示 Council 不等待一个成员完成才注册下一个成员。

`workspace_strategy=shared` 保持原行为：重叠 workspace lease 仍可能把成员串行化。

`workspace_strategy=git-worktree` 会为每个 member 从 source committed HEAD 创建不同 Git worktree，因此 workspace lease 不再互相 overlap；global / target concurrency limit 仍保留。implementation Council 必须使用这一策略。详见 [Council Worktree Isolation 当前状态](2026-09-11-council-worktree-isolation-current.md)。

## Provider 调用边界

Council 本身是会触发成员 Agent 的 provider-billable 调度入口。自动化测试继续只使用 stub/fixture；真实 Council E2E 只有在用户明确授权后执行。

2026-09-11 已完成一次最小真实 WorkBuddy + OpenCode Council E2E，详见 [First-class Council 实机 E2E](../verification/2026-09-11-real-first-class-council-e2e.md)。一次 Council submit 注册两个成员 Task，两者最终均 `succeeded`，Council 聚合为 `complete`，`council-result` 原样返回两个真实 response/usage，没有额外 synthesis provider call。共享测试 workspace 下也真实观察到 WorkBuddy 完成时 OpenCode 仍在 queued，随后才执行，符合“fanout 注册不等于 provider 并发”的设计边界。

## 当前验证

```text
Council + CLI targeted   22/22
Unified MCP targeted      7/7

Core                    293/293
Doubao MCP               11/11
TRAE MCP                  9/9
Unified MCP               7/7
Total                   320/320
```

真实 E2E 没有修改 runtime 源码；上面的 317/317 是本次实机验证所使用提交的完整自动化门禁结果。
