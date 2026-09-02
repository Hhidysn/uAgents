# uAgents 干净安装验证

日期：2026-09-02。插件版本：`0.1.0-alpha.6`。实施起点：`492ff4d`。

## 安装方式

本机此前没有默认个人 marketplace，也没有安装 `uagents`。按 Codex `plugin-creator` 的默认个人市场流程创建：

- 源副本：`C:\Users\24590\plugins\uagents`
- marketplace：`C:\Users\24590\.agents\plugins\marketplace.json`
- 选择器：`uagents@personal`
- Codex 安装缓存：`C:\Users\24590\.codex\plugins\cache\personal\uagents\0.1.0-alpha.6`

源副本只复制 `git ls-files plugins/uagents` 返回的 55 个文件，并逐文件比较 SHA-256。没有复制 `node_modules`、`.local`、`.git` 或 `third-part-research`；Codex 缓存同样是 55 个文件，共 3,060,386 字节。`codex plugin add uagents@personal --json` 返回版本 `0.1.0-alpha.6`，随后 `codex plugin list` 显示 installed/enabled。

本机旧 `validate_plugin.py` 仍拒绝 Agent Plugins v1 标准 `.mcp.json` 的 `$schema` 字段。没有删除 schema 来迎合旧校验器；实际 Codex CLI 已接受并安装同一份 manifest/MCP 配置。

## 安装缓存验证

新增 `scripts/verify-installed-plugin.mjs`，直接以任意插件根和外部状态目录验证：

1. manifest 名称、版本、Skill 和 MCP 声明。
2. 五份按需 reference 文件。
3. 禁止出现研究目录、依赖目录、Git 元数据和本地状态。
4. 从目标插件根启动两个预构建 stdio MCP，完成 `initialize`、`tools/list` 与 connection-only probe。

从 Codex 安装缓存运行得到：

| 服务 | 工具 | probe 结果 |
| --- | --- | --- |
| `uagents-doubao-work` | `doubao_probe/submit/status/result` | `cdp_unavailable`；没有启动豆包工作或发送任务 |
| `uagents-trae-cn` | `trae_probe/submit/status/result` | `gateway_unavailable`；没有启动 TRAE/网关或发送任务 |

这两个错误是预期的环境状态，证明服务能独立初始化且应用缺席不会阻止插件安装。Skill 在 `PYTHONUTF8=1` 下通过官方本地 quick validator。默认 GBK 下 validator 自身读取 UTF-8 中文 `SKILL.md` 会抛 `UnicodeDecodeError`，不属于 Skill 格式失败。

## CLI 无额度检查

从安装缓存的绝对 `agent-call.mjs` 路径，在 `F:\documents\software\uAgents\.local\verification\空格 路径\安装缓存调用` 作为当前目录运行：

- agy、WorkBuddy、OpenCode 三个 `capabilities` 均成功返回。
- agy probe 使用请求 `f5d4a7c6-b908-4e0a-adcc-f23522f259ca`，原生模型 `gemini-3.1-pro-low`、会话 `4477ed9c-2a05-484c-98e2-f98644166f9a`、cwd 和 57 个工具完成握手，终态 succeeded/preflight_only，`submission:not_sent`。
- WorkBuddy probe 使用 request `b9287f4f-56be-4541-a0a0-759598f7f2fd`，只返回版本 2.132.0，终态 succeeded/version_only，`submission:not_sent`。
- OpenCode probe 使用 request `dc02ce13-fc0c-4863-93ef-e02c22e8e271`，只返回版本 1.18.13，终态 succeeded/version_only，`submission:not_sent`。

这些 probe 没有提交模型 prompt，不证明账户余额、每日积分或真实任务仍可用。TRAE 已知积分不足，本次没有重试。

## 尚待新任务验证

Codex 当前任务不会热加载安装后新增的 Skill 和 MCP 工具。按 plugin-creator 的更新规则，必须新建 Codex 任务后检查 `agent-dispatch`、`doubao_*` 与 `trae_*` 是否进入宿主上下文。当前已经验证文件、协议和 CLI 安装状态，不能把新任务拾取写成已完成。

安装过程没有修改全局 `C:\Users\24590\.codex\AGENTS.md`、登录配置或供应商设置。用户的仓库 `.gitignore` 修改保持原 SHA-256 并继续单独未提交。
