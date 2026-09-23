# Codex CLI 后续功能设计（v2 提案）

日期：2026-09-20。状态：**设计提案，尚未实现**。本文件解释下一阶段可能的协议和持久化方向；当前能力以 `docs/current/` 和 CLI discovery 为准。

2026-09-23 实施补充：先在现有 exec transport 中完成了 `resume/fork` 的候选桥接与无 Provider 的真实子进程多轮 fixture，见 [验证记录](../../../verification/2026-09-23-codex-session-prototype.md)。由于真实 Luna 新建 Turn 命中额度限制，跨 Task 会话能力**尚未开放**；app-server、强恢复和审批仍属后续独立设计。

2026-09-23 后续进展：app-server 内部路径、持久化传输选择、标准 Worker 的真实 Astra 多轮及崩溃恢复夹具已完成，详见 [app-server 验证记录](../../../verification/2026-09-23-codex-app-server-spike.md)。本文件其余内容仍是原始设计提案；公开 capability 与已安装插件尚未切换。

## 1. 已验证基线、目标与非目标

当前 v1：`target=codex`，显式 `gpt-6-astra` 或 `gpt-5.6-luna`；`exec --json`、text + workspace、analysis/implementation、最终 assistant text、usage 和 native Thread ID。Luna 已通过安装版真实 `submit/result` E2E；`gpt-6-astra` 是准入配置，不代表已完成 provider-bearing 验收。原生图片、跨 Task continuation/fork 和可证明的进程树取消/恢复仍未开放。

目标是在保留已工作的 exec 路径下，逐步支持原生会话、增量事件、图片、权限审批和异常恢复。不替用户登录、改全局原生配置、自动接受审批、不声称取消请求等于远端 Turn 已结束，也不为可能已发送的 Prompt 偷偷建立新 UUID 重试。

## 2. 双传输架构

```text
uAgents CLI / Unified MCP
  -> policy / normalized request / idempotency
  -> TaskService / Attempt / possibly_sent checkpoint / HostStore
  -> CodexAdapter
       |-- ExecTransport       (v1; one-turn JSONL; retained)
       `-- AppServerTransport  (v2; opt-in until verified)
             -> local stdio JSON-RPC
             -> Thread / Turn / Events / Approval journal
             -> native read / resume / fork / interrupt
  -> response / usage / events / artifact verification
