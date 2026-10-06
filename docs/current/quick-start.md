# 快速开始

需要 Node.js `>=22.14.0`，并先完成执行目标的安装、登录和原生权限配置。uAgents 包含已构建的 MCP bundles；安装后的运行目录不需要 `node_modules`。从开发仓库运行时，先按 [开发说明](../development.md) 安装构建依赖并构建。

Windows 下 uAgents 启动会检查已登录的 TRAE / WorkBuddy，并注册或复用每日自动签到任务；手动 `init`、只查状态和停用方法见 [自动签到](checkin.md)。

## 安装与入口

包尚未发布到公开 npm。从仓库打包安装：

```powershell
cd plugins/uagents
npm pack
npm install -g ./uagents-0.2.0-alpha.1.tgz
```

CLI 入口为：

```powershell
uagents targets
uagents capabilities <target>
uagents models <target>
```

包版本见 `plugins/uagents/package.json`。开发仓库中可直接运行 `node plugins/uagents/bin/uagents.mjs <command>`，行为相同。

Codex 可以只使用独立 Skill 与 CLI，无需安装旧 uAgents 插件。安装 Skill：

```powershell
uagents skills install --dir "$env:USERPROFILE/.codex/skills"
# 更新已有 Skill 时加 --force
```

确认独立 `agent-dispatch` Skill 和 CLI 可用后，可在 Codex 中卸载旧 `uagents@personal` 插件；卸载不删除 CLI、原生目标或任务状态。下一轮会话可加载独立 Skill。AGENTS.md 中的外部路由应依赖 Skill 与 CLI 可用性，不应依赖旧插件是否启用。MCP 仍可按需单独配置。

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
uagents submit --request request.json
uagents status <task-id>
uagents result <task-id>
```

只想要一句话结果时，用 `run` 直接完成登记、等待与取回：

```powershell
uagents run codex --model gpt-5.6-luna --workspace F:\project --prompt-file prompt.txt
```

它默认 `--mode analysis`，省略 `--workspace` 时使用当前目录，返回与 `result` 相同的载荷；最后状态不是 `succeeded` 时退出码为 1。`--prompt-file` / `--prompt-stdin` 不把 Prompt 放进 argv，`-p` 会。等待超时或停在 `waiting_user` 时返回最后状态并带 warning，不会重发 Prompt。

查历史只读本地状态目录，不联系 Provider、不重发 Prompt：

```powershell
uagents list --target opencode --has-response --limit 20   # 某目标下已产出回答的任务
uagents sessions --target opencode                        # 按原生会话聚合的已登记对话
uagents result <task-id>                                  # 单次对话的正文、usage 与 artifacts
```

原生 CLI 自己的历史不在其中——uAgents 只列出自己登记过的任务，且只有同一状态目录的入口互相可见；续接旧会话要用新 UUID 加请求里的 `session.continue_from_task_id` / `fork_from_task_id`，不是查询动作。

也可把 UTF-8 请求 JSON 传给 `submit --request-stdin`。两种请求入口严格二选一，避免将 Prompt 或完整 JSON 放入 argv。stdin 上限为 1 MiB，大附件使用请求文件或 MCP 附件入口。

同 UUID 只能复用完全相同的有效请求。遇到 `may_have_been_sent`、`indeterminate` 或响应丢失，先查询原 Task；恢复规则见 [Runtime](runtime.md)。

`analysis` 与 `advisory-read-only` 表达任务意图，不提供强制只读沙箱。审查请求应明确禁止修改文件和有修改效果的命令；原生权限行为见 [权限边界](agents.md#权限边界)。

## 配置

CLI 可用 `--config <绝对路径>` 读取用户路线与默认值；CLI/MCP 共用配置时可设置 `UAGENTS_CONFIG`。Task 状态默认使用 `%LOCALAPPDATA%\uAgents\v1`，可用 `--state-dir` 或 `UAGENTS_STATE_DIR` 指定绝对目录。非 Windows 环境没有 `LOCALAPPDATA` 时须显式提供状态目录。

只有使用同一状态目录的入口才共享 Task、Attempt 和 Council。具体字段见 [CLI Reference](../reference/cli.md) 和 [当前架构](architecture.md)。

## MCP 与更多工作流

- 包内自带统一 stdio MCP（入口 `mcp/unified/dist/server.mjs`，也可用命令 `uagents-mcp-bridge`），工具 schema 通过 `tools/list` 读取，见 [MCP Reference](../reference/mcp.md)。
- 多个宿主共用独立调度进程时，使用 [共享本地服务](service.md) 的 HTTP MCP 或 stdio 桥接。
- 文件和图片见 [附件](attachments.md)，多轮任务见 [会话](sessions.md)，并行候选见 [Council](council.md)。
- 命令与请求 schema 可通过 `describe`、`describe <command>` 和 `schema request` 查询。
