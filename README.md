# uAgents

uAgents 是供 Codex 使用的本地统一 Agent 调度插件。当前发行标识为
`0.2.0-alpha.1+codex.20260907011733`，把 agy/Gemini、WorkBuddy、OpenCode、豆包工作和
TRAE CN 接到同一套请求、能力、任务状态、结果、错误和产物协议，同时明确保留各目标不同的
模型、文件、权限、取消和桌面连接能力。

先看：[Session Continuation 当前状态](docs/status/2026-09-10-session-continuation-current.md) · [Universal Attachment 当前状态](docs/status/2026-09-09-universal-attachment-current.md) · [文档索引](docs/README.md)

> 重要边界：OpenCode 现在支持文本 `analysis` 和 `implementation`，并把声明式文件/图片输入映射为原生附件；
> WorkBuddy 也通过其已核实的 stream-json `document` / `image` block 接入文件和图片。WorkBuddy 与 OpenCode
> 现在都支持显式多轮 continuation：每一轮仍是新 Task，但可以引用上一 Task 的 native session。agy 当前只有 workspace
> 可读性，没有可验证的 native attachment mapping，也没有已映射的 session continuation。
> uAgents 负责请求、工作区、生命周期和产物验收，不提供执行沙箱；OpenCode 的原生行为通过
> `execution.native_args` 控制。

核心特性：

- 一个 `agent-dispatch` Skill、一个本地优先 CLI、一个可选 stdio MCP Server，共用同一 Node.js Core。
- SQLite WAL 控制面；Task、Attempt、Native Process、Native Session 分离；同 UUID 与同一有效请求不会重复发送。
- 每次调用记录 `model_requested`、`model_resolved`、`model_reported`、`model_verified`，不把配置选择冒充运行期验证。
- `model_resolved` 保存规范模型名，完整 Provider/Model 运输路线单独保存在 `route_id`。
- 原生失败以脱敏结构化错误返回；Provider 响应头、响应体和凭据内容不会写入任务记录。
- 本地 uAgents CLI、后台 Worker 和受信任的 Agent CLI 逐层继承调用终端环境，使任意 Provider 的环境变量凭据无需硬编码即可使用；环境内容不会进入请求、SQLite 或结果。
- 外部发送前持久化 `possibly_sent`；发送后不确定状态不自动换 UUID、模型或 Provider 重放。
- workspace 重叠租约、fencing token、统一附件快照（类型/MIME/尺寸/字节数/SHA-256）、不可变产物捕获与 SHA-256 验证。
- 附件既可继续用 workspace 相对 `{type,path}`，也可用绝对本地 `{type,source}`；submit 会把外部文件归一化到 workspace 的 `.uagents/inputs/` 后复用同一附件链路。
- WorkBuddy/OpenCode 支持 `session.continue_from_task_id`：新 Task 可以把新 prompt 发送到上一轮已持久化的 native session，而不是重放历史 prompt。
- `status`/`list` 只读本地状态；只有显式 `reconcile`（或针对已有 durable process 的 `resume`）才恢复已有原生执行观察，绝不重发原 prompt。
- 受管生命周期：`submit` 自动发现、验证并缓存本机入口；豆包/TRAE 在专用隔离 Profile 中自动启动并跨 Task DB 用 Host lease 防双开；首次登录后同 UUID `submit` 或 `resume` 在原 Attempt 上恢复；`stop` 只停止所有权证据完整的实例。
- 资源冲突时有界排队；未发送任务可用同 UUID 恢复，任务租约和原子 Attempt claim 防止重复发送。受管桌面恢复绑定原实例，`advisory-read-only` 会传递只读提示并关闭 WorkBuddy 隐式编辑自动接受。

## 目标能力速览

| 目标 | 模式 | 输入 / 输出 | 当前关键边界 |
| --- | --- | --- | --- |
| agy | `analysis`、`implementation` | 文本 / 文本 + 文件 | workspace 可读但无 native file/image attachment mapping；模型必须显式指定；分析模式不是硬只读 |
| WorkBuddy | `analysis`、`implementation` | 文本 + 文件 + 图片 / 文本 + 文件 | 文件和图片通过已核实的 stream-json inline attachment block；follow-up 通过 native `--resume <session-id>`；模型由后端决定；分析模式不是硬只读 |
| OpenCode | `analysis`、`implementation` | 文本 + 文件 + 图片 / 文本 + 文件 | 文件/图片通过 native `--file`；follow-up 通过 `run --session <session-id>`；Windows 当前源码使用 durable process/transcript，并支持 verified `execution_timeout_ms`；仅两条显式 Command Code Flash 路线 |
| 豆包工作 | `analysis` | 文本 / 文本 | 无文件/图片；无已确认原生取消；不回显可验证模型；受管桌面实例 |
| TRAE CN | `analysis`、`implementation` | 文本 / 文本 + 文件 | 不接受显式文件输入；无图片、无已确认原生取消；模型不可靠回显；受管桌面实例 |

