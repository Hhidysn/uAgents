# Codex 对话选模型预检验证

日期：2026-09-26。仓库插件版本：`0.2.0-alpha.1+codex.20260926075443`。

## 实现

`agent-dispatch` Skill 在新 Task 注册前查询 `models <target>` 和按需查询 `capabilities <target>`。用户明确给出模型时按本次 ID 提交；用户要求先选时展示 selector、target 默认、来源和采集时间并等待回复；未指定且有默认时说明后继续，没有默认时请用户选择。具体 ID 缺席目录并不自动构成拒绝。模型目录只提供候选证据，不声称登录、额度或 Provider 在线。对话细节见 `skills/agent-dispatch/references/model-choice.md`。未修改通用 Task runtime 或原生适配器。

## 验证

| 检查 | 结果 |
| --- | --- |
| Skill quick validator、插件 validator | 仓库 Skill、marketplace source Skill 和插件均通过。 |
| `node --test tests/plugin-package.test.mjs tests/model-discovery.test.mjs tests/unified-cli.test.mjs` | 38 passed。 |
| 仓库 CLI `models codex` | 返回 `gpt-6-astra`、`gpt-5.6-luna` 两条 `configured` route；两者均不是 target 默认。 |
| 仓库 CLI `models trae` | 无新窗口或 Prompt；返回 22 行个人配置缓存候选，默认 selector 为 `trae-default`，来源 `local_profile_cache`，带快照 mtime 和 `partial` 状态。 |
| marketplace source 同步 | 151 个仓库插件文件复制后，仓库到 source SHA-256 mismatch 为 0。 |
| `codex plugin add uagents@personal --json` | 安装版本 `0.2.0-alpha.1+codex.20260926075443`；`codex plugin list --json` 报告 installed/enabled 均为 true。 |
| 安装缓存文件 | `SKILL.md`、新 `model-choice.md` 和 manifest 与仓库 SHA-256 相同；安装缓存 Skill quick validator 通过。 |
| 安装缓存 CLI `models trae` | 返回 22 行、默认 `trae-default`、来源 `local_profile_cache` 和快照时间；未发送 Task。 |

## 验证边界

这些检查验证了对话规则已进入安装版 Skill，以及预检命令能提供所需字段。**尚未在新的 Codex 对话中实测“展示菜单—等待用户选择—提交 Task”完整交互**；当前任务加载 Skill 时仍使用安装前的会话快照。插件更新后的 Skill 应由新 Codex 任务加载。此功能也不是 Codex 应用内的原生模型选择弹窗。
