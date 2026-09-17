# uAgents

uAgents 是一个面向 Codex 的本地统一 Agent 调度插件。它把多个本机 Agent 接到同一套 Task、状态、结果、附件、会话和 Council 工作流中，同时保留各目标自己的模型与原生能力。

当前发行标识：`0.2.0-alpha.1+codex.20260913161732`。

## 支持的 Agent

| Target | Analysis | Implementation | File input | Image input | Continue / Fork |
| --- | --- | --- | --- | --- | --- |
| agy | ✅ | ✅ | — | — | — |
| WorkBuddy | ✅ | ✅ | — | `deepseek-v4.1-flash` ✅ | ✅ / ✅ |
| DeepSeek Harness (`dsh`) | ✅ | ✅ | — | — | — |
| OpenCode | ✅ | ✅ | ✅ | ✅ | ✅ / ✅ |
| 豆包工作 | ✅ | — | — | — | — |
| TRAE CN | ✅ | ✅ | — | — | — |

完整能力矩阵、批准模型路线和目标差异见 [当前 Agent 能力](docs/current/agents.md)。

## 快速开始

插件安装后，从当前插件根目录运行统一 CLI：

```powershell
node "<plugin-root>\bin\uagents.mjs" targets
node "<plugin-root>\bin\uagents.mjs" capabilities opencode
node "<plugin-root>\bin\uagents.mjs" models opencode
node "<plugin-root>\bin\uagents.mjs" submit --request "F:\path\request.json"
node "<plugin-root>\bin\uagents.mjs" status <task-id>
node "<plugin-root>\bin\uagents.mjs" result <task-id>
```

`submit` 也支持 `--request-stdin`。Prompt 和完整请求 JSON 不需要放进进程参数。

最小请求示例：

```json
{
  "schema_version": "1.0",
  "request_id": "<uuid>",
  "target": "dsh",
  "model": "deepseek-official/deepseek-flash",
  "mode": "analysis",
  "workspace": "F:\\project",
  "prompt": "Review this repository and summarize the main risks."
}
```

精确字段和命令参数以 CLI discovery 为准：

```text
uagents describe
uagents describe <command>
uagents schema request
uagents schema council
uagents schema council-validation
uagents schema council-validation-profiles
```

## 用户功能

### 附件

Core 支持 workspace 相对路径、本地绝对 source 和 inline blob。Unified MCP 还支持宿主已经物化的本地临时附件。不同 target 是否真正支持 file/image 由目标能力决定。

详见 [当前附件能力](docs/current/attachments.md)。

### 多轮会话

WorkBuddy 和 OpenCode 支持继续上一 native session，或从上一轮上下文 fork 独立分支。每一轮仍然是新的 uAgents Task。

详见 [当前会话能力](docs/current/sessions.md)。

### Council

Council 可以把同一任务 fan-out 给多个 Agent。分析任务可共享 workspace；并行实现任务可使用独立 Git worktree，并支持 diff、validation、adopt 和 cleanup。

详见 [当前 Council 能力](docs/current/council.md)。

### 模型发现

`models <target>` 会展示静态批准路线和可获得的本机模型发现证据。发现到模型不等于自动批准，也不代表 Provider 登录、额度或在线状态已经确认。

详见 [当前模型与路由](docs/current/models.md)。

### 本机生命周期

uAgents 可以发现并验证 Agent 安装；桌面目标使用受管实例。`status` / `result` 只读本地状态，`resume` / `reconcile` 不会把一个已经发送过的 Prompt 自动换 UUID 重放。

详见 [当前 Runtime 与生命周期](docs/current/runtime.md)。

## Unified MCP

没有本地 Shell、或宿主明确要求 MCP 时，可以使用插件提供的 `uagents-unified` stdio MCP Server。CLI 和 MCP 共用同一 Core contract。

详见 [MCP Reference](docs/reference/mcp.md)。

## 当前限制

- uAgents 是 orchestration 层，不提供执行沙箱。
- WorkBuddy generic file attachment 当前不可用；图片只对已验证的显式 `deepseek-v4.1-flash` 路线开放。
- DSH v1 只开放 text + workspace，当前不开放 file/image attachment、continuation 或 fork。
- Council 不自动选择 winner、自动 synthesis、自动 merge 或后台 cleanup。
- Dynamic model discovery 只提供本机 evidence，不自动扩大 allowlist。

## 文档

- [当前实现](docs/current/README.md)：现在已经实现并可使用的功能。
- [协议与命令 Reference](docs/reference/README.md)：稳定 contract、CLI/MCP 和 capability 语义。
- [Verification](docs/verification/)：provider-free、实机和真实 Provider 验证证据。
- [History](docs/history/README.md)：旧架构、设计讨论、实施计划、评审和历史状态快照。
- [文档总入口](docs/README.md)：文档维护规则与完整导航。

## 开发验证

需要 Node.js `>=22.13.0`。

```powershell
npm test
npm --prefix plugins/uagents/mcp/unified test
```

Skill 和 Plugin validator 的具体命令见 [当前 Runtime 与生命周期](docs/current/runtime.md)。
