# uAgents 当前进度

日期：2026-09-02；2026-09-04 更新；2026-09-05 更新受管 Agent 生命周期。当前目标版本：`0.2.0-alpha.1`。

## 当前结论

原先的三条 CLI 路线和两个目标专用桌面 MCP 已重构为一个统一 Runtime：一个 versioned request、一个结果 envelope、一个 SQLite WAL 控制面、五个普通 Adapter，以及共享这些能力的本地优先 CLI 和可选 stdio MCP。2026-09-04 已验证本地 uAgents CLI → Worker → OpenCode → Command Code 的环境变量鉴权真实 E2E；插件 MCP 因宿主环境转发边界保留为兼容入口。2026-09-05 起桌面目标由 uAgents 受管：自动发现/验证本机安装，`submit` 自动启动专用隔离 Profile 实例（Host lease 跨 Task DB 防双开），首次登录通过同 UUID `submit` 或 `resume` 在原 Attempt 上恢复。

| 模块 | 当前能力 | 仍有边界 |
| --- | --- | --- |
| Protocol / Policy | 精确字段校验、Capability 匹配、显式 model/default 解析、禁止 fallback 和未实现 cost cap | 尚无自动模型推荐或动态价格预算 |
| Store / Runtime | SQLite WAL、Task/Attempt/Session、32 进程 UUID 幂等、checkpoint、lease/fencing、取消意图、显式 reconcile、waiting_user/preflight_login 恢复 | `node:sqlite` 在支持的 Node 版本仍会警告；未做系统重启/休眠耐久测试 |
| Host 控制面 | `%LOCALAPPDATA%\uAgents\host-v1` 独立 Host DB（WAL、epoch/fencing lease）、安装缓存、受管实例记录、确定性发现排序（显式路径→缓存→App Paths→卸载注册表→已知目录→PATH） | 不做全盘扫描；SHA-256 只强制用于小型 CLI 入口 |
| Supervisor | ensure/inspect/stop；端口身份核验（未知进程占用→`port_identity_mismatch`）；所有权=PID+启动时间+安装树路径；`stop` 拒绝非自有实例 | 不接管用户日常窗口；发送前失败保持 `submission=not_sent` |
| agy | analysis/implementation、显式 Gemini 模型、原生 model/cwd/session 核验、文件产物、受管入口注入 | 无图片协议；analysis 不是强制只读 |
| WorkBuddy | analysis/implementation、backend default、stream-json、后台任务终态、文件产物、受管入口注入 | 不证明具体底层模型；无远端取消确认 |
| OpenCode | 两条 Command Code Flash 路线、独立文本 analysis、最终 step/session 解析、受管入口注入 | 不开放 implementation；事件不回显模型，故保持未验证 |
| 豆包 | 受管自动启动（Gate 0 证实 `--user-data-dir`+CDP 隔离）、chat surface ready 判定、登录等待→原 Attempt 恢复、空白会话、Enter 前 checkpoint、conversation 身份、稳定回复 | 无原生取消；不报告具体模型；真实消息 E2E 待发布后执行 |
| TRAE CN | 受管 gateway+桌面双启动、capability token（仅 secrets 文件+内存）、instance nonce 反仿冒、gateway-only 崩溃修复、workbench 身份、POST 前 checkpoint、native task ID、零自动审批、额度错误映射 | 无原生取消；不报告具体模型；gateway 版本白名单待补；真实消息 E2E 待发布后执行 |
| CLI / MCP | 同一 Core；本地默认 CLI；MCP 13 个兼容工具（新增 ensure/resume/stop）；CLI `ensure`/`resume`/`stop`；capabilities 暴露 lifecycle 声明；status/result 暴露 lifecycle 摘要 | 新插件版本需要重新安装并在新 Codex 任务中拾取 |

## 模型字段

每个调用始终保存：

- `model_requested`：调用方写入的模型或 `default`。
- `model_resolved`：Policy 在本次登记时解析出的具体模型；backend default 可为 null。
- `model_reported`：原生运行期确实回显的模型；没有证据时为 null。
- `model_verified`：原生证据与解析结果可验证匹配时才为 true。

这不是每次扫描所有 Provider 是否可用。静态 `list_models` 只列 allowlist；`probe` 只做对应目标声明的连接/版本/握手检查（只读、不启动）；真实额度和模型可用性仍可能在 submit 时变化。

## 保留的产品边界

- 不自动安装 CLI、登录、处理审批或购买额度；桌面应用由 uAgents 以专用隔离 Profile 启动并管理，但绝不接管用户自己的窗口。
- `analysis` 表达任务意图，不是硬只读；当前没有 Adapter 宣称 `enforced-read-only`。
- 本地结束进程不等于远端已取消。发送后的未确认取消进入 `indeterminate`。
- 输出路径与 hash 验收不能替代功能、视觉或语义验收。
- 默认状态目录是 `%LOCALAPPDATA%\uAgents\v1`；Host 控制面固定在 `%LOCALAPPDATA%\uAgents\host-v1`，不受 `--state-dir` 影响；旧版状态不自动迁移或删除。
- Provider 凭据、gateway capability token 和 Profile 内容不进入 uAgents 数据、日志或结果。

## 尚未接入

Claude Code、Grok、Pi 只有 help 级候选契约，不在 target allowlist；Cursor Agent 未发现；独立 Gemini CLI 未接入。候选证据见[候选 CLI 调用契约](../../verification/2026-09-03-cli-candidate-contracts.md)。Codex 原生 `luna_max`、`sol_max`、`explorer`、`web_researcher`、`council_runner` 仍属于全局编排层，不复制进插件。

## 下一步

1. 完成干净复制、插件校验、个人 marketplace 重装，并在新 Codex 任务中对启用目标执行安装后真实 E2E（含首次登录恢复路径）。
2. 补齐 TRAE gateway 版本兼容白名单（当前 honest-degraded，DOM fallback 可用）。
3. 在用户明确同意额度消耗后，分别执行五个目标的最小 live smoke；失败不自动回退。
4. 在已有 lease heartbeat 基础上增加陈旧 Worker 的自动检测辅助、系统重启耐久性和保留/清理策略。
5. 评估图片输入、原生 resume/cancel、真正 enforced-read-only 与 Agent Profile 层。
6. 公开发布前补顶层许可证、版本/变更日志和完整供应链清单。

统一设计、受管生命周期设计与 Gate 记录见[统一 Runtime 设计](../superpowers/specs/2026-09-04-uagents-unified-agent-runtime-design.md)、[受管生命周期设计](../superpowers/specs/2026-09-04-uagents-managed-agent-lifecycle-design.md)与[实施计划](../superpowers/plans/2026-09-05-uagents-managed-agent-lifecycle-implementation.md)；受管启动契约证据见[启动 spike 验证](../../verification/2026-09-05-managed-launch-spike.md)。
