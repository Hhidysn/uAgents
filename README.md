# uAgents

供 Codex 使用的本地 Agent 调度插件。当前为仓库内 `0.1.0-alpha.2` 预览源码：已跑通 Codex → agy / Gemini → 指定目录生成 HTML → 回收结果与核对产物。尚未安装；页面通过脚本逻辑检查，浏览器交互和视觉验收未完成。

目标是把“具体怎样调用某个 Agent”从常驻全局指令中拆出，实际委派时按需读取；Codex 保留主力开发、任务编排、结果评估与最终决策。

计划以一个 Plugin 分发一个 `agent-dispatch` Skill 和两个独立本地 MCP 服务：

- agy、WorkBuddy、OpenCode：优先使用现有 CLI，由 Skill 按需读取对应调用说明。
- TRAE：复用并验证现有 TRAECNclaw 的 CDP/MCP 桥接能力。
- 豆包工作：独立实现并验证 CDP/MCP 任务闭环。

## 设计与资料

- [插件设计草案](docs/superpowers/specs/2026-08-31-uagents-plugin-design.md)：模块边界、按需加载、调用契约、分阶段验收。
- [多模型会审](docs/reviews/2026-08-31-uagents-council-review.md)：Codex、DeepSeek Flash、GLM-5.2 的独立意见与修订建议；后续落实情况见实施记录。
- [实施与验证](docs/verification/2026-08-31-cli-runtime.md)：CLI 能力矩阵、模拟验证、真实 agy 调用及产物证据。
- [调研资料索引](docs/research-index.md)：原始资料、已知证据、归档状态与复用限制。
- `third-part-research/`：本机历史资料与第三方代码归档，不进入本仓库版本控制或插件发布包。

按用户要求取消插件额外施加的零工具/强制只读门禁。agy analysis 继承原生模式；已授权写文件的 implementation 单次使用 `accept-edits`，命令等工具仍沿用原生权限。没有修改全局 `AGENTS.md`、个人市场、MCP 注册或供应商设置，没有安装依赖。TRAE、豆包和其余 CLI 适配器尚未实现。

## 开发验证

需要 Node.js 22 或更新版本；本机验证版本为 24.13.0，无 npm 依赖：

```powershell
npm test
node plugins/uagents/skills/agent-dispatch/scripts/agent-call.mjs capabilities
```

插件源目录为 `plugins/uagents/`，仅含已实现的 Skill 与脚本，没有未实现的 MCP 声明。提交、状态查询、结果回收、重复提交保护、取消和 expected_outputs 文件检查均已实现。目录检查是事后验收，不提供硬性路径隔离或强制只读。详细操作见插件内的 [agy 参考](plugins/uagents/skills/agent-dispatch/references/agy.md)。

用户已完成移动：第三方源码位于 `third-part-research/traecnclaw/`，六份历史文档位于 `third-part-research/三方调研/`。文件总数、总大小及第三方 Git HEAD/已知工作区状态已核对；保留用户设置的 Git 忽略规则。详见资料索引。

新仓库不把原来的调用清单当作生效中的项目规则：该清单已原样归档，其中引用的全局路由段落曾被回滚，不应继续当作当前配置。
