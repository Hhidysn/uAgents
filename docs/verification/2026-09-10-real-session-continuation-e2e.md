# Native Session Continuation 实机 E2E

日期：2026-09-10。范围：当前仓库源码 `F:\documents\software\uAgents`，使用独立测试 state dir 和测试
workspace；不使用旧安装 cache 作为实现来源。

本验证在用户明确授权 provider-billable E2E 后执行。四次真实请求全部使用 `mode=analysis`、
`permission=advisory-read-only`，没有声明输出文件，没有使用 `--auto`、权限 bypass 或其他自动授权参数。

## 验证方法

每个目标执行两轮：

1. 第一轮发送一个只在该轮 prompt 中出现的随机 marker，并要求精确 ACK。
2. 第二轮使用新的 uAgents Task UUID，通过 `session.continue_from_task_id` 指向第一轮；第二轮 prompt **不包含 marker**，
   只问“上一轮让我记住的 marker 是什么”。
3. 验收第二轮 native session id 与第一轮一致，并且第二轮返回正确 marker。

这可以区分 native session continuation 与“uAgents 把旧 prompt 再拼一遍发送”：当前实现不会把第一轮 prompt、response
或 marker 注入第二轮请求。

## WorkBuddy

第一轮：

- uAgents Task: `fc71c8a0-acca-4bfc-a5ee-7d9a9ed98597`
- native session: `fc71c8a0-acca-4bfc-a5ee-7d9a9ed98597`
- result: `succeeded`
- response: `ACK WB-CONT-9X2M7Q`
- native model report: `auto`（仍按 backend-default / unverified 处理）
- usage: input `24861`, output `13`, cache creation input `22237`, cache read input `2624`

第二轮：

- uAgents Task: `fb554a1a-2c19-4461-80fb-c6615059ff2b`
- `continue_from_task_id`: `fc71c8a0-acca-4bfc-a5ee-7d9a9ed98597`
- native session: `fc71c8a0-acca-4bfc-a5ee-7d9a9ed98597`
- result: `succeeded`
- response: `WB-CONT-9X2M7Q`
- usage: input `49892`, output `25`, cache creation input `22436`, cache read input `27456`

结论：第二轮复用第一轮 native session，且在第二轮 prompt 未出现 marker 的情况下正确恢复上一轮上下文。

## OpenCode

路由：`commandcode-goat/deepseek/deepseek-v4-flash`。

第一轮：

- uAgents Task: `05ae2fd2-00a4-4ee7-b750-0aea635baa5c`
- native session: `ses_f7892de20ffehTk0a7kxUnlqmZ`
- result: `succeeded`
- response: `ACK OC-CONT-4K8P3R`
- usage: total `23569`, input `18268`, output `12`, reasoning `41`, cache read `5248`

第二轮：

- uAgents Task: `3ade39cb-964b-40e3-93e3-17c7af0f3830`
- `continue_from_task_id`: `05ae2fd2-00a4-4ee7-b750-0aea635baa5c`
- native session: `ses_f7892de20ffehTk0a7kxUnlqmZ`
- result: `succeeded`
- response: `OC-CONT-4K8P3R`
- usage: total `23811`, input `248`, output `11`, reasoning `0`, cache read `23552`

结论：第二轮通过 OpenCode native `--session <id>` 继续第一轮 session；native event identity 与指定 session 一致，
且上下文恢复成功。

## 调用安全记录

实机过程中 devspace 工具通道曾在 submit 返回前断开。每次都先用同一 UUID 查询本地状态；只有明确得到
`task_not_found` / `submission=not_sent` 后才重新 submit，没有用新 UUID 猜测重试。WorkBuddy 初次测试还因测试
workspace 尚未创建而被 Core 以 `invalid_workspace` 拒绝，明确为 `submission=not_sent`，随后创建 workspace 后才执行
真实调用。

## 结论

当前源码的 WorkBuddy 与 OpenCode native session continuation 均通过真实 provider 两轮 E2E：

- 新 uAgents Task / Attempt 能继续旧 native session；
- 第二轮不会依赖 uAgents 重放历史；
- WorkBuddy 与 OpenCode 都保持第一、二轮相同 `native.session_id`；
- 两家第二轮都正确恢复仅在第一轮出现的 marker。
