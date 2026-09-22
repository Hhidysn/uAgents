# uAgents 文档

文档按“用户入口、当前实现、稳定协议、待实现功能、验证证据、历史记录”分层。只有 `README.md`、`docs/current/` 和 `docs/reference/` 用来描述当前产品行为。

## 文档层级

| 目录 | 作用 | 是否描述当前能力 |
| --- | --- | --- |
| `README.md` | 面向用户的功能、快速开始和当前限制 | 是 |
| `docs/current/` | 当前已经实现的功能细节 | 是 |
| `docs/reference/` | 稳定协议、命令和 capability 语义 | 是 |
| `docs/verification/` | 测试、实机和 Provider E2E 证据 | 证据，不作为功能定义 |
| `docs/roadmap.md` | 待实现功能、新 Agent 候选与阶段验收门槛 | 否；属于规划 |
| `docs/history/` | 旧架构、设计方案讨论、计划、评审、历史状态 | 否 |

维护规则：

1. README 只写用户能做什么，不写功能演进过程和架构争论。
2. `docs/current` 使用稳定文件名，不创建新的日期版 `*-current.md`。
3. 当前行为变化时直接更新对应 `docs/current/*.md`。
4. 精确 schema/CLI contract 放在 `docs/reference`，并优先引用机器可读 discovery。
5. 一次验证过程记录在 `docs/verification/YYYY-MM-DD-*.md`，不把测试 UUID、完整日志或阶段性计数复制到 README。
6. 已完成或被替代的设计、计划和状态快照进入 `docs/history`，不得作为当前 capability 的 source of truth。

## 当前实现

- [当前实现总览](current/README.md)
- [Agent 与能力矩阵](current/agents.md)
- [附件](current/attachments.md)
- [会话 continuation / fork](current/sessions.md)
- [Council](current/council.md)
- [模型与路由](current/models.md)
- [Runtime 与生命周期](current/runtime.md)

## Reference

- [Reference 总览](reference/README.md)
- [CLI](reference/cli.md)
- [MCP](reference/mcp.md)
- [Request / Task Protocol](reference/protocol.md)
- [Capability 语义](reference/capabilities.md)

## 验证证据

验证记录继续保存在 [verification/](verification/)。其中可以包含日期、版本、真实请求 UUID、测试计数和失败过程；这些内容用于证明能力，而不是定义能力。

## 待实现功能

- [Roadmap：Codex 后续能力、现有 Agent 补充及 Claude Code / Pi Agent 研究](roadmap.md)
- [Codex CLI v2 设计提案](history/superpowers/specs/2026-09-20-codex-cli-v2-design.md)

以上属于规划，不表示功能已开放；当前可用能力仍以 `docs/current/` 为准。

## 历史文档

旧设计、实施计划、评审、研究索引和阶段状态已归档到 [history/](history/README.md)。历史文档可能描述已经被后续实现替代的行为，阅读时应以提交时间和上下文为准。

## Agent 执行参考

`plugins/uagents/skills/agent-dispatch/references/` 随插件发布，是 Agent 执行时使用的操作参考，不属于历史文档。它应与 `docs/current` / `docs/reference` 保持一致，但可以更偏向机器/operator 使用。
