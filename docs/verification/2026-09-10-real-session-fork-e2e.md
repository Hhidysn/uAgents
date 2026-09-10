# Native Session Fork 实机 E2E

日期：2026-09-10。范围：当前仓库源码 `F:\documents\software\uAgents`，使用独立测试 state dir 与空测试
workspace；不以旧安装 cache 作为实现来源。

本验证在用户明确授权 provider-billable fork E2E 后执行。四次真实请求全部使用 `mode=analysis`、
`permission=advisory-read-only`，没有声明输出文件，没有使用 `--auto`、权限 bypass 或其他自动授权参数。

## 验证方法

WorkBuddy 和 OpenCode 各执行两轮：

1. 父 Task 发送一个只在该轮 prompt 中出现的随机 marker，并要求精确 ACK。
2. fork Task 使用新的 uAgents UUID，通过 `session.fork_from_task_id` 指向父 Task；fork prompt **不包含 marker**，
   只要求回答父会话中记住的 marker。
3. 验收 fork Task 能正确恢复 marker，同时其 `native.session_id` 必须与父 Task 不同。

这样同时验证了 native branch 的上下文继承和新 session identity，而不是只验证 CLI argv 中出现了 fork flag。

## WorkBuddy

父 Task：

- uAgents Task: `066ebc69-87b3-4c16-b289-33c15d2e0477`
- native session: `066ebc69-87b3-4c16-b289-33c15d2e0477`
- result: `succeeded`
- response: `ACK WB-FORK-7R2N5M`
- native model report: `auto`（仍按 backend-default / unverified 处理）
- usage: input `24882`, output `13`, cache creation input `24690`, cache read input `192`

fork Task：

- uAgents Task: `bb8884f8-c158-4316-8aaf-f3f283e70c58`
- `fork_from_task_id`: `066ebc69-87b3-4c16-b289-33c15d2e0477`
- native session: `191158e0-1bd7-4fcd-9ae2-82e4f9ce7063`
- result: `succeeded`
- response: `WB-FORK-7R2N5M`
- usage: input `49948`, output `25`, cache creation input `49756`, cache read input `192`

父 session 与 fork session 不同，且 fork prompt 未包含 marker 仍恢复正确上下文。当前 WorkBuddy mapping
`--resume <source-session> --fork-session` 因而通过真实 provider E2E。

## OpenCode

路由：`commandcode-goat/deepseek/deepseek-v4-flash`。

父 Task：

- uAgents Task: `4b58a656-036d-4b31-bb3b-8357000fa4c2`
- native session: `ses_f74380eb8ffeI6CEdUdNF1h9nC`
- result: `succeeded`
- response: `ACK OC-FORK-6K9Q4T`
- usage: total `23524`, input `19618`, output `12`, reasoning `54`, cache read `3840`

fork Task：

- uAgents Task: `02cd35f7-9ca2-4cd6-ac9f-13bbcc80d90c`
- `fork_from_task_id`: `4b58a656-036d-4b31-bb3b-8357000fa4c2`
- native session: `ses_f743772ecffep1YX4fiCdJEzSv`
- result: `succeeded`
- response: `OC-FORK-6K9Q4T`
- usage: total `23724`, input `289`, output `11`, reasoning `0`, cache read `23424`

父 session 与 fork session 不同，且 fork prompt 未包含 marker 仍恢复正确上下文。当前 OpenCode mapping
`run --session <source-session> --fork ...` 因而通过真实 provider E2E。

## 调用与 workspace 记录

第一次 WorkBuddy submit 使用了相对 `--state-dir`，Core 在本地以 `invalid_workspace` 拒绝并明确
`submission=not_sent`。随后使用绝对 state dir 并复用同一个 UUID；没有因为该本地错误创建额外 provider 调用。

两家测试 workspace 在四次真实请求结束后仍为空，没有 Agent 创建或修改文件。所有请求均为
`analysis + advisory-read-only`。

## 结论

当前源码的 WorkBuddy 与 OpenCode native session fork 均通过真实 provider E2E：

- 新 uAgents Task 能从 finished source Task 的 native conversation 创建分支；
- fork Task 的 native session identity 与 source session 不同；
- fork prompt 不包含父 marker 时，两家目标仍能恢复父会话上下文；
- uAgents 没有把父 prompt/response/history 拼入 fork prompt。

本次真实验证只覆盖 source -> fork 两轮。fork branch 后续 continuation 已由 provider-free runtime fixture
覆盖；若未来需要额外实机证明 branch 后续多轮，可单独做最小第三轮验证。
