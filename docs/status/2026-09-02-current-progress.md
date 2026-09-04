# uAgents 当前进度

日期：2026-09-02；2026-09-04 更新。当前目标版本：`0.2.0-alpha.1`。

## 当前结论

原先的三条 CLI 路线和两个目标专用桌面 MCP 已重构为一个统一 Runtime：一个 versioned request、一个结果 envelope、一个 SQLite WAL 控制面、五个普通 Adapter，以及共享这些能力的 CLI 和 stdio MCP。2026-09-03 已完成旧版 Skill/MCP 拾取和 agy 最小真实任务；2026-09-04 的重写验证默认只使用 fixture 和 connection-only probe，不消耗 Provider 任务额度。

| 模块 | 当前能力 | 仍有边界 |
| --- | --- | --- |
| Protocol / Policy | 精确字段校验、Capability 匹配、显式 model/default 解析、禁止 fallback 和未实现 cost cap | 尚无自动模型推荐或动态价格预算 |
| Store / Runtime | SQLite WAL、Task/Attempt/Session、32 进程 UUID 幂等、checkpoint、lease/fencing、取消意图、显式 reconcile | `node:sqlite` 在支持的 Node 版本仍会警告；未做系统重启/休眠耐久测试 |
| agy | analysis/implementation、显式 Gemini 模型、原生 model/cwd/session 核验、文件产物 | 无图片协议；analysis 不是强制只读 |
| WorkBuddy | analysis/implementation、backend default、stream-json、后台任务终态、文件产物 | 不证明具体底层模型；无远端取消确认 |
| OpenCode | 两条 Command Code Flash 路线、独立文本 analysis、最终 step/session 解析 | 不开放 implementation；事件不回显模型，故保持未验证 |
| 豆包 | 统一 Adapter、空白会话、Enter 前 checkpoint、conversation 身份、稳定回复 | 需用户准备 CDP；无原生取消；不报告具体模型 |
| TRAE CN | 统一 Adapter、workbench 身份、POST 前 checkpoint、native task ID、零自动审批、额度错误映射 | 需用户启动 IDE 与本地 gateway；无原生取消；不报告具体模型 |
| CLI / MCP | 同一 Core；MCP 10 个统一工具；CLI JSON/table 输出；status/list 只读 | 新插件工具需要重新安装并在新 Codex 任务中拾取 |

## 模型字段

每个调用始终保存：

- `model_requested`：调用方写入的模型或 `default`。
- `model_resolved`：Policy 在本次登记时解析出的具体模型；backend default 可为 null。
- `model_reported`：原生运行期确实回显的模型；没有证据时为 null。
- `model_verified`：原生证据与解析结果可验证匹配时才为 true。

这不是每次扫描所有 Provider 是否可用。静态 `list_models` 只列 allowlist；`probe` 只做对应目标声明的连接/版本/握手检查；真实额度和模型可用性仍可能在 submit 时变化。

## 保留的产品边界

- 不自动安装 CLI、启动桌面应用、登录、处理审批或切换计费路线。
- `analysis` 表达任务意图，不是硬只读；当前没有 Adapter 宣称 `enforced-read-only`。
- 本地结束进程不等于远端已取消。发送后的未确认取消进入 `indeterminate`。
- 输出路径与 hash 验收不能替代功能、视觉或语义验收。
- 默认状态目录是 `%LOCALAPPDATA%\uAgents\v1`；旧版状态不自动迁移或删除。

## 尚未接入

Claude Code、Grok、Pi 只有 help 级候选契约，不在 target allowlist；Cursor Agent 未发现；独立 Gemini CLI 未接入。候选证据见[候选 CLI 调用契约](../verification/2026-09-03-cli-candidate-contracts.md)。Codex 原生 `luna_max`、`sol_max`、`explorer`、`web_researcher`、`council_runner` 仍属于全局编排层，不复制进插件。

## 下一步

1. 完成干净复制、插件校验、个人 marketplace 重装和新 Codex 任务中的统一工具发现。
2. 在用户明确同意额度消耗后，分别执行五个目标的最小 live smoke；失败不自动回退。
3. 增加可验证的 heartbeat/陈旧 Worker 恢复、系统重启耐久性和保留/清理策略。
4. 评估图片输入、原生 resume/cancel、真正 enforced-read-only 与 Agent Profile 层。
5. 公开发布前补顶层许可证、版本/变更日志和完整供应链清单。

统一设计和 Gate 记录见[设计文档](../superpowers/specs/2026-09-04-uagents-unified-agent-runtime-design.md)与[实施计划](../superpowers/plans/2026-09-04-uagents-unified-agent-runtime-implementation.md)。
