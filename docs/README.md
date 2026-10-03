# uAgents 文档

当前产品行为从 [快速开始](current/quick-start.md) 和 [当前设计](current/architecture.md) 阅读；精确字段以 CLI discovery、MCP `tools/list` 和 Core parser 为准。

## 入口

| 文档 | 内容 |
| --- | --- |
| [项目 README](../README.md) | 简介、最小提交示例与导航 |
| [当前设计与使用](current/README.md) | 已实现的架构、能力、运行规则和操作方法 |
| [协议与命令](reference/README.md) | 当前 CLI/MCP、请求与 capability contract |
| [开发与验证](development.md) | 仓库构建、测试和插件检查 |
| [验证证据](verification/README.md) | 有日期和构建身份的测试、安装与 Provider 记录 |
| [历史归档](history/README.md) | 设计讨论、旧规划、实施计划、评审和阶段快照 |

## 维护规则

1. README 只保留简介、快速开始与导航；详细规则放到对应主题文档。
2. `docs/current/` 使用稳定文件名，只描述已经实现的设计与行为；能力限制保留，设计候选、未来方案和演进过程移入 `docs/history/`。
3. 当前设计变化时直接更新对应主题及导航，避免保留多个日期版当前说明。
4. 精确 schema 和命令放在 `docs/reference/`，引用机器可读 discovery；同一规则不在多个文档重复维护。
5. 验证过程放在 `docs/verification/YYYY-MM-DD-*.md`，记录构建身份、执行命令、结果和未验证边界；当前文档只保留必要结论与证据链接。
6. 归档文件标注历史范围；移动文档时同步调整相对链接。历史内容不作为当前能力定义。

## 插件执行参考

[agent-dispatch Skill](../plugins/uagents/skills/agent-dispatch/SKILL.md) 及其 `references/` 随插件发布，面向 Agent 执行任务。它们应与当前设计和协议保持一致，提供执行所需规则。
