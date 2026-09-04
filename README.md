# uAgents

uAgents 是供 Codex 使用的本地统一 Agent 调度插件。`0.2.0-alpha.1` 把 agy/Gemini、WorkBuddy、OpenCode、豆包工作和 TRAE CN 接到同一套请求、能力、任务状态、结果、错误和产物协议，同时保留各目标不同的模型、文件、权限、取消和桌面连接能力。

核心特性：

- 一个 `agent-dispatch` Skill、一个 CLI、一个 stdio MCP Server，共用同一 Node.js Core。
- SQLite WAL 控制面；Task、Attempt、Native Session 分离；同 UUID 与同一有效请求不会重复发送。
- 每次调用记录 `model_requested`、`model_resolved`、`model_reported`、`model_verified`，不把配置选择冒充运行期验证。
- `model_resolved` 保存规范模型名，完整 Provider/Model 运输路线单独保存在 `route_id`。
- 原生失败以脱敏结构化错误返回；Provider 响应头、响应体和凭据内容不会写入任务记录。
- 启动受信任的本机 Agent CLI 时继承 Codex MCP 进程环境，使任意 Provider 的环境变量凭据无需硬编码即可使用；环境内容不会进入请求、SQLite 或结果。
- 外部发送前持久化 `possibly_sent`；发送后不确定状态不自动换 UUID、模型或 Provider 重放。
- workspace 重叠租约、fencing token、输入快照、不可变产物捕获与 SHA-256 验证。
- `status`/`list` 只读本地状态；只有显式 `reconcile` 才访问已有原生任务身份。

## 使用

插件通过 `.mcp.json` 只注册 `uagents-unified`，提供：

```text
uagents_list_targets       uagents_get_capabilities
uagents_list_models        uagents_probe
uagents_submit             uagents_status
uagents_result             uagents_cancel
uagents_list_tasks         uagents_reconcile
```

CLI 使用相同 Core：

```powershell
node plugins/uagents/bin/uagents.mjs targets
node plugins/uagents/bin/uagents.mjs capabilities opencode
node plugins/uagents/bin/uagents.mjs models opencode
node plugins/uagents/bin/uagents.mjs submit --request "F:\path\request.json" --state-dir "F:\path\uagents-state"
node plugins/uagents/bin/uagents.mjs status <task-id> --state-dir "F:\path\uagents-state"
node plugins/uagents/bin/uagents.mjs result <task-id> --state-dir "F:\path\uagents-state"
```

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
