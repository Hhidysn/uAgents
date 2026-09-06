# Durable Native Execution Gate E 安装验收

日期：2026-09-06。发布候选版本：`0.2.0-alpha.1+codex.20260906212805`。

## 提交基线

- Gate A：`686b02d feat: add durable native process ledger`
- Gate B：`6702f32 feat: guard durable workspace executions`
- Gate C：`f71a891 feat: add durable cli execution substrate`
- Gate D：`fa01ca5 feat: make OpenCode execution durable`
- Release-candidate metadata：`2fd090b chore: version durable execution release candidate`

## Provider-free 门禁

最终执行：

```text
Core: 238/238
Doubao MCP: 11/11
TRAE MCP: 9/9
Unified MCP: 2/2
Total: 260/260
```

决定性的 durable recovery / dual-writer / transcript 子集为 `25/25`。其中包括：Worker 在 native session 出现前死亡后从原 Attempt 的 process/transcript 恢复；accepted 后 Worker 死亡、lease 过期时仍阻止第二个重叠 workspace writer；recovery 不生成第二个 native process，prompt count 始终为 1。

`agent-dispatch` Skill validator、插件 validator 和 `git diff --check` 全部通过。

## Marketplace 与安装缓存

个人 marketplace 源同步到：

`C:\Users\24590\plugins\uagents`

同步只包含 `git ls-files plugins/uagents` 返回的已跟踪插件文件。同步前的旧源完整保留在：

`C:\Users\24590\plugins\uagents-backup-before-20260906212805`

随后执行正常安装流程：

```text
codex plugin add uagents@personal --json
```

Codex 返回并启用：

`C:\Users\24590\.codex\plugins\cache\personal\uagents\0.2.0-alpha.1+codex.20260906212805`

仓库插件目录、marketplace 源、新安装缓存三者均为 `117` 个文件、`4,106,601` 字节；逐文件 SHA-256 `117/117` 一致，marketplace 和 cache 均无额外文件。旧缓存没有删除。

## Fresh Codex 宿主验证

启动独立 `codex exec --ephemeral --sandbox read-only` 进程，并明确禁止调用 uAgents 的 `submit`、`probe`、`ensure`、`reconcile`、`resume`、`cancel`、`stop` 或任何 Agent/provider。

该新进程实际读取的 Skill 位于：

`C:\Users\24590\.codex\plugins\cache\personal\uagents\0.2.0-alpha.1+codex.20260906212805\skills\agent-dispatch\SKILL.md`

随后它仅从该安装根执行本地 discovery 命令，确认：

- `targets`：`agy`、`workbuddy`、`opencode`、`doubao`、`trae`
- OpenCode modes：`analysis`、`implementation`
- OpenCode file inputs/outputs：`true/true`
- OpenCode routes：`commandcode-goat/deepseek/deepseek-v4-flash`、`commandcode-goat/z-ai/glm-5.3-flash`

fresh Codex 进程本身使用 Codex 模型完成宿主级只读验证，但没有通过 uAgents 向 OpenCode 或其他目标发送任务，也没有消耗这些目标的 provider quota。

## 结论与边界

Durable Native Execution Gate A–E 的 provider-free 本地发布候选验收完成：源码、marketplace、安装 cache 和 fresh Codex 宿主加载已相互印证。Windows OpenCode durable execution/recovery 已进入当前安装缓存。

本次没有执行真实 OpenCode provider crash smoke，也没有把该构建声明为公开发行。真实 provider crash smoke 仍需要单独明确授权；非 Windows OpenCode 仍保留旧 uninterrupted transport，直到有等价 PID/start-time/executable ownership 证据。