`implementation` 与 `workspace-write` 不是同一件事：前者表示目标允许调用其原生编辑流程，后者要求
uAgents 自身强制工作区写入边界。`execution.permission` 为 Schema 1.0 兼容字段，不再作为能力准入门槛；
需要的原生审批或执行行为应通过目标自己的 `execution.native_args` 配置。当前 uAgents 不提供执行沙箱，
因此不能把产物校验当成安全隔离。

当前附件能力、已安装 cache 与源码工作树的边界、验证证据及待补齐项见
[Universal Attachment 当前状态](docs/status/2026-09-09-universal-attachment-current.md)。

## 使用

本地 Codex 默认直接运行 CLI。插件根目录取当前安装版本中包含 `skills/agent-dispatch` 的目录，不要把缓存版本号写死。CLI 使用相同 Core，默认状态目录是 `%LOCALAPPDATA%\uAgents\v1`：

```powershell
node "<plugin-root>\bin\uagents.mjs" targets
node "<plugin-root>\bin\uagents.mjs" capabilities opencode
node "<plugin-root>\bin\uagents.mjs" models opencode
node "<plugin-root>\bin\uagents.mjs" submit --request "F:\path\request.json"
node "<plugin-root>\bin\uagents.mjs" submit --request-stdin
node "<plugin-root>\bin\uagents.mjs" status <task-id>
node "<plugin-root>\bin\uagents.mjs" result <task-id>
```

`submit` 必须且只能选择 `--request FILE` 或 `--request-stdin`。stdin 适用于调用方可以把输入与命令文本分离的场景；不要把 prompt 或完整 JSON 放入进程参数。

附件输入有两种等价入口：已有的 `{"type":"file","path":"requirements.md"}` / `{"type":"image","path":"assets/screenshot.png"}` 直接引用 workspace 内文件；新的 `{"type":"file","source":"F:\\Downloads\\brief.pdf"}` / `{"type":"image","source":"F:\\Downloads\\screen.png"}` 可直接引用 workspace 外的绝对本地路径。`source` 会在注册前复制为 `.uagents/inputs/...` 下的 workspace-relative attachment；后续 snapshot 和 target mapping 与 `path` 输入完全共用。

WorkBuddy/OpenCode 的下一轮对话仍然 submit 一个新的请求和新的 UUID，只需增加：

```json
"session": { "continue_from_task_id": "上一轮-uAgents-task-uuid" }
```

source Task 必须已经结束，并与新 Task 使用同一个 target 和 workspace。uAgents 只读取上一 Task 已持久化的 native session id；不会把旧 response/history 拼回 prompt。这里的 `session.continue_from_task_id` 是“发送下一条消息”，而 `resume <task-id>` 仍然只是恢复/观察同一个已有 Task，不会发送新 prompt。

受管生命周期命令（Host 状态固定在 `%LOCALAPPDATA%\uAgents\host-v1`，不受 `--state-dir` 影响）：

```powershell
node "<plugin-root>\bin\uagents.mjs" ensure <target> [--refresh]
node "<plugin-root>\bin\uagents.mjs" resume <task-id>
node "<plugin-root>\bin\uagents.mjs" stop <target>
```

`ensure` 发现、验证并缓存安装；对桌面目标启动或复用专用实例，但不发送 Prompt。`probe` 保持只读、不启动。`resume` 可恢复无活跃 Worker 的 `registered/queued` 未发送任务，或发送前登录等待，均沿用原 Attempt；对于已经存在 durable native process 的非终态 OpenCode Task，`resume` 会转入同 Attempt reconcile，只读取 process/transcript 并继续观察，绝不重新发送 prompt。`reconcile` 同样不会自动使用 OpenCode `--session`/`--continue` 续写会话。durable OpenCode 的取消或 observation timeout 只结束当前观察，不代表 native process 已取消；workspace guard 会保留到死亡/静默得到证明。Windows 当前源码的 `execution_timeout_ms` 使用两个独立 detached guardian、短 TTL fenced claim、PID/start-time/executable ownership 与 process-tree quiescence 执行本地 execution deadline；单个 guardian 在 ready 后死亡时，另一 guardian 仍可接管 deadline。即使本地 tree 已确认静默，也不会冒充 provider/native 已确认 cancelled。当前可信 ownership inspector 为 Windows 实现，因此非 Windows OpenCode 暂时继续使用旧 uninterrupted transport。`stop` 拒绝接管用户日常窗口或未知进程。

