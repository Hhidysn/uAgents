# uAgents 当前状态与能力矩阵

日期：2026-09-06（Asia/Shanghai）。项目目录：`F:\documents\software\uAgents`。

本文是当前状态入口，专门回答两个问题：OpenCode 是否支持文件修改编码，以及已安装缓存、最新提交版和当前工作树是否一致。

## 一句话结论

OpenCode 目前是“独立文本分析目标”，不是文件编码执行目标。已安装插件、仓库最新提交版和当前未提交工作树
都将它声明为 `analysis`，文件输入/输出均关闭，`workspace_write` 也关闭；提交 `implementation` 会在 Worker
启动前被 Policy 拒绝。因此，之前“OpenCode 子插件只下发文本分析，没有文件修改编码功能”的说法仍然准确，
而且不是只针对某一份过期安装缓存。

## 版本事实

| 层次 | 当前事实 | 结论 |
| --- | --- | --- |
| 插件 manifest | `0.2.0-alpha.1+codex.20260905113451` | 源码和安装缓存的版本字符串相同 |
| 最新提交版 | `HEAD=a347af0`，提交信息为 `docs: verify installed cache mcp tool surface` | 这是当前仓库的最新已提交基线 |
| 当前工作树 | 在 `HEAD` 之上仍有未提交的 Runtime 可靠性、受管生命周期和 advisory permission 修改 | 不是已安装包；不要把工作树代码当成已发布 |
| 实际安装缓存 | `C:\Users\24590\.codex\plugins\cache\personal\uagents\0.2.0-alpha.1+codex.20260905113451` | 当前 Codex 使用的本地安装版本 |

核对依据：源和缓存的 manifest 版本相同；安装缓存缺少工作树新增的
`src/policy/advisory.mjs`，而当前工作树包含该文件；安装缓存中的 Runtime 与最新提交版语义一致，
仅有打包换行/末尾换行差异。因此“安装缓存”和“未提交工作树”必须分开描述。

本次核对使用了以下只读命令：

```powershell
node "C:\Users\24590\.codex\plugins\cache\personal\uagents\0.2.0-alpha.1+codex.20260905113451\bin\uagents.mjs" targets
node "C:\Users\24590\.codex\plugins\cache\personal\uagents\0.2.0-alpha.1+codex.20260905113451\bin\uagents.mjs" capabilities opencode
node "C:\Users\24590\.codex\plugins\cache\personal\uagents\0.2.0-alpha.1+codex.20260905113451\bin\uagents.mjs" models opencode
node plugins/uagents/bin/uagents.mjs capabilities opencode
```

已安装 CLI 和工作树 CLI 对 OpenCode 返回相同的能力声明；安装 CLI 另返回目标集合
`agy`、`workbuddy`、`opencode`、`doubao`、`trae`，以及两条显式 OpenCode 路线：
`commandcode-goat/deepseek/deepseek-v4-flash` 和 `commandcode-goat/z-ai/glm-5.3-flash`。

## 实际能力矩阵

下面的“文件输入/输出”是 uAgents 协议能力，不等于目标原生应用理论上永远不能处理文件。

| 目标 | 模式 | 文件输入 | 文件输出 | 图片 | 模型选择 | 运输与生命周期 | 主要限制 |
| --- | --- | ---: | ---: | ---: | --- | --- | --- |
| agy | `analysis`、`implementation` | 是 | 是 | 否 | 显式 Gemini | CLI；继承环境 | 无硬只读；模型/cwd/会话核验依赖原生回显 |
| WorkBuddy | `analysis`、`implementation` | 是 | 是 | 否 | 后端默认 | CLI；继承环境 | 后端模型不具备可验证具体身份；无远端取消确认 |
| OpenCode | `analysis` | 否 | 否 | 否 | 两条显式 Command Code Flash 路线 | CLI；继承环境 | 不支持文件编码、`implementation`、文件产物；模型不从事件流回显 |
| 豆包工作 | `analysis` | 否 | 否 | 否 | 后端默认 | CDP；受管隔离 Profile | 无原生取消；不回显可验证模型；真实消息 E2E 尚未作为发布前证据完成 |
| TRAE CN | `analysis`、`implementation` | 否 | 是 | 否 | 后端默认 | gateway；受管隔离 Profile | 不接受显式文件输入；无原生取消确认；模型不可靠回显；gateway 白名单待补 |

当前全部目标的静态权限字段都是：`native=true`、`advisory_read_only=true`、
`enforced_read_only=false`、`workspace_write=false`、`full_access=false`。这意味着：

- `analysis` 是任务意图，不是硬性只读。
- `advisory-read-only` 只追加不修改文件/不运行变更命令的提示，不能阻止同一用户权限下的原生 Agent 写入。
- `implementation` 只在目标能力表允许时开放原生编辑流程；它不等于 uAgents 提供了目录级写入沙箱。
- 文件产物捕获、路径校验和 SHA-256 验证是交付验收证据，不是执行隔离。

## OpenCode 证据链

