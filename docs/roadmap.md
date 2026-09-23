# uAgents 待实现功能

> 状态：规划 / 研究，**不代表当前已实现或已发布**。本文件与仅说明现有能力的 `docs/current/` 分开。基线为 2026-09-20 的 Codex CLI v1、GPT-5.6 Luna 安装版真实 E2E；后续以代码和当时验证结果为准。

## 准入与实施原则

- P0：安全会话、幂等发送及可恢复执行；P1：附件、进度、交互；P2：结构化工作流、诊断与新 Agent。
- 每项功能依次经历 `planned` → `prototype` → `provider-verified` → `released`，区分本地版本探测、模拟进程和真实模型请求；没有相应证据时不得开放 capability。
- 模型的 configured/admitted、native discovered、real-task verified、trusted native self-report 含义不同；任何一种证据都不自动替代另一种。
- 不自动登录、不放宽原生权限、不把不确定状态改写为成功、不自动重复已经可能发送的 Prompt。

## Codex CLI 后续主线

| 优先级 | 待实现能力 | 验收门槛 | 状态 |
| --- | --- | --- | --- |
| P0 | app-server 协议与传输兼容性验证 | 对本机版本做协议/Schema 检查、stdio 握手、模拟进程和真实只读 Turn；现有 `exec` 路线保持可用 | released（Windows/Astra 显式预览）：安装缓存版 CLI 四轮真实链路通过，默认 exec 保持不变；扩大适用范围仍需恢复矩阵 |
| P0 | 跨 Task `continue_from_task_id` | 校验源 Task、workspace、安装/线程身份与源 Turn 终态；新 Task 续接原线程；重复请求不重复发 Turn | released（Windows/Astra 显式预览）：安装版真实续接、来源分页复核及 CLI 入口/原生二进制指纹已通过；外部并发推进竞态和故障矩阵仍是后续限制 |
| P0 | 跨 Task `fork_from_task_id` | 源上下文边界明确、新原生 Thread ID、来源血缘持久化；新旧分支独立 | released（Windows/Astra 显式预览）：安装版从较早 Task fork 并续接分支；只读历史另确认旧 Turn 边界。故障矩阵仍需补齐 |
| P0 | 可靠取消、异常恢复与 reconcile | 保存 Thread/Turn/进程证据；发送后未知不自动重放；中断回执不误当作已终止 | prototype：进程身份与子进程树 guard 已接入并完成 Astra 验证；一次真实中断经只读查询恢复为 cancelled；三个 Worker 崩溃窗口通过跨进程 fixture。项目分页明确不支持时可回退到完整 Turn 历史，原生完整性不足仍保持不确定。极早中断的真实空 rollout 经 `thread/read` 和 `thread/turns/list` 复查均不可读，同一已接受 Turn 保持 indeterminate 且不重发；完整故障矩阵待做 |
| P1 | 原生图片输入 | 使用现有附件哈希快照、类型和路径检查；按模型及传输验收真实图片 E2E | planned |
| P1 | 增量进度、工具事件 | 文件变更、命令、计划及用量的有界持久化与分页；去重、脱敏 | planned |
| P1 | 原生审批结果识别 | 保留 Codex 自身权限设置；交互审批无法由非交互传输完成时，记录不确定状态且不代答、不重发 | released（Windows/Astra 显式预览）：已移除 uAgents 的 Codex 审批代理；安装版夹具验证 `native_approval_required`、零审批响应和不重发，真实普通任务通过。真实 Provider 审批请求尚未在简化构建中复测 |
| P2 | JSON Schema 结构化输出 | 原生约束 + 本地复验，Schema 不通过不伪装目标成功 | planned |
| P2 | Code Review 模式 | 限定 diff/commit/base，结构化 findings 与可复核位置，不自动选 Council winner | planned |
| P2 | 模型与登录/额度诊断 | no-prompt 证据与真实任务可用性分离，不把版本 probe 当成 provider 验证 | planned |

实现设计见 [Codex CLI v2 提案](history/superpowers/specs/2026-09-20-codex-cli-v2-design.md)；已撤回的审批代理方案留在[历史草案](history/superpowers/specs/2026-09-24-codex-app-server-approval-design.md)。实验见 [2026-09-23 续接/fork 验证记录](verification/2026-09-23-codex-session-prototype.md)及 [app-server 验证记录](verification/2026-09-23-codex-app-server-spike.md)。当前已发布能力见 [Agent 能力矩阵](current/agents.md)。

## 已接入 Agent 的能力补充

| Target | 研究或实施方向 | 开放条件 |
| --- | --- | --- |
| `agy` | 图片/文件输入、原生续接、更多真实模型路线 | 根据原生版本及模型逐一验证，不把 catalog 当 E2E |
| `workbuddy` | 通用文件附件、其它模型的图片能力、异常会话恢复 | 不把已验收 `deepseek-v4.1-flash` 的图片能力扩展到所有模型 |
| `dsh` | SDK 文件/图片映射、会话续接、模型诊断 | 明确 SDK 语义并做真实多轮/附件验收 |
| `opencode` | 实时工具事件、审批、usage 和故障恢复对照 | 复用现有 durable runtime，避免平行状态机 |
| `doubao` | 结果提取、登录/额度状态、实现模式可行性 | 先保证桌面目标身份和用户审批可靠 |
| `trae` | 多模态附件、会话续接、等待态/额度诊断 | 保持受管实例隔离，核对原生会话身份 |

## 未来新增 Agent（尚未接入）

### Claude Code — research

- 比较官方 CLI 非交互/流式接口与 Agent SDK；核对模型选择、认证、原生会话 ID、resume/fork、审批、工具事件和 usage。
- 首个里程碑仅考虑 `text + workspace + 显式已验收模型`：模拟进程 → 用户授权的真实只读 E2E → 安装版回归。文件/图片与续接单独验收。
- 不读取或改写用户凭证，不无提示提升原生权限。

### Pi Agent（pi-mono / `@mariozechner/pi-coding-agent`）— research

- 独立比较 CLI RPC（stdin/stdout 的隔离子进程）与 Node SDK（进程内 AgentSession）的故障边界、资源所有权与恢复能力。
- 验证 provider/model 精确映射、认证、RPC 事件、会话树与 fork、扩展工具权限；多 provider 可配置不等于存在可用的通用模型路由。
- 不把 `--no-session` 一次性调用视作可持久续接的证据，也不假定 Pi 树节点与 uAgents Task 一一对应。
- 第一阶段只开放真实验收的 text + workspace 和具体模型，多模态与续接独立推进。

## 公共平台方向

- 统一 Task/Attempt 状态机、幂等性、失败类别及 reconcile；保留各原生传输不同的可靠性证据。
- 统一事件分页、背压、大小限制、敏感信息脱敏；模型自评不能代替客观测试结果。
- 用户明确发起权限决策并保存审计记录；Council 交叉审查和测试证据不能自动触发 winner、merge 或 adopt。

## 实施前复核资料

- Codex 非交互模式：https://developers.openai.com/zh-Hans/docs/non-interactive-mode
- Codex app-server：https://developers.openai.com/zh-Hans/docs/app-server
- Pi SDK：https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/sdk.md
- Pi RPC：https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/rpc.md
