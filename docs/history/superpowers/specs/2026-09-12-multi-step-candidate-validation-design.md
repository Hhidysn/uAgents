# Multi-step Candidate Validation 设计

日期：2026-09-12。

## 目标

把现有 Council candidate 的单条本地 validation 扩展为一组**有序、命名、可比较**的本地 checks，例如 lint、typecheck、unit test、integration test、build。该能力继续只运行用户明确给出的本地 argv，不调用 Agent/provider，不自动发现测试命令，也不依据结果选择 winner。

## 向后兼容

现有 validation JSON 保持有效：

```json
{
  "schema_version": "1.0",
  "command": ["npm.cmd", "test"],
  "timeout_ms": 120000
}
```

该单步形式的 persisted evidence shape 也保持原样，避免破坏已经存在的 Council manifest 与调用方。

新增 multi-step 形式：

```json
{
  "schema_version": "1.0",
  "timeout_ms": 120000,
  "on_failure": "continue",
  "checks": [
    { "name": "lint", "command": ["npm.cmd", "run", "lint"] },
    { "name": "typecheck", "command": ["npm.cmd", "run", "typecheck"] },
    { "name": "test", "command": ["npm.cmd", "test"], "timeout_ms": 300000 },
    { "name": "build", "command": ["npm.cmd", "run", "build"] }
  ]
}
```

`command` 与 `checks` 严格二选一。multi-step 最多 16 个 checks；name 在同一 validation 内大小写不敏感地唯一。顶层 `timeout_ms` 是每个 check 的默认值，单个 check 可以覆盖。

## 执行语义

- checks 按声明顺序运行；
- 每个 `command` 都是直接 argv，`shell:false`；
- cwd 始终是该 Council member 的 effective worktree workspace；
- `on_failure:"continue"` 是默认值：某一步 `failed` / `timeout` / `error` 后继续收集后续证据；
- `on_failure:"stop"`：遇到第一个非 `passed` check 后停止执行，剩余 checks 持久化为 `outcome:"skipped"`；
- validation failure 仍是 evidence，不是 uAgents API error。

默认选择 `continue`，因为 Council 的主要价值是候选比较；完整 lint/typecheck/test/build 证据通常比 fail-fast 更有用。

## Evidence

multi-step 顶层 evidence 保存：

- `started_at_ms` / `finished_at_ms` / `duration_ms`；
- `on_failure`；
- aggregate `outcome`；
- 有序 `checks[]`。

每个已执行 check 保存：

- `name`；
- `command` / `timeout_ms`；
- started/finished/duration；
- `outcome` (`passed|failed|timeout|error`)；
- exit code / signal / error code；
- stdout/stderr（各最多 64 KiB）及 captured/truncated evidence。

未执行的 stop-tail check 保存相同静态 identity，但 `outcome:"skipped"`、时间为 null、duration 为 0、输出为空。

aggregate outcome 按证据强度归纳：有 `error` 则 `error`；否则有 `timeout` 则 `timeout`；否则有 `failed` 则 `failed`；全部执行成功则 `passed`。`skipped` 本身不覆盖触发停止的失败原因。

## 持久化与展示

和现有 validation 一样，每个 member 只保存 latest validation evidence；`council-status`、`council-result`、`council-diff` 直接返回它。第一版不引入 validation history 表，也不增加第二套执行引擎。

## 明确不做

- 不运行 shell command string；
- 不自动探测 package manager / test framework；
- 不自动生成 lint/typecheck/test/build 命令；
- 不并行执行同一 candidate 内的 checks；
- 不根据 checks 自动评分或选 winner；
- 不自动 adopt / merge / commit；
- 不发送新的 Agent/provider prompt。