1. 源码 Registry 将 OpenCode 定义为 `modes: ['analysis']`、`inputs.files: false`、`outputs.files: false`：
   [builtins.mjs](../../plugins/uagents/src/registry/builtins.mjs#L21)。
2. Policy 在注册前拒绝不匹配的模式、文件输入和文件输出：
   [evaluate.mjs](../../plugins/uagents/src/policy/evaluate.mjs#L32)。
3. 回归测试明确验证 `implementation` 在 Adapter 执行前被拒绝，且不会创建 Task：
   [unified-cli-adapters.test.mjs](../../tests/unified-cli-adapters.test.mjs#L58)。
4. 已安装缓存的真实 CLI 查询结果为：

   ```text
   modes: ["analysis"]
   inputs:  {"text":true,"files":false,"images":false}
   outputs: {"text":true,"files":false,"images":false}
   workspace_write: false
   ```

5. OpenCode reference 也明确写出 `Implementation and file inputs are rejected before launch`：
   [opencode-council.md](../../plugins/uagents/skills/agent-dispatch/references/opencode-council.md)。

因此，OpenCode 当前可以用于独立方案、代码审查意见、文本分析和多模型会审；如果目标是让子 Agent 直接改项目文件，
应使用当前已开放实现模式的 agy、WorkBuddy 或 TRAE（仍须接受各自的权限和真实验证边界）。

## 已实现但仍有边界的公共能力

- 统一 Schema 1.0、能力匹配、显式模型路线、四个模型身份字段和结构化错误。
- SQLite WAL 控制面、Task/Attempt/Native Session 分离、同 UUID 幂等、发送前 `possibly_sent` 检查点、
  lease/fencing、有限排队、未发送任务恢复和显式 reconcile。
- CLI-first 调用与一个兼容 stdio MCP；MCP 当前暴露 13 个统一工具。
- CLI 入口发现/校验缓存；豆包和 TRAE 的专用隔离 Profile、Host lease、首次登录等待和原 Attempt 恢复。
- 声明式文件输入快照、输出捕获、路径范围检查和 SHA-256 验证；这些是验收机制而非安全沙箱。

## 仍需补齐的功能

按影响和依赖排序：

| 优先级 | 缺口 | 影响 | 建议验收 |
| --- | --- | --- | --- |
| P0 | OpenCode implementation + 文件输入/输出 | 无法用 OpenCode 子 Agent 直接改代码 | 先确认 OpenCode 原生非交互编辑/权限参数和 JSON 事件契约；再独立加入能力注册、Policy、Adapter、产物和回归测试；未证实前保持拒绝 |
| P0 | 真正的权限隔离 | advisory 提示不能防越界写入，`workspace-write`/硬只读当前不可用 | 对每个目标验证原生沙箱、允许路径、命令/网络边界；做不到就继续 fail-closed，不把 diff 检查当隔离 |
| P1 | 图片/多模态通道 | 五个目标都不能通过统一协议接收图片 | 固定 MIME、大小、快照、脱敏和目标能力后，再按目标逐个开放 |
| P1 | 原生取消与多轮 resume | 豆包/TRAE 取消后只能进入未知；所有 CLI 续接能力仍有限 | 保存并验证原生任务身份，证明远端终止或同会话续接；不确定时保持 `indeterminate` |
| P1 | 模型身份与额度证据 | WorkBuddy/桌面目标不能证明具体模型；probe 不能证明真实额度 | 仅在原生事件或受信接口能绑定时设置 `model_verified=true`；补显式 live smoke |
| P1 | 真实消息 E2E | 目前大量证据是 fixture、连接探测或版本探测 | 在用户明确允许额度消耗后，分别完成五个目标最小真实闭环，不自动 fallback |
| P2 | TRAE gateway 版本白名单 | 当前可用但为 honest-degraded，升级后兼容性风险较高 | 固定版本指纹、适配器版本和兼容性回归；未知版本明确降级或阻断 |
| P2 | 状态保留/清理策略 | 长期运行可能积累 Prompt、结果、快照和产物，当前保留上限仍不完整 | 区分必要结果与诊断日志，定义容量/保留期、活动任务保护和显式清理 |
| P2 | 发布工程 | 当前有版本字符串和第三方通知，但顶层许可证、变更日志、供应链清单仍待补 | 干净包、重装、新任务拾取、版本/哈希/许可证和升级回滚形成发布清单 |

## 验证状态与限制

当前工作树的最近一次完整修复验证记录为 [2026-09-06 Runtime reliability repair verification](../verification/2026-09-06-runtime-reliability-fixes.md)，
记录为 Core/集成 169 项、豆包 MCP 11 项、TRAE MCP 9 项、Unified MCP 2 项，共 191 项通过。

这份数字证明的是测试套件在隔离状态和 fake/injected transport 下通过，不证明真实 Agent 已修改项目、真实账户已登录、
额度可用、桌面消息闭环或当前工作树已经安装。尤其需要注意：该验证记录明确写着工作树修复尚未安装到用户插件缓存。

完成发布前还应重新执行：

```powershell
npm test
python C:\Users\24590\.codex\skills\.system\skill-creator\scripts\quick_validate.py plugins/uagents/skills/agent-dispatch
python C:\Users\24590\.codex\skills\.system\plugin-creator\scripts\validate_plugin.py plugins/uagents
git diff --check
```

并把“源码提交、工作树、安装缓存、新 Codex 任务拾取、真实目标 E2E”分别记录，不能合并成一个“已安装并可用”的结论。
