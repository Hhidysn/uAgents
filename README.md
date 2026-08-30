# uAgents

供 Codex 使用的本地 Agent 调度插件。当前有仓库内 `0.1.0-alpha.1` 预览源码，包含 Skill、agy 权限预检与任务运行机制；尚未安装，真实 agy 任务验收未通过。

目标是把“具体怎样调用某个 Agent”从常驻全局指令中拆出，实际委派时按需读取；Codex 保留主力开发、任务编排、结果评估与最终决策。

计划以一个 Plugin 分发一个 `agent-dispatch` Skill 和两个独立本地 MCP 服务：

- agy、WorkBuddy、OpenCode：优先使用现有 CLI，由 Skill 按需读取对应调用说明。
- TRAE：复用并验证现有 TRAECNclaw 的 CDP/MCP 桥接能力。
- 豆包工作：独立实现并验证 CDP/MCP 任务闭环。

## 设计与资料

- [插件设计草案](docs/superpowers/specs/2026-08-31-uagents-plugin-design.md)：模块边界、按需加载、调用契约、分阶段验收。
- [多模型会审](docs/reviews/2026-08-31-uagents-council-review.md)：Codex、DeepSeek Flash、GLM-5.2 的独立意见与修订建议；后续落实情况见实施记录。
- [首轮实施与验证](docs/verification/2026-08-31-cli-runtime.md)：CLI 能力矩阵、模拟验证、真实 agy 预检结果和剩余阻塞。
- [调研资料索引](docs/research-index.md)：原始资料、已知证据、归档状态与复用限制。
- `third-part-research/`：本机历史资料与第三方代码归档，不进入本仓库版本控制或插件发布包。

用户已授权首轮验证与最小实施。不修改全局 `AGENTS.md`、个人市场或 MCP 注册，不安装依赖；本轮 agy 仅做无提示词握手，没有发送真实模型任务。TRAE、豆包和其余 CLI 适配器尚未实现。

## 开发验证

需要 Node.js 22 或更新版本；本机验证版本为 24.13.0，无 npm 依赖：

```powershell
npm test
node plugins/uagents/skills/agent-dispatch/scripts/agent-call.mjs capabilities
```

插件源目录为 `plugins/uagents/`，仅含已实现的 Skill 与脚本，没有虚假的 MCP 声明。通过 manifest 校验不代表真实 agy 任务已通过验收，当前预检会因无法确认无工具权限而阻断发送。详细操作见插件内的 [agy 参考](plugins/uagents/skills/agent-dispatch/references/agy.md)。

用户已完成移动：第三方源码位于 `third-part-research/traecnclaw/`，六份历史文档位于 `third-part-research/三方调研/`。文件总数、总大小及第三方 Git HEAD/已知工作区状态已核对；保留用户设置的 Git 忽略规则。详见资料索引。

新仓库不把原来的调用清单当作生效中的项目规则：该清单已原样归档，其中引用的全局路由段落曾被回滚，不应继续当作当前配置。
