# uAgents

供 Codex 使用的本地 Agent 调度插件。当前为仓库内 `0.1.0-alpha.4` 预览源码，已跑通 agy/Gemini 文件生成、WorkBuddy 文件任务、OpenCode 双模型独立提案，以及豆包工作桌面任务闭环。尚未安装；TRAE 接入尚未实现。

目标是把“具体怎样调用某个 Agent”从常驻全局指令中拆出，实际委派时按需读取；Codex 保留主力开发、任务编排、结果评估与最终决策。

计划以一个 Plugin 分发一个 `agent-dispatch` Skill、已有 CLI 适配器和两个本地桌面 MCP 服务：

- agy、WorkBuddy、OpenCode：优先使用现有 CLI，由 Skill 按需读取对应调用说明。
- TRAE：当前目标是复用已登录 TRAE CN Solo 的免费账号积分；本机 `trae-cn` 只是 IDE 启动器，独立 `traecli` 不适用这条额度路线。下一阶段把已经真实跑通的 TRAECNclaw CDP/网关能力整理成插件内第二个 MCP，不从归档目录直接发布。
- 豆包工作：已实现一个独立 stdio MCP，通过用户明确准备的回环 CDP 端口创建专属会话、跟踪结果；当前不自动启动应用或批准操作。

## 设计与资料

- [插件设计草案](docs/superpowers/specs/2026-08-31-uagents-plugin-design.md)：模块边界、按需加载、调用契约、分阶段验收。
- [多模型会审](docs/reviews/2026-08-31-uagents-council-review.md)：Codex、DeepSeek Flash、GLM-5.2 的独立意见与修订建议；后续落实情况见实施记录。
- [agy 实施与验证](docs/verification/2026-08-31-cli-runtime.md)：首个 worker、真实 agy 调用及产物证据；页面逻辑检查通过，浏览器验收未完成。
- [WorkBuddy / OpenCode 验证](docs/verification/2026-08-31-cli-adapters.md)：原生后台试验、真实写文件、双模型会审、结果协议与已知边界。
- [桌面 MCP 选型](docs/reviews/2026-09-01-desktop-mcp-options.md)：TRAE CLI 排除理由、TRAECNclaw 复用审查、豆包适配边界。
- [豆包 MCP 实施验证](docs/verification/2026-09-01-doubao-mcp.md)：真实提交、原生会话归属、生产入口、协议和回归测试。
- [调研资料索引](docs/research-index.md)：原始资料、已知证据、归档状态与复用限制。
- `third-part-research/`：本机历史资料与第三方代码归档，不进入本仓库版本控制或插件发布包。

按用户要求取消额外的零工具/强制只读门禁。agy、WorkBuddy 写入任务单次启用各自原生文件修改模式，OpenCode 文本提案不启用自动审批；命令等工具仍沿用原生权限。不修改全局 `AGENTS.md`、个人市场、MCP 注册或供应商设置，不安装依赖。未验证每日免费额度，不自动切换计费路线。

## 开发验证

需要 Node.js 22 或更新版本；本机验证版本为 24.13.0，无 npm 依赖：

```powershell
npm test
node plugins/uagents/skills/agent-dispatch/scripts/agent-call.mjs capabilities
node plugins/uagents/skills/agent-dispatch/scripts/agent-call.mjs capabilities --target workbuddy
node plugins/uagents/skills/agent-dispatch/scripts/agent-call.mjs capabilities --target opencode
```

插件源目录为 `plugins/uagents/`，包含一个 Skill、CLI 脚本与已实现的 `doubao_work` MCP 声明。CLI 的取消和文件检查沿用原契约；豆包当前提供 probe/submit/status/result，没有未验证的 cancel。目录检查是事后验收，不提供硬性路径隔离或强制只读。实际委派时只读当前目标的 [agy](plugins/uagents/skills/agent-dispatch/references/agy.md)、[WorkBuddy](plugins/uagents/skills/agent-dispatch/references/workbuddy.md)、[OpenCode](plugins/uagents/skills/agent-dispatch/references/opencode-council.md) 或 [豆包工作](plugins/uagents/skills/agent-dispatch/references/doubao-work.md) 说明。

用户已完成移动：第三方源码位于 `third-part-research/traecnclaw/`，六份历史文档位于 `third-part-research/三方调研/`。文件总数、总大小及第三方 Git HEAD/已知工作区状态已核对；保留用户设置的 Git 忽略规则。详见资料索引。

新仓库不把原来的调用清单当作生效中的项目规则：该清单已原样归档，其中引用的全局路由段落曾被回滚，不应继续当作当前配置。
