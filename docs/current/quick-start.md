# 快速开始

需要 Node.js `>=22.13.0`，并先完成执行目标的安装、登录和原生权限配置。uAgents 插件包含 MCP bundles；安装后的运行目录不需要 `node_modules`。从开发仓库运行时，先按 [开发说明](../development.md) 安装构建依赖并构建。

## 插件与入口

已配置 `personal` marketplace 且其插件源对应待安装构建时，可以安装：

```powershell
codex plugin add uagents@personal --json
```

使用命令返回的 `installedPath` 作为插件根目录，版本见该目录的 `.codex-plugin/plugin.json`。CLI 入口为：

```powershell
node "<plugin-root>\bin\uagents.mjs" targets
node "<plugin-root>\bin\uagents.mjs" capabilities <target>
node "<plugin-root>\bin\uagents.mjs" models <target>
```

选择实际可用的 target、mode 和 model。发现到模型不代表登录、额度或 Provider 在线状态已经确认；目标差异见 [能力矩阵](agents.md)，默认模型与单次覆盖见 [模型与路由](models.md)。

## 提交与查询

每个新任务生成一个 UUID，填写已有的绝对工作区路径。最小请求示例：

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

保存为 `request.json`：

```powershell
node "<plugin-root>\bin\uagents.mjs" submit --request request.json
node "<plugin-root>\bin\uagents.mjs" status <task-id>
node "<plugin-root>\bin\uagents.mjs" result <task-id>
```

也可把 UTF-8 请求 JSON 传给 `submit --request-stdin`。两种请求入口严格二选一，避免将 Prompt 或完整 JSON 放入 argv。stdin 上限为 1 MiB，大附件使用请求文件或 MCP 附件入口。

同 UUID 只能复用完全相同的有效请求。遇到 `may_have_been_sent`、`indeterminate` 或响应丢失，先查询原 Task；恢复规则见 [Runtime](runtime.md)。

`analysis` 与 `advisory-read-only` 表达任务意图，不提供强制只读沙箱。审查请求应明确禁止修改文件和有修改效果的命令；原生权限行为见 [权限边界](agents.md#权限边界)。

## 配置

CLI 可用 `--config <绝对路径>` 读取用户路线与默认值；CLI/MCP 共用配置时可设置 `UAGENTS_CONFIG`。Task 状态默认使用 `%LOCALAPPDATA%\uAgents\v1`，可用 `--state-dir` 或 `UAGENTS_STATE_DIR` 指定绝对目录。非 Windows 环境没有 `LOCALAPPDATA` 时须显式提供状态目录。

只有使用同一状态目录的入口才共享 Task、Attempt 和 Council。具体字段见 [CLI Reference](../reference/cli.md) 和 [当前架构](architecture.md)。

## MCP 与更多工作流

- 插件自带统一 stdio MCP，工具 schema 通过 `tools/list` 读取，见 [MCP Reference](../reference/mcp.md)。
- 多个宿主共用独立调度进程时，使用 [共享本地服务](service.md) 的 HTTP MCP 或 stdio 桥接。
- 文件和图片见 [附件](attachments.md)，多轮任务见 [会话](sessions.md)，并行候选见 [Council](council.md)。
- 命令与请求 schema 可通过 `describe`、`describe <command>` 和 `schema request` 查询。
