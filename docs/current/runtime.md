# 当前 Runtime 与生命周期

uAgents 使用统一 Task runtime 管理 CLI、SDK 和桌面 target。用户层面需要关注的是幂等、状态恢复、Agent 安装发现和受管实例生命周期。

## 幂等与发送状态

- 同一 UUID + 同一有效请求不会重复发送。
- 外部发送前持久化 `possibly_sent`。
- 一旦 prompt 可能已经发送但终态不确定，uAgents 不会自动换 UUID、模型或 Provider 重放。
- `status`、`result`、`list` 只读取本地持久化状态。

`result` 的 `evidence` 给出当前 Attempt 已存在的请求、回答、usage、diagnostics 或 stdout/stderr/exit 的本机绝对路径；没有证据时为 `null`。`diagnostics.native_exit_code` 只在已知时给出，不能把退出码 0 当作模型任务或研究成功。agy 保存有界、脱敏的诊断摘要，保留明确的原生错误原因、工具失败和请求/自报 effort，不保存完整工具参数；旧任务丢失的原生细节无法凭空补回。OpenCode 的工具失败也进入结果诊断，即使原生最终状态为成功。

agy 的 stderr 在完整捕获不超过 64 KiB 时先脱敏再取摘要尾部；超过该界限时省略整个尾部并记录 `stderr_truncated:true`。被拒绝会话的结果不提供原生状态或错误原因；诊断解析遇到缺失、格式错误或仅含外来会话的 transcript 时，`identity_verified` 保持 false。

`status/result.native_execution` 提供本机持久进程状态、工作区守卫状态、退出码和观察时间；`attempt=running/native=accepted` 不能证明实时存活。`released` 只针对该 Attempt，不证明整个项目没有其它执行者。OpenCode result 从至多 1 MiB 原 stdout 提取有界、脱敏的工具/原生错误及覆盖范围，超时也可显示；该诊断读取不改变生命周期、回复或模型核验，也不发送模型请求。

`native_outcome` 表示原生执行结果；`objective_verdict` 目前只覆盖原生状态和声明的输出文件检查，不验证来源是否实际读入、语义正确性或引用质量。调用方必须按任务验收要求单独判断。输出 token 可能包含推理和前序工具步骤，不等于最终回答字数。一个 uAgents Attempt 内，三方 CLI 仍可能自行重试 HTTP 请求；uAgents 的“不重放 prompt”不限制供应商内部重试。

## Agent 安装

```text
uagents ensure <target> [--refresh]
uagents probe <target>
uagents stop <target>
```

`ensure` 发现、验证并缓存本机 Agent 入口。CLI/SDK target 不需要 uAgents 自己安装 Provider；桌面 target 可以由 uAgents 使用专用 profile 启动或复用。

`probe` 不发送 Agent prompt。

普通 Task 的 `execution.observation_timeout_ms` 默认 1200000（20 分钟），可在 1000–3600000 范围内显式覆盖。`run --timeout-ms` 约束 CLI 等待；未指定时覆盖观察期限并增加 1 分钟收尾时间，至少等待 15 分钟（默认 21 分钟），不替代观察期限。观察超时对 agy 等每任务进程会停止本地进程，对 Windows 持久 OpenCode 和桌面轮询目标只停止观察，不能推断原生或 Provider 已取消。支持的目标可单独设置 `execution_timeout_ms`；该硬执行预算默认不启用。短 probe 与初始化握手的独立期限保持原设置。

## Resume / Reconcile

```text
uagents resume <task-id>
uagents reconcile <task-id>
```

这些命令用于恢复同一个 Task 的本地调度/观察，不会自动把原 prompt 再发一次。

OpenCode 在 Windows 上可以持久化 native process/transcript，并在 Worker 重启后继续观察。Observation timeout 或本地 observer cancel 不等于 Provider/native 已确认取消。

OpenCode V2 的 `reconcile` 可以通过原 Attempt 的 executable 执行只读 `session export`，补齐缺失的完成事件；不会执行 `run` 或重发 prompt。导出的原始上下文仅留在内存，不写入日志；身份、workspace、最终消息及文本必须与持久 transcript 对应。设置硬执行时限的 V2 新任务使用 `--standalone` 私有服务，避免只终止 CLI 后共享服务仍继续执行。旧共享服务任务的超时记录不会自动撤销。

Codex 的 Windows/Astra 显式 app-server 路线保存原生 Thread/Turn 与进程证据；Worker 失联后只读复查原 Turn，不自动重新发送 Prompt。原生历史不足以证明终态时保持 `indeterminate`。Codex 的执行权限仍由其原生配置控制。

## Workspace

- workspace 重叠任务受本地 lease/fencing 约束。
- implementation output 可以按 `expected_outputs` 捕获为 immutable artifacts。
- 附件 snapshot 与 artifacts 都记录 SHA-256 evidence。

## Desktop target

Doubao/TRAE 使用受管隔离 profile。uAgents 不自动登录、不接管用户日常窗口，也不会把未知进程当作自己的受管实例停止。

豆包发送前遇到阻挡输入的原生弹窗时记录 `waiting_user/native_dialog_required`。用户处理后可 `resume` 同一未发送 Attempt。已经可能发送的任务只对账，不重放。

TRAE 登录导致桌面进程重启时，只有旧 PID 明确消失、新进程更晚启动、安装路径及同一隔离 profile/CDP 参数一致，并通过两次稳定进程与监听身份核对，才更新原实例身份并保留网关。非阻塞性能通知不会触发审批等待；真实审批仍由用户处理，不能仅凭可变会话索引或相同提示自动覆盖旧审批状态。

TRAE 的受管桌面退出后，下一次 `ensure trae` 会在旧网关身份可验证、原生队列为空且本次使用的 Task 状态库中没有关联未决任务时清理伴随网关，再启动新一代实例。证据不足时保留旧网关，并把 `gateway_cleanup` 的跳过原因写入旧实例记录；如果旧网关仍可能运行，返回 `gateway_cleanup_deferred`，不启动新网关覆盖其共享 token。不会根据单独的 PID 杀进程。使用多个独立 `--state-dir` 时，未传入本次调用的其它 Task 状态库不在此检查范围内。

## 共享服务与并发

CLI、原 stdio MCP 和 HTTP 服务使用同一 Core；只有状态目录相同才共享 Task、Attempt 和 Council。HTTP 调用断开不取消已登记 Task，停止服务也不终止已启动的独立 worker；启动和恢复边界见 [共享本地服务](service.md)。

Worker 在取得任务与执行租约、认领原 Attempt 并启动续约心跳后，才加载目标适配器和初始化宿主控制面。重复 Worker 遇到已持有的任务租约时只返回当前状态；初始化失败由持有有效租约的 Worker 记录为 `queued/not_sent`、`worker_start_failed`，同时清除自身 Attempt 认领信息，修复安装后可 `resume` 原任务。初始化期间的取消在发送前确认，失去租约的旧 Worker 不能发送或覆盖新所有者的状态。

Council 的 submit、validate、adopt 和 cleanup 使用每 Council 的共享 SQLite lease/fencing，操作期间其它进程修改同一 Council 会遇到 `lease_conflict`。验证预算覆盖所有选中成员和命令；丢失响应后先查询已有证据并确认旧进程结束，再决定是否显式重试。

组件职责与持久化见 [当前架构](architecture.md)，安装见 [快速开始](quick-start.md)，仓库构建与检查见 [开发与验证](../development.md)。
