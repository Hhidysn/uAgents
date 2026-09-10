# First-class Council 实机 E2E

日期：2026-09-11。范围：当前仓库源码 `F:\documents\software\uAgents`。

本验证在用户明确授权真实 WorkBuddy + OpenCode Council E2E 后执行。Council 只包含两个成员，因此总共发送两个真实 provider prompt；没有额外 synthesis 调用。

## 请求

Council：

```text
council_id = 4905f532-b339-4fee-86ca-7764bd91b0a7
strategy   = fanout
mode       = analysis (Council v1 固定)
permission = advisory-read-only
```

两个成员共享一个空测试 workspace，没有 attachment，也没有 declared output：

```text
workbuddy-live -> WorkBuddy / default
opencode-live  -> OpenCode / commandcode-goat/deepseek/deepseek-v4-flash
```

每个成员收到同一个 bounded Council prompt，再附加各自 focus instruction；focus 分别要求只返回一个不同的 marker。

## Fan-out registration

一次 `council-submit` 同时返回两个确定性成员 Task：

```text
workbuddy-live task = 131878fa-705d-8365-b63d-bfb08dd5c77c
opencode-live  task = c8daf681-3111-8703-94f2-d98db3323cd8
```

两者初始均为 `registered`，`registration_error=null`，Council 为 `running`。

真实执行中现有 overlapping-workspace lease 按设计继续生效：WorkBuddy 先完成时，OpenCode 仍为 `queued/submission=not_sent`；随后 OpenCode 获得 workspace lease、进入 `may_have_been_sent` 并完成。因此本验证证明 fan-out 是“不等待前一成员完成即可注册/调度”，不把共享 workspace 下的实际 provider execution 冒充成并行执行。

## WorkBuddy 成员

```text
task           = 131878fa-705d-8365-b63d-bfb08dd5c77c
status         = succeeded
submission     = sent
native session = 131878fa-705d-8365-b63d-bfb08dd5c77c
response       = WB-COUNCIL-DA9HQP
```

usage：

```text
input_tokens                = 24873
output_tokens               = 12
cache_creation_input_tokens = 1493
cache_read_input_tokens     = 23380
```

WorkBuddy runtime 报告模型标签 `auto`，继续按 backend-default / unverified 处理。

## OpenCode 成员

```text
task           = c8daf681-3111-8703-94f2-d98db3323cd8
status         = succeeded
submission     = sent
native session = ses_f73d5e40cffexq5hdhx1m8A20V
response       = OC-COUNCIL-T0NO45
```

usage：

```text
total      = 23509
input      = 18341
output     = 9
reasoning  = 39
cache read = 5120
```

## Fan-in result

两成员终态后：

```text
council-status = complete
```

`council-result` 一次返回两个 member，各自保留普通 Task status、native identity、response、usage 和 artifacts；没有 `summary`，也没有触发第三次模型调用。

## Idempotency 与 workspace

完成后用原始 `council.json` 再次执行同一个 `council-submit`：

```text
duplicate = true
status    = complete
```

两个成员 Task ID 与 Attempt 都保持不变，没有 launch 第二组 Worker，也没有新增 provider 请求。

测试 workspace 最终只包含预先创建的 `.keep`，两个 analysis/advisory-read-only 成员都没有创建或修改工作文件。

## 结论

当前源码的 First-class Council 已通过真实 WorkBuddy + OpenCode E2E：

- 一次 Council submit 能 fan-out 注册两个真实 Agent Task；
- 两个 Task 分别通过各自已有的 provider/native transport 完成；
- Council 状态从 `running` 聚合到 `complete`；
- `council-result` 能 fan-in 两个真实 response/usage，不额外调用模型做 synthesis；
- 同 Council 重提保持幂等，不重复发送；
- 共享 workspace 的现有 lease 边界保持不变，真实执行可以串行化。
