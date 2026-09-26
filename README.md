# uAgents

uAgents 是一个面向 Codex 的本地统一 Agent 调度层。它把多个本机 Agent 接到同一套 Task、状态、结果、附件、会话和 Council 工作流中。沙箱、命令和文件访问权限由各 Agent 的原生配置与运行环境控制；uAgents 不代替 Agent 授权或自动批准请求。

当前仓库与个人 marketplace 安装构建版本见 [插件清单](plugins/uagents/.codex-plugin/plugin.json)；安装版验证见 [验证记录](docs/verification/2026-09-23-codex-app-server-spike.md)。

## 支持的 Agent

| Target | Analysis | Implementation | File input | Image input | Continue / Fork |
| --- | --- | --- | --- | --- | --- |
| agy | ✅ | ✅ | — | — | — |
| Codex CLI (`codex`) | ✅ | ✅ | — | — | Windows/Astra 显式预览 ✅ / ✅ |
| Claude Code CLI (`claudeCode`) | ✅ | ✅ | — | — | — |
| WorkBuddy | ✅ | ✅ | — | `deepseek-v4.1-flash` ✅ | ✅ / ✅ |
| DeepSeek Harness (`dsh`) | ✅ | ✅ | — | — | — |
| OpenCode | ✅ | ✅ | ✅ | ✅ | ✅ / ✅ |
| 豆包工作 | ✅ | — | — | — | — |
| TRAE CN | ✅ | ✅ | — | — | — |

完整能力矩阵、模型选择和目标差异见 [当前 Agent 能力](docs/current/agents.md)。

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

使用已通过安装版真实任务验收的 Codex CLI / GPT-5.6 Luna 时，将请求中的 `target` 设为 `codex`、`model` 设为 `gpt-5.6-luna`，并填写自己的工作区和新 UUID。例如：

```json
{
  "schema_version": "1.0",
  "request_id": "<new-uuid>",
  "target": "codex",
  "model": "gpt-5.6-luna",
  "mode": "analysis",
  "workspace": "F:\\project",
  "prompt": "Summarize the repository's architecture."
}
```

保存为 `request.json` 后使用上面的 `submit --request` 命令；通过 `status` / `result` 查询，不要为尚未确认结果的任务更换 UUID 重发。Codex 的 `probe` 只检查本机 CLI 版本，不是模型在线可用性测试。真实安装版 Luna 验收记录见 [Verification](docs/verification/2026-09-20-codex-luna-installed-e2e.md)。

