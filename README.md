# uAgents

uAgents 是供 Codex 使用的本地统一 Agent 调度插件。`0.2.0-alpha.1` 把 agy/Gemini、WorkBuddy、OpenCode、豆包工作和 TRAE CN 接到同一套请求、能力、任务状态、结果、错误和产物协议，同时保留各目标不同的模型、文件、权限、取消和桌面连接能力。

核心特性：

- 一个 `agent-dispatch` Skill、一个本地优先 CLI、一个可选 stdio MCP Server，共用同一 Node.js Core。
- SQLite WAL 控制面；Task、Attempt、Native Session 分离；同 UUID 与同一有效请求不会重复发送。
- 每次调用记录 `model_requested`、`model_resolved`、`model_reported`、`model_verified`，不把配置选择冒充运行期验证。
- `model_resolved` 保存规范模型名，完整 Provider/Model 运输路线单独保存在 `route_id`。
- 原生失败以脱敏结构化错误返回；Provider 响应头、响应体和凭据内容不会写入任务记录。
- 本地 uAgents CLI、后台 Worker 和受信任的 Agent CLI 逐层继承调用终端环境，使任意 Provider 的环境变量凭据无需硬编码即可使用；环境内容不会进入请求、SQLite 或结果。
- 外部发送前持久化 `possibly_sent`；发送后不确定状态不自动换 UUID、模型或 Provider 重放。
- workspace 重叠租约、fencing token、输入快照、不可变产物捕获与 SHA-256 验证。
- `status`/`list` 只读本地状态；只有显式 `reconcile` 才访问已有原生任务身份。

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

`.mcp.json` 注册的 `uagents-unified` 是兼容入口，供没有本地 Shell 或明确要求 MCP 的宿主使用：

```text
uagents_list_targets       uagents_get_capabilities
uagents_list_models        uagents_probe
uagents_submit             uagents_status
uagents_result             uagents_cancel
uagents_list_tasks         uagents_reconcile
```

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
- [可执行实施计划](docs/superpowers/plans/2026-09-04-uagents-unified-agent-runtime-implementation.md)
- [当前进度](docs/status/2026-09-02-current-progress.md)
- [SQLite/Windows spike](docs/verification/2026-09-04-sqlite-windows-spike.md)
- [候选 CLI 调用契约](docs/verification/2026-09-03-cli-candidate-contracts.md)：Claude Code、Grok、Pi 仍只是候选，不在 target allowlist。
- [历史干净安装验证](docs/verification/2026-09-02-clean-plugin-install.md)
- [第三方资料索引](docs/research-index.md)

旧的两个目标专用 MCP 已从插件声明中移除；其 CDP/gateway 运输、TRAE 可追溯上游包、许可证和第三方通知仍保留。插件不会自动启动桌面应用、登录、批准操作、购买额度或静默切换付费路线。
