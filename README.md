# uAgents

uAgents 是供各类 Agent 宿主使用的本地统一调度层。CLI、MCP 和共享本地服务使用同一套 Task、Attempt、结果、附件、会话与 Council。

支持 `agy`、`codex`、`claudeCode`、`workbuddy`、`dsh`、`opencode`、`pi`、`doubao` 和 `trae`。各目标的输入与会话能力见 [Agent 能力矩阵](docs/current/agents.md)。执行权限由原生 Agent 配置和启动策略控制。

## 快速开始

需要 Node.js `>=22.14.0`，并先安装、登录所需 Agent。包尚未发布到公开 npm，先从仓库打包安装：

```powershell
cd plugins/uagents
npm pack
npm install -g ./uagents-0.2.0-alpha.4.tgz
```

之后在任意目录查询目标和模型：

```powershell
uagents targets
uagents capabilities codex
uagents models codex
```

保存请求为 `request.json`，填写新的 UUID 和自己的绝对工作区路径：

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

```powershell
uagents submit --request request.json
uagents status <task-id>
uagents result <task-id>
```

每个有意的新任务使用新 UUID；遇到响应丢失或不确定状态，先查询原任务。开发仓库中可直接运行 `node plugins/uagents/bin/uagents.mjs <command>`，与已安装命令行为相同。安装、stdin 提交和配置方法见 [快速开始](docs/current/quick-start.md)。

## 文档

- [当前设计与使用](docs/current/README.md)：架构、Agent、附件、会话、模型、Council 和 Runtime。
- [共享本地服务](docs/current/service.md)：HTTP MCP、stdio 桥接与跨宿主接入。
- [自动签到](docs/current/checkin.md)：登录检测、每日计划任务与手动签到。
- [协议与命令](docs/reference/README.md)：CLI/MCP、请求字段和 capability 语义。
- [开发与验证](docs/development.md)：构建、针对性测试和插件打包检查。
- [验证证据](docs/verification/README.md)：测试、安装与真实 Provider 调用记录。
- [历史归档](docs/history/README.md)：设计讨论、旧规划、评审和阶段快照。
- [文档维护规则](docs/README.md)；当前包版本见 [包清单](plugins/uagents/package.json)。
