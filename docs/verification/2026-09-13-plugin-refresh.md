# uAgents Codex 插件刷新实机验收

日期：2026-09-13。

安装版本：`0.2.0-alpha.1+codex.20260913014746`。

源码基线：`665bd31 feat: add attachment host ux integration`，外加本次 release manifest 版本更新。

## 目的

此前 Codex 实际启用的 `uagents@personal` 仍是 2026-09-07 的安装缓存：

`C:\Users\24590\.codex\plugins\cache\personal\uagents\0.2.0-alpha.1+codex.20260907011733`

该缓存不包含之后完成的 Dynamic Model Discovery、Council Validation Profiles 和 Attachment Host UX Integration。本次验收把当前仓库插件集合刷新到 personal marketplace source，并通过 Codex 正常插件安装流程生成新缓存。

## 安装流程

Personal marketplace source：

`C:\Users\24590\plugins\uagents`

旧 source 备份：

`C:\Users\24590\plugins\uagents-backup-before-20260913014746`

release set 只取 `git ls-files -- plugins/uagents`。同步后：

- repository tracked files：`136`
- marketplace source files：`136`
- repository ↔ marketplace SHA-256 mismatch：`0`

先执行 `codex plugin remove uagents@personal --json` 时，旧 cache 因当前 Codex 进程仍持有文件句柄而返回 Windows `os error 32`。没有手工删除被占用的 cache。随后正常执行：

```text
codex plugin add uagents@personal --json
```

安装成功并返回：

```text
version       0.2.0-alpha.1+codex.20260913014746
installedPath C:\Users\24590\.codex\plugins\cache\personal\uagents\0.2.0-alpha.1+codex.20260913014746
```

最终 `codex plugin list --json` 报告 `uagents@personal`：

```text
installed = true
enabled   = true
version   = 0.2.0-alpha.1+codex.20260913014746
```

旧 `0.2.0-alpha.1+codex.20260907011733` cache 仍保留；活动安装记录已经指向新版本。

## 三方文件验收

新 Codex cache：

`C:\Users\24590\.codex\plugins\cache\personal\uagents\0.2.0-alpha.1+codex.20260913014746`

结果：

```text
repository files          136
marketplace source files  136
installed cache files     136
repo -> source mismatch     0
repo -> cache mismatch      0
```

新 cache 明确包含近期能力文件：

```text
src/host/attachment-inputs.mjs
src/protocol/council-validation-profiles.mjs
src/runtime/model-discovery.mjs
```

repository 插件和 installed cache 均通过 plugin validator；installed cache 的 `skills/agent-dispatch` 也通过 Skill quick validator。

## 安装后 CLI smoke

所有命令均直接从新 cache 的 `bin/uagents.mjs` 运行，不使用仓库源码路径。

通过：

- `targets`：返回 `agy / workbuddy / opencode / doubao / trae`。
- `models opencode`：Dynamic Model Discovery 正常合并静态 allowlist 与本机 native catalog；两条 Flash route 为 `usable=true`，额外 native-discovered route 不自动获得 admission。
- `models workbuddy`：从 native CLI help 得到 backend-default 与当前 concrete model labels；只有 backend-default 保持 admission。
- `schema council-validation-profiles`：返回 `.uagents/validation-profiles.json` 的 machine-readable schema。
- `describe council-validate`：同时暴露 `--validation` 与 `--profile`，两者为同一 exclusive group。

这些命令没有提交任何 Agent prompt。

## 安装后 Unified MCP smoke

直接从新 cache 启动：

`mcp/unified/dist/server.mjs`

只执行 MCP `initialize` 与 `tools/list`。结果：

```text
server                         uagents-unified
tool count                     20
uagents_submit.attachments     present
uagents_submit.inputs          present
uagents_council_submit.attachments present
uagents_council_submit.inputs  present
uagents_council_validate.profile present
```

因此 Attachment Host UX 和 Validation Profiles 不只是文件存在，而是已经进入安装后 MCP tool schema。

## Provider 边界

本次新增 provider / Agent prompt 调用：`0`。

没有运行 `codex exec` fresh conversational-host smoke，因为它会启动真实 Codex 模型调用；按当前项目约束，provider-billable E2E 需要用户另行明确授权。

当前正在运行的 Codex 会话不会热切换刚安装的新 Skill/MCP，并且旧 cache 的文件锁已经实际证明这一点。新版本已经成为 Codex 插件管理器的 installed/enabled 版本；要验证“一个全新 Codex 对话实际加载新 Skill 并由模型调用新工具”，应在获得 provider 授权后使用 fresh Codex process/task 单独验收。
