# uAgents

供 Codex 使用的本地 Agent 调度插件，当前处于设计阶段，尚无可安装的插件产物。

目标是把“具体怎样调用某个 Agent”从常驻全局指令中拆出，实际委派时按需读取；Codex 保留主力开发、任务编排、结果评估与最终决策。

计划以一个 Plugin 分发一个 `agent-dispatch` Skill 和两个独立本地 MCP 服务：

- agy、WorkBuddy、OpenCode：优先使用现有 CLI，由 Skill 按需读取对应调用说明。
- TRAE：复用并验证现有 TRAECNclaw 的 CDP/MCP 桥接能力。
- 豆包工作：独立实现并验证 CDP/MCP 任务闭环。

## 设计与资料

- [插件设计草案](docs/superpowers/specs/2026-08-31-uagents-plugin-design.md)：模块边界、按需加载、调用契约、分阶段验收。
- [多模型会审](docs/reviews/2026-08-31-uagents-council-review.md)：Codex、DeepSeek Flash、GLM-5.2 的独立意见与修订建议；尚未实施。
- [调研资料索引](docs/research-index.md)：原始资料、已知证据、归档状态与复用限制。
- `third-part-research/`：本机历史资料与第三方代码归档，不进入本仓库版本控制或插件发布包。

当前处于设计与评审阶段。不修改全局 `AGENTS.md`、个人市场或 MCP 注册，不安装依赖；设计评审仅按用户要求调用获授权的模型，不执行桌面任务。

用户已完成移动：第三方源码位于 `third-part-research/traecnclaw/`，六份历史文档位于 `third-part-research/三方调研/`。文件总数、总大小及第三方 Git HEAD/已知工作区状态已核对；保留用户设置的 Git 忽略规则。详见资料索引。

新仓库不把原来的调用清单当作生效中的项目规则：该清单已原样归档，其中引用的全局路由段落曾被回滚，不应继续当作当前配置。
