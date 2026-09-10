# First-class Council 设计

日期：2026-09-10

## 目标

把“向多个 Agent 发同一份有界 brief，再聚合状态/结果”变成 uAgents 的一等编排能力，同时保持每个成员仍然是普通 Task。

Council 不新增第二套执行引擎、Attempt、native session 或 artifact 模型。它只持久化一个 Council manifest，记录成员与确定性 Task UUID 的关系。

## 第一版范围

- 仅 `analysis`。
- 至少 2 个、最多 16 个成员。
- `strategy=fanout`：一次注册并启动所有成员，不等待前一个成员完成。
- 顶层共享 `prompt`、`workspace`、`inputs` 和只读评审常用 execution 参数。
- 每个成员选择 `target`、`model`、可选 `instruction` 和可选已有 Task session selector。
- `council-status` 聚合普通 Task 状态。
- `council-result` 原样聚合 response / usage / artifacts，不自动投票、不额外调用模型总结。

## 请求契约

```json
{
  "schema_version": "1.0",
  "council_id": "<uuid>",
  "strategy": "fanout",
  "prompt": "Review this change.",
  "workspace": "F:\\project",
  "execution": {
    "effort": "medium",
    "permission": "advisory-read-only"
  },
  "members": [
    {
      "member_id": "workbuddy-architecture",
      "target": "workbuddy",
      "model": "default",
      "instruction": "Focus on architecture and missing edge cases."
    },
    {
      "member_id": "opencode-implementation",
      "target": "opencode",
      "model": "commandcode-goat/deepseek/deepseek-v4-flash",
      "instruction": "Focus on implementation feasibility."
    }
  ]
}
```

成员 Task 固定为 `mode=analysis`、`fallback=none`、`max_cost_usd=null`。默认 permission 为 `advisory-read-only`。

## Identity / idempotency

`council_id + member_id` 通过 SHA-256 派生确定性 UUIDv8，作为成员 Task 的 `request_id`。

因此：

- 相同 Council request 重提不会创建第二组 Task。
- 同一 `council_id` 内容变化返回 `request_conflict`。
- 即使一次 fan-out 只注册了部分成员，再提交同一个 Council 也只会补/复用同一组 Task ID。

## Session

成员可以使用现有 `continue_from_task_id` 或 `fork_from_task_id`。仍受普通 Task 的 same-target / same-workspace 规则约束。

Native session 不能跨 target 共享。因此 WorkBuddy 的 native context 不能直接 fork 给 OpenCode；跨 target Council 共享背景依靠顶层 prompt / attachments。

## 并发语义

`fanout` 表示 uAgents 不等待成员完成就注册/启动下一成员。它不承诺所有 provider 同时执行。

当前 workspace lease 对重叠 workspace 仍是排他的，因此多个成员读取同一 workspace 时可能被 runtime 串行化。第一版不为了 Council 放松现有 workspace ownership 规则。

后续如果需要真正并行：

1. analysis 可设计 shared-read lease；或
2. implementation Council 使用独立 Git worktree。

## 非目标

- 不支持 Council implementation。
- 不自动合并代码。
- 不自动投票或让第三个模型总结。
- 不自动 fallback / retry provider。
- 不新增权限沙箱。
- 不因为 Council 自动产生 provider-billable E2E；真实调用仍需用户明确授权。
