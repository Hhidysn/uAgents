# Multi-step Candidate Validation 验证

日期：2026-09-12。

## Provider-free contract 验证

覆盖：

- 旧 `{command,timeout_ms}` validation 继续解析并保留旧 evidence shape；
- 新 `checks[]` 最多 16 项、name 唯一、per-check timeout override；
- `command` / `checks` 严格二选一；
- `on_failure:"continue"` 在中间 check 失败后继续执行后续 check；
- `on_failure:"stop"` 把后续未执行 check 记录为 `skipped`；
- multi-step aggregate outcome；
- multi-step evidence 持久化并通过 `council-diff` 返回；
- CLI `schema council-validation` 暴露 legacy + multi-step contract；
- Unified MCP schema 与 Core 的 check 数量、timeout、on_failure 保持一致。

Targeted：

```text
Council + CLI   34/34
Unified MCP      10/10
```

## 真实既有 candidate 的零-provider 验证

复用此前真实 implementation Council：

```text
council_id = 8ce9f171-f3c6-4a87-9fc4-18c80614381f
```

没有向 WorkBuddy 或 OpenCode 发送新 prompt。对两个已存在 worktree 运行同一份三步 validation：

```text
result-file
result-token
candidate-isolation
```

WorkBuddy：

```text
overall              passed
result-file          passed -> workbuddy-result.txt
result-token         passed -> WB-WT-33146F15
candidate-isolation  passed -> isolated
```

OpenCode：

```text
overall              passed
result-file          passed -> opencode-result.txt
result-token         passed -> OC-WT-1B7E4A31
candidate-isolation  passed -> isolated
```

这证明 multi-step validation 可以直接作用于真实 Agent 曾产生的 candidate worktree，同时仍是纯本地 evidence collection。

## Provider 边界

本轮新增 provider-billable 调用为 **0**。`council-validate` 不发送 Agent prompt，也不根据 validation result 自动触发新的 Agent 调用。

## 完整回归

```text
Core                    310/310
Doubao MCP               11/11
TRAE MCP                  9/9
Unified MCP              10/10
Total                   340/340
```

完整回归前两轮都只命中既有 `OpenCode recovery discovers a delayed session without replaying the prompt` 的 10 秒 wall-clock timing 抖动；Multi-step/Council 新增测试均已通过。该 durable 文件随后隔离运行 4/4，未修改 OpenCode runtime 或该测试的等待窗口；最终重新执行完整 `npm test` 得到上面的 340/340。
