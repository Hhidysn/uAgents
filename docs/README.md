# uAgents 文档索引

本文档区分“当前可用能力”“设计/计划”“验证证据”和“历史调研”，避免把设计目标或测试桩误读为已经发布的能力。

## 当前先读

- [当前状态与能力矩阵](status/2026-09-06-current-status.md)：目标能力、OpenCode 版本核对、已验证范围、短板和优先级。
- [项目 README](../README.md)：安装、CLI、MCP 和开发验证的快速入口。

## 设计与实施

- [统一 Runtime 设计](superpowers/specs/2026-09-04-uagents-unified-agent-runtime-design.md)
- [受管 Agent 生命周期设计](superpowers/specs/2026-09-04-uagents-managed-agent-lifecycle-design.md)
- [Runtime 可靠性修复设计](superpowers/specs/2026-09-05-runtime-reliability-fixes-design.md)
- [Verified Execution Timeout 设计](superpowers/specs/2026-09-06-verified-execution-timeout-design.md)
- [统一 Runtime 实施计划](superpowers/plans/2026-09-04-uagents-unified-agent-runtime-implementation.md)
- [受管生命周期实施计划](superpowers/plans/2026-09-05-uagents-managed-agent-lifecycle-implementation.md)
- [Runtime 可靠性修复计划](superpowers/plans/2026-09-05-runtime-reliability-fixes.md)
- [Verified Execution Timeout 实施计划](superpowers/plans/2026-09-06-verified-execution-timeout-plan.md)

设计和计划描述“要做什么、如何验收”，不自动代表已安装或已通过真实 Agent 验证。

## 验证证据

- [Verified Execution Timeout 安装验收（2026-09-06）](verification/2026-09-06-verified-execution-timeout-release.md)
- [Durable Native Execution Gate E 安装验收（2026-09-06）](verification/2026-09-06-durable-native-execution-release.md)
- [Runtime 可靠性修复验证（2026-09-06）](verification/2026-09-06-runtime-reliability-fixes.md)
- [安装后受管生命周期 E2E](verification/2026-09-05-installed-lifecycle-e2e.md)
- [受管桌面启动 Spike](verification/2026-09-05-managed-launch-spike.md)
- [统一 Runtime 实施验证](verification/2026-09-04-unified-runtime-implementation.md)
- [统一 Runtime 基线](verification/2026-09-04-unified-runtime-baseline.md)
- [干净插件安装验证](verification/2026-09-02-clean-plugin-install.md)
- [OpenCode / WorkBuddy CLI 接入验证](verification/2026-08-31-cli-adapters.md)
- [候选 CLI 调用契约](verification/2026-09-03-cli-candidate-contracts.md)

验证文档必须同时写明命令、结果和限制。测试 fixture、version-only probe 或 connection-only probe
不能替代真实 Prompt、登录、额度和端到端消息验证。

## 目标协议参考

这些文件随 `agent-dispatch` Skill 发布，按目标读取：

- [统一请求与结果协议](../plugins/uagents/skills/agent-dispatch/references/protocol.md)
- [agy / Gemini](../plugins/uagents/skills/agent-dispatch/references/agy.md)
- [WorkBuddy](../plugins/uagents/skills/agent-dispatch/references/workbuddy.md)
- [OpenCode](../plugins/uagents/skills/agent-dispatch/references/opencode-council.md)
- [豆包工作](../plugins/uagents/skills/agent-dispatch/references/doubao-work.md)
- [TRAE CN](../plugins/uagents/skills/agent-dispatch/references/trae-cn.md)

## 评审与调研

- [主模型初始评审](reviews/2026-08-31-uagents-primary-review.md)
- [多模型会审](reviews/2026-08-31-uagents-council-review.md)
- [桌面 MCP 方案比较](reviews/2026-09-01-desktop-mcp-options.md)
- [与 sub-agents-skills 对比](reviews/2026-09-02-sub-agents-skills-comparison.md)
- [第三方资料与来源索引](research-index.md)

这些文件保留当时的输入、证据边界和决策背景。第三方资料目录不是发行包，也不是运行时依赖。

## 历史文件约定

带日期的状态、计划和验证文件原则上保留为不可变快照；如果内容已被新证据取代，在索引中标注新入口，
不直接把旧文件伪装成当前状态。当前判断以最新状态文档、最新验证文档和实际 CLI `capabilities` 输出为准。