`.mcp.json` 注册的 `uagents-unified` 是兼容入口，供没有本地 Shell 或明确要求 MCP 的宿主使用：

```text
uagents_list_targets       uagents_get_capabilities
uagents_list_models        uagents_probe
uagents_submit             uagents_status
uagents_result             uagents_cancel
uagents_list_tasks         uagents_reconcile
uagents_ensure             uagents_resume
uagents_stop
```

Unified MCP 的 `uagents_submit` 与 Core 使用同一附件输入：`file` / `image` 都可以给 workspace-relative
`path`，也可以给宿主已经物化到本机的绝对 `source`。`source` 会在注册前复制进 workspace 并归一化为
现有 `{type,path}`；MCP 不会把 opaque connector file-id 直接传给 target。

Codex 可能只把显式声明的环境变量交给插件 MCP 进程，因此环境变量鉴权的本机 Agent 不应默认走 MCP。CLI 与 MCP 只有在使用同一状态目录时才共享 Task/Attempt；切换入口也不得用新 UUID 重放已发送或不确定的任务。

请求协议与状态解释见 [Skill 协议说明](plugins/uagents/skills/agent-dispatch/references/protocol.md)。目标差异见同目录下的 agy、WorkBuddy、OpenCode、豆包和 TRAE 说明。

## 开发验证

需要 Node.js `>=22.13.0`；本机验证版本为 Node 24.13.0。`node:sqlite` 在当前版本仍可能输出实验性警告。

```powershell
npm test
npm --prefix plugins/uagents/mcp/unified test
python C:\Users\24590\.codex\skills\.system\skill-creator\scripts\quick_validate.py plugins/uagents/skills/agent-dispatch
python C:\Users\24590\.codex\skills\.system\plugin-creator\scripts\validate_plugin.py plugins/uagents
```

## 设计与证据

- [统一 Runtime 设计](docs/superpowers/specs/2026-09-04-uagents-unified-agent-runtime-design.md)
- [Runtime 可靠性修复设计](docs/superpowers/specs/2026-09-05-runtime-reliability-fixes-design.md)
- [Verified Execution Timeout 设计](docs/superpowers/specs/2026-09-06-verified-execution-timeout-design.md)
- [Native Session Continuation 设计](docs/superpowers/specs/2026-09-10-native-session-continuation-design.md)
- [Runtime 可靠性修复验证](docs/verification/2026-09-06-runtime-reliability-fixes.md)
- [Universal Attachment Input 验证](docs/verification/2026-09-09-universal-attachment-input.md)
- [统一 Runtime 实施计划](docs/superpowers/plans/2026-09-04-uagents-unified-agent-runtime-implementation.md)
- [受管 Agent 生命周期设计](docs/superpowers/specs/2026-09-04-uagents-managed-agent-lifecycle-design.md)
- [受管生命周期实施计划](docs/superpowers/plans/2026-09-05-uagents-managed-agent-lifecycle-implementation.md)
- [Verified Execution Timeout 实施计划](docs/superpowers/plans/2026-09-06-verified-execution-timeout-plan.md)
- [当前状态与能力矩阵](docs/status/2026-09-06-current-status.md)
- [历史进度快照](docs/status/2026-09-02-current-progress.md)
- [受管桌面启动契约验证（Gate 0 spike）](docs/verification/2026-09-05-managed-launch-spike.md)
- [SQLite/Windows spike](docs/verification/2026-09-04-sqlite-windows-spike.md)
- [候选 CLI 调用契约](docs/verification/2026-09-03-cli-candidate-contracts.md)：Claude Code、Grok、Pi 仍只是候选，不在 target allowlist。
- [历史干净安装验证](docs/verification/2026-09-02-clean-plugin-install.md)
- [第三方资料索引](docs/research-index.md)

旧的两个目标专用 MCP 已从插件声明中移除；其 CDP/gateway 运输、TRAE 可追溯上游包、许可证和第三方通知仍保留。桌面 Agent 由 uAgents 以专用隔离 Profile 自动启动和管理：不自动登录、不批准操作、不购买额度、不接管用户日常窗口，也不静默切换付费路线。