```

- 保留 `exec --json` 的已验收行为、argv、显式模型路由和取消语义；新 transport 不通过失败后的隐式 exec fallback 重发 Prompt。
- 优先使用本机 Codex 版本提供的 app-server 协议/Schema 检测 `initialize` → `initialized`，未验证前不打开 experimental API。检查 `thread/start`、`thread/resume`、`thread/fork`、`thread/read`、`turn/start`、`turn/interrupt` 与增量 `item/*` 的当版入参与返回值；版本不兼容时失败封闭。
- 进程控制分清 npm JS launcher 与 native descendant：记录经验证的进程身份，不能仅凭 launcher 的 close/kill 声称全部子进程和远端 Turn 已停止，也不按进程名全局 kill。
- 不预先决定 app-server 常驻还是 Task 级进程；须以 Windows 进程隔离、断线恢复、并发及安装指纹为依据作 spike。

## 3. Task、Thread、Turn、Session 身份

一个 uAgents Task 代表一条用户请求；Task/Attempt **不等于**原生 Thread/Turn。一个 Thread 可以依次容纳多个成功登记的 Task；fork 创建新 Thread，父子血缘单独记录。

建议复用或扩展已有原生身份存储（迁移前先审查 SQLite schema）：

```text
native_binding:
  task_id, attempt_id, target='codex', transport='app-server'
  native_thread_id, native_turn_id?, source_task_id?, fork_from_task_id?
  canonical_workspace_identity, native_installation_identity
  model_requested, model_resolved, source_completion_checkpoint
  thread_created_at, turn_started_at, last_native_event_cursor?
```

- `continue_from_task_id`：来源 Task 在调用方可访问状态空间、target 正确、Thread 身份可信、workspace canonical identity 相同；源 Turn 必须有可靠终态且无未决发送；`thread/resume` 之后由**新 Task** 发出自己的 `turn/start`。
- `fork_from_task_id`：校验相同的来源权限/工作区，选择已完成 Turn 的上下文边界；`thread/fork` 必须得到与源不同的新 Thread ID，再在新 Thread 上提交新 Task。不得默认临时 fork，也不能让来源 Task 与新 Task 共用相同幂等身份。
- 同一原生 Thread 上的 Turn 串行化，并用租约/fencing token 约束多个 worker；不同分支独立，但同一 workspace 的实现操作仍服从现有 workspace lock。
- 原生安装/协议身份变化或 `thread/read` 无法核实来源时失败封闭；不能因为保存过一个 Thread ID 就认为所有历史线程可安全继续。exec/app-server 是否可跨传输继续，要另做真实兼容性测试。

## 4. 发送边界、取消与故障恢复

1. 注册 Task 并验证模型、workspace、源会话、权限及幂等指纹。
2. 取得 Task/Thread 级租约；持久化可能已发送的 checkpoint、目标 Thread 和发送意图，**然后**才调用 `turn/start`。
3. 保存 JSON-RPC request ID、Turn ID、原生事件和 checkpoint；仅相同 Turn 的可信终态可确定 native outcome。
4. 连接丢失、进程退出或发送回执未知时，先尝试有身份约束的 `thread/read` 或可信事件核对。无法证明“未发送”或定位 Turn 时保留 `unknown`，禁止重放；绝不因为新 app-server 已启动而当作新任务发送。
5. `cancel` 首先写入取消意图；已知 Turn ID 时尝试 `turn/interrupt`，仅权威终态确认后认定已中断。无回执或仅有 interrupt 请求确认时仍保留不确定性。
6. 释放租约、保存最终文本/usage/文件产物；区分 native success 与客观目标验收失败。

**不承诺 exactly-once**：`thread/read` 能否覆盖每个丢回执场景需要断线矩阵验证。此前已发送任务的状态未知时，恢复 API 不能偷偷开启新 Turn。

## 5. 事件、进度、用量

建议标准事件：`thread_started`、`turn_started`、`assistant_delta`、`command_started/completed`、`file_change`、`plan_updated`、`usage_updated`、`approval_requested/resolved`、`turn_completed/failed/interrupted`。

- 记录来源事件类型及 Thread/Turn/Item identity，拒绝错线程、错轮次事件污染当前 Task。
- 事件保持顺序、有界持久化和分页游标；重连或事件重传按原生 ID/位置去重，最终文本与 delta 不重复拼接。
- 对 stdout/stderr、文件 diff 和工具参数限额、脱敏；不持久化凭证、全部环境变量或隐藏推理。
- `model_reported` 仅由可信的 native actual-model 字段提供；显式模型参数、成功 Turn 或模型自身回复都不能替代原生模型身份报告。

## 6. 图片、审批、结构化输出与 Code Review

**图片**：先使用已有附件快照，复核 MIME、大小、内容哈希及 workspace 内路径；检查真实 app-server `turn/start` image input Schema 后映射。exec 的 `--image` 可独立做兼容性原型，不跨 transport 猜测参数。按 `model + transport` 真实 Luna 图片 E2E 后才开放 images；文件 native attachment 继续关闭直至独立验收。

**审批**：app-server server-initiated approval 需绑定 request/thread/turn/item，持久化待决状态、用户决策与超时。无交互宿主保持等待或拒绝，不自动 `accept` / `acceptForSession`、不静默提升网络/沙箱权限。客户端重连后必须复核待审批请求仍有效，不响应过期按钮。`analysis` 不代表底层被强制只读。

**结构化输出**：exec 的 `--output-schema` 独立评估；app-server 依当版 Schema 验证等效能力。原生输出后仍做本地 JSON Schema 校验，不把结构正确或模型自述当客观事实。

**Code Review**：研究原生审查路径，明确 diff/base/commit 和只读审查范围；finding 带文件/位置证据。即使进入 Council，也不自动决定 winner 或 adopt。

## 7. 渐进实施与测试门槛

| 阶段 | 交付物 | 核心验收 |
| --- | --- | --- |
| 0 | 本机 app-server Schema/版本探针 | 无 Prompt 协议握手、方法缺失/版本不兼容时失败封闭、旧 exec 回归 |
| 1 | AppServerTransport 单 Turn fixture | 真实本地子进程 stdio JSON-RPC、Thread/Turn ID、事件顺序、异常退出；无 Provider 费用 |
| 2 | 只读 Luna E2E + continue / fork | 初始、继续、fork 三个独立 Task；身份、血缘正确，fork Thread 不同，无重复 Prompt |
| 3 | crash/restart/reconcile/cancel | 发送前/中/后断线、重复 UUID、并发、限流、子进程未退出、interrupt 无回执 |
| 4 | 图片与事件 API | 真实图像理解，路径/哈希复核，事件去重/脱敏/分页 |
| 5 | 审批、Schema、Review | 接受/拒绝/超时、无 UI 情况、Schema 失败、findings 位置证据 |

各阶段需 Adapter 与 TaskService 单测、Windows 真实子进程 fixture、安装版 smoke；发布模型、多模态或会话能力前取得明确授权的真实 Provider E2E。未完成之前保留 `resume=false`、`fork=false`、`images=false` 等关闭状态。

## 8. 实施前待确定

- 使用 exec 原生 resume/fork 做短期桥接，还是直接 app-server？比较开发量、可恢复性、审批及身份映射。
- app-server 常驻多 Thread 或单 Task 进程？比较生命周期、进程树、并发和隔离。
- `thread/read` 对不确定发送/中断能提供多少权威证据？不足时保持 `unknown`。
- app-server 与 exec 会话存储是否有经验证的双向兼容性？未确认时禁止跨传输续接。

## 资料

- Codex 非交互模式：https://developers.openai.com/zh-Hans/docs/non-interactive-mode
- Codex app-server：https://developers.openai.com/zh-Hans/docs/app-server
- 本仓库现有证据：[Codex process hardening](../../../verification/2026-09-20-codex-process-hardening.md)、[Luna installed E2E](../../../verification/2026-09-20-codex-luna-installed-e2e.md)