Claude Code CLI 使用 `target="claudeCode"` 和显式模型路线，例如本机 DeepSeek 网关的 `model="claudeCode/deepseek-v4-pro[1m]"`，并提供绝对路径 `workspace`。当前支持 text + workspace、analysis / implementation；权限完全沿用 Claude Code 原生设置，uAgents 不传入权限覆盖参数。`probe claudeCode --model claudeCode/deepseek-v4-pro[1m]` 仅检查 CLI 版本。当前不开放原生附件、跨 Task continuation/fork；`status` / `result` 可查询已提交 Task。详见 [Claude Code 当前能力](docs/current/agents.md#claude-code-cli-claudecode) 与 [验证记录](docs/verification/2026-09-25-claude-code-cli.md)。

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

WorkBuddy 和 OpenCode 支持继续上一 native session，或从上一轮上下文 fork 独立分支。Codex 在 Windows 上可为 `gpt-6-astra` 显式设置 `execution.codex_transport="app-server"` 使用预览版 continuation/fork。每一轮仍然是新的 uAgents Task。

详见 [当前会话能力](docs/current/sessions.md)。

### Council

Council 可以把同一任务 fan-out 给多个 Agent。分析任务可共享 workspace；并行实现任务可使用独立 Git worktree，并支持 diff、validation、adopt 和 cleanup。

详见 [当前 Council 能力](docs/current/council.md)。

### 模型发现

`models <target>` 会展示配置路线和可获得的原生模型发现证据。agy、WorkBuddy、OpenCode 的 native catalog
使用 10 分钟本机缓存，可用 `models <target> --refresh` 显式刷新。`models trae` 只复用已存在且身份可验证的受管窗口读取实时选择器，不会为了列模型启动第二个 TRAE 窗口；否则只读列出个人 TRAE CN 配置缓存中的 SOLO 模型候选，并标记 `discovery.status=partial`、`usable=null`。TRAE 默认使用隔离配置；明确执行 `ensure trae --profile personal` 可在关闭原有 TRAE 窗口后用现有个人配置启动受管窗口。受管桌面退出后，下次 `ensure` 仅在旧网关身份、空任务队列及当前 Task 存储中的无未决任务均得到确认时回收旧网关，并记录清理状态；旧网关可能仍运行时会延后新实例启动，避免覆盖其 token。真实 CLI 已验证实时列举、界面模型切换、analysis/implementation text + workspace Task、必需文件捕获、默认模型路线和这一路径的网关回收；网关尚无逐 Task 模型自报，`model_verified=false`。

Codex 在委派新 Task 前通过 uAgents Skill 查询模型证据：已指定模型时直接使用；要求先选时展示 selector、target 默认、来源和采集时间并等待回复；未指定且有默认路线时说明后继续。详见[当前模型与路由](docs/current/models.md#codex-对话中的预选步骤)。
原生目录中的模型可直接作为单次 Task 的 `model`；不要求另行登记静态路线。发现到模型不代表 Provider 登录、额度或在线状态已经确认。

每个 target 可以在用户配置中设置 `defaults`；请求省略 `model` 或写 `"model":"default"` 时使用该默认路线，
本次 Task 写入具体 `model` 则覆盖它。CLI 可用 `--config <绝对路径>` 加载配置，CLI/MCP 共用时可设置
`UAGENTS_CONFIG=<绝对路径>`。`models <target>` 的 `selector` 是请求可用的模型值，`default=true` 标出当前默认路线。
没有默认路线的 target 在省略模型时会于提交前报 `model_unavailable`。

详见 [当前模型与路由](docs/current/models.md)。

### 本机生命周期

uAgents 可以发现并验证 Agent 安装；桌面目标使用受管实例。`status` / `result` 只读本地状态，`resume` / `reconcile` 不会把一个已经发送过的 Prompt 自动换 UUID 重放。

详见 [当前 Runtime 与生命周期](docs/current/runtime.md)。

## Unified MCP

没有本地 Shell、或宿主明确要求 MCP 时，可以使用插件提供的 `uagents-unified` stdio MCP Server。CLI 和 MCP 共用同一 Core contract。

详见 [MCP Reference](docs/reference/mcp.md)。

## 当前限制

- uAgents 只负责调度与记录，不提供执行沙箱或审批代理。Codex/OpenCode 等目标的权限由各自的原生配置控制。Codex app-server 若要求交互审批，Task 保持不确定；uAgents 不会代答，也不会自动重发该 Prompt。
- WorkBuddy generic file attachment 当前不可用；图片只对已验证的显式 `deepseek-v4.1-flash` 路线开放。
- DSH v1 只开放 text + workspace，当前不开放 file/image attachment、continuation 或 fork。
- Codex CLI 默认使用显式 `gpt-6-astra` 或 `gpt-5.6-luna` 的 exec 路线，支持 text + workspace；native file/image 暂未开放。跨 Task continuation/fork 仅对 Windows/Astra 显式 app-server 预览路线开放。
- Claude Code CLI 内置 DeepSeek 路线 `claudeCode/deepseek-v4-pro[1m]`、`claudeCode/deepseek-v4-pro`、`claudeCode/deepseek-v4-flash`，以及已验证的 `claude-sonnet-4-6` 模型 ID；其它显式 ID 也交由原生 CLI 判定。原生 `init.model` 与请求解析的 ID 不一致时 Task 失败。取消或超时后的远端状态不能仅凭 CLI 关闭确认，Task 保持不确定且不会自动重发。
- Council 不自动选择 winner、自动 synthesis、自动 merge 或后台 cleanup。
- 显式模型选择交给原生 CLI/网关判断。没有原生目录的 target 可以直接传模型 ID，但 `models` 只显示配置路线；新模型的 file/image 能力默认关闭。TRAE 当前没有可核对的逐 Task 原生模型自报。

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
