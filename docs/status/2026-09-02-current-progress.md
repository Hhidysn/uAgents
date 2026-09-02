# uAgents 当前进度与预计下一步

日期：2026-09-02。安装实施起点：`492ff4d`。插件版本：`0.1.0-alpha.6`，已通过默认个人 marketplace 安装并启用。

## 当前结论

最初确定的拆分已经落地：一个按需加载的 `agent-dispatch` Skill 负责选择和解释调用方式，两个独立 MCP 分别承接豆包工作与 TRAE CN 的桌面任务。agy、WorkBuddy、OpenCode 继续走各自 CLI，不再为成熟 CLI 套一层 MCP。

当前已经具备可测试的五条调用路线，并完成了不含研究资料和 `node_modules` 的干净复制、Codex CLI 安装、Skill 格式检查、两个 MCP stdio 握手以及三个 CLI 的无提示词检查。当前任务不会热加载新插件，因此还需要在新建 Codex 任务中确认 Skill 与 MCP 真正进入宿主上下文；之后再扩展通用 Agent 定义和更多 CLI，不应立即增加第三个 MCP。

## 已完成

| 模块 | 已有能力 | 已验证边界 |
| --- | --- | --- |
| Plugin 外壳 | `plugins/uagents/` 内包含 manifest、一个 Skill、CLI 运行时与两个 MCP 声明 | 已创建默认个人 marketplace，Codex 报告 `uagents@personal` installed/enabled；安装缓存仅含 55 个跟踪文件 |
| 按需 Skill | 实际选择目标后，只读取该目标的一份 reference | 已有 agy、WorkBuddy、OpenCode、豆包工作、TRAE CN 五份说明 |
| CLI 任务运行时 | UUID 去重、原子任务记录、detached worker、状态/result 查询、超时和取消请求、预期产物路径/大小/摘要验收 | worker 退出、陈旧心跳和发送状态未知不会自动重放；尚未证明 Codex 退出、重启或休眠后仍可恢复 |
| agy / Gemini | analysis 与 implementation；implementation 使用原生 `accept-edits`，已完成真实文件产出 | 仅接文本任务；图片输入、图片产物和视觉验收尚未打包 |
| WorkBuddy | 使用本机内嵌 CLI 的单轮结构化输出，已完成真实文件产出 | 原生后台模式无法稳定回收，因此仍由 uAgents worker 持有进程；没有续接和原生取消确认 |
| OpenCode | DPF 与 GLM-5.2 的独立文本提案、共同题目和最终 step 解析 | 当前只允许两条既定路线且仅为 analysis；没有 `serve`、ACP、session 续接和 implementation |
| 豆包工作 MCP | `probe/submit/status/result`、UUID 去重、跨进程窗口锁、专属空白会话、边界后回复和稳定完成证据 | 真实成功闭环已完成；不启动应用、不自动审批、不公开未经验证的 cancel |
| TRAE CN MCP | 复用 `TRAECNclaw@0.6.0` 的可追溯发布包，增加 Windows、端口隔离、零重试和零自动审批补丁，再以四工具 stdio MCP 暴露 | 当前版本真实链路已到达原生任务并正确回收“积分不足”；同路线仅有 2026-08-30 历史成功证据，不把它写成当前成功复验 |
| 来源与测试 | 两个 MCP 的锁文件、上游哈希、许可证和第三方通知已进入发行目录 | 最近完整回归为根测试 52 项、豆包 8 项、TRAE 8 项，共 68 项通过 |

全局 `C:\Users\24590\.codex\AGENTS.md` 保持用户恢复后的内容，不由插件改写。第三方研究与源码位于 Git 忽略的 `third-part-research/`，不进入插件发行包。

## 尚未接入或记录不完整的调用方式

| 对象 | 本机情况 | uAgents 状态 | 处理建议 |
| --- | --- | --- | --- |
| Claude Code | `claude` 已在 PATH | 没有正式 reference、适配器或真实验收 | CLI 扩展的第一候选；先确认非交互权限、结构化输出、session 和产物契约 |
| Pi | `pi` 已在 PATH | 只有历史调研，没有正式接入 | 在确认稳定 headless/JSON 协议后再决定；优先级低于 Claude |
| Grok | `grok` 已在 PATH | 只有历史调研，没有正式接入 | 可作为独立文本意见路线；先核对额度、权限和结构化结果，不自动启用 |
| Cursor Agent | 本机未发现 `cursor-agent` | 未接入 | 没有可执行入口前不写适配器 |
| Gemini CLI | 本机未发现独立 `gemini` | 未接入 | 当前 Gemini 需求由 agy 承担；只有出现 agy 无法覆盖的明确需求时再加 |
| `traecli` | 本机未发现 | 已明确排除为当前 TRAE CN 额度路线 | 保留调研，不加入生产调用清单 |
| `trae-cn` | 已安装，但只是 IDE 启动器 | 不作为 headless Agent | 继续由 TRAECNclaw/CDP MCP 控制已经登录的桌面应用 |
| Codex 原生 `luna_max`、`sol_max`、`explorer`、`web_researcher`、`council_runner` | 由全局 Codex 配置提供 | 不复制到插件 reference | 它们是 Skill 选择前就可用的编排基础，继续留在全局层更合理 |

## 还缺的产品能力

- 分发：干净安装、CLI 列表和缓存内 MCP 握手已通过；当前任务无法热加载安装后的工具，仍需用新 Codex 任务做一次宿主拾取验证。尚未验证升级、卸载和公开 marketplace。
- 通用 Agent 定义：当前按“目标路线”保存调用说明，没有可复用的 `.agents/*.md` 角色定义、列表和 frontmatter 解析。
- 多模态：agy 尚未支持图片输入、截图上下文、图片文件回收或视觉质量验收。
- 权限：`analysis` 只是任务意图，不是硬性只读；目录检查也是事后验收，不能阻止越界写入。
- 生命周期：CLI 没有可靠的原生 resume/cancel；桌面 MCP 没有公开 cancel；系统重启、休眠、Codex 退出后的恢复尚未验证。
- 桌面控制：TRAE 的多网关全局窗口锁、完整结果裁剪、工作区信任和真实审批流程仍未完成。
- 运维：没有任务保留期、容量上限、清理命令、迁移和故障诊断汇总。
- 发布治理：仓库自身还没有顶层 LICENSE；需要在公开分发前明确许可证与第三方归属。

## 预计下一步

### 1. 完成新任务宿主拾取验收

`alpha.6` 已从仅含 Git 跟踪文件的个人源安装到 Codex 缓存。下一项实际工作是在新建 Codex 任务中验证：

1. Skill 列表中出现 `agent-dispatch`，实际选择一个目标时只读取对应 reference。
2. MCP 工具列表出现 `doubao_*` 与 `trae_*` 各四个工具；当前无应用/网关时 probe 仍保持 connection-only。
3. 当前任务中尚未加载的新工具不能被旧上下文误判为安装失败。

已完成的机械证据包括：中文/空格路径下三个 CLI capability、agy 原生 preflight、WorkBuddy 2.132.0 与 OpenCode 1.18.13 version-only probe，全部没有发送模型提示词。TRAE 当前积分不足，不为安装验证重复发送真实模型任务。完整记录见[干净安装验证](../verification/2026-09-02-clean-plugin-install.md)。

### 2. 增加轻量的 Agent Profile 层

借鉴 `sub-agents-skills` 的 `.agents/*.md` 做法，把“角色说明”与“后端调用细节”分开。第一版只解析扁平 frontmatter，并映射到已有 allowlist：

```markdown
---
target: opencode
model: opencode-go/deepseek-v4-flash
mode: analysis
---

# Code reviewer

只读检查指定改动，输出带文件证据的发现。
```

保留现有 reference 作为运输层说明；profile 只描述角色、范围、完成条件和输出格式。`target/model/mode` 必须通过当前适配器能力校验，不允许 profile 自行开启 `yolo`、替换计费路线或绕过用户权限。先支持 agy、WorkBuddy、OpenCode，桌面 MCP 等生命周期能够统一表达后再接入 profile。

### 3. 扩展 CLI 与多模型路线

按“已安装、协议稳定、用户价值”排序：Claude Code → Grok → Pi。每个新适配器都要完成版本探测、非交互结构化输出、权限映射、错误事件、真实小任务和产物验收；没有这些证据就只保留调研记录。

OpenCode 可在现有全局额度策略下增加 DeepSeek Pro 与 Gemini 3.1 Pro 的显式 opt-in 路线，但不能把它们设为默认，也不能在 DPF/GLM 失败后静默回退。

### 4. 补多模态与可靠性

先为 agy 增加图片输入和图片/前端产物验收，再处理原生 session 续接、取消确认、硬性只读/路径隔离、Codex 退出后的回收、桌面全局窗口锁和状态清理。每一项独立验收，不把本地进程结束当成远端任务已停止。

### 5. 准备发布

补顶层许可证、版本/变更日志、安装与环境准备说明、公开/仓库 marketplace 元数据和发布包清单。个人 marketplace 目前只用于本机预览；新任务拾取与升级/卸载验证通过后，才把 `alpha` 预览变成可日常安装版本。

功能取舍和可复用部分见 [sub-agents-skills 功能对比](../reviews/2026-09-02-sub-agents-skills-comparison.md)。
