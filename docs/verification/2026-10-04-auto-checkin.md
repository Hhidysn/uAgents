# 2026-10-04 自动签到验证

## 构建身份

- Git 基线：`562b69478733c56d1a6400d95ea08b74429ef9a7`，验证对象为其上的本次未提交工作树。
- 插件构建：`0.2.0-alpha.1+codex.20261004011147`。
- 环境：Windows，Node.js `v24.13.0`，本机时区 Asia/Shanghai。
- 验证客户端：WorkBuddy `5.7.3`；TRAE 使用现有 TRAE SOLO CN 个人登录态。
- 没有新增 npm 或 Python 依赖。

统一 MCP bundles 的 SHA256：

| 文件 | SHA256 |
| --- | --- |
| `server.mjs` | `1a1d0eb82d8087a699790a31c046d1e4e8e5f6d18095a813415130060592a4d0` |
| `service.mjs` | `62b41861e57295034393a82341aeee5c254531c4db580ed8ada9def9ef5a9921` |
| `bridge.mjs` | `f78cdbfabb5f1a1c1404a8e478534cd1dc37d3d350e164fa109ff97eadba5d95` |

## 已执行检查

| 命令 | 结果 |
| --- | --- |
| `npm run test:checkin` | 22/22；含原格式加密向量、损坏凭据、过期登录、域限制、已签/只查询/状态失败、领取丢失后的观察、明确限流重试、独立账号、启停、不可变部署、物理路径和真实隐藏启动器 |
| `node --test tests/unified-cli.test.mjs tests/plugin-package.test.mjs` | 22/22，包含 19 项 CLI 与 3 项分发测试 |
| `npm --prefix plugins/uagents/mcp/unified test` | 提交复检重新构建后 27/27；含共享服务与 registry 的签到目标交集、无效 registry 隔离；原 20 工具保持一致，stdio / HTTP / bridge 回归通过 |
| `node --test tests/plugin-package.test.mjs` | 补充复制插件的签到入口断言后 3/3；无 node_modules 且不访问真实 Provider |
| `git diff --check` | 按仓库默认换行配置通过 |
| 提交复检静态检查 | 9 份变更文档的 61 个本地链接、8 个 JS 入口语法、2 份 JSON；部署启动器和调度脚本的 PowerShell AST 解析均通过 |

测试的环境和原生凭据均为隔离 fixture。MCP smoke、安装核验脚本显式禁用自动注册，避免测试修改真实每日任务。没有运行整个仓库测试；没有向任何模型发送 Prompt。

提交复检修正了共享服务签到入口忽略 registry 禁用设置的问题，并在实际迁移前再次检查旧任务状态，避免将两次查询之间启动的旧任务停用。当前文档保留现行行为说明，实测过程集中记录在本文件。

## 真实登录与签到

以下为首次实现的本机实测记录。提交复检仅运行隔离检查，没有重新领取真实积分、触发或更新本机任务；服务 bundle 的首次实测 SHA256 为 `7e66bfd6af6a262d54dfc9f19188e2b731c2f44e071cc2da08e7179957e7ac8c`，提交复检的 bundle 身份见上表。

1. 读取本机客户端登录态：TRAE SOLO CN 与 WorkBuddy 均为有效登录。WorkBuddy 当前 `accessToken` 为加密对象；通过本机 WorkBuddy 自身组件成功解密，仅输出登录存在与来源。
2. `checkin --check-only` 首次查询两边均为未签。TRAE 之后执行领取并确认 Provider 状态已签。
3. WorkBuddy 的状态查询一直返回 `today_checked_in=false`，但领取接口返回 HTTP 400、code 10001、明确的“今天已签到，请明天再来”。实现仅接受该明确回复，并保留 `verification=provider_already_checked_in`、`status_query_checked=false`。不同含义的 10001 fixture 被判失败。
4. Windows 真实 `uAgents.AutoCheckin` 任务通过 `Start-ScheduledTask` 独立运行，在共享用户目录写出报告，`LastTaskResult=0`。最终报告两边均为 `already_checked_in`；TRAE 由状态查询确认，WorkBuddy 由明确的已签回复确认。

当前任务配置：当前用户 Interactive / Limited，Daily 00:30，StartWhenAvailable，IgnoreNew，五分钟执行上限，隐藏启动。核验时下一次触发为 **2026-10-05 00:30 +08:00**。

运行目录版本：`7c228ef7238995dc4baeb5948aee33ee3e10accd9e790efe9f4c33cdf36f6bae`。

本机报告：`C:\Users\24590\.uagents\checkin-v1\last-result.json`。旧 `AutoCheckin` 已停用，原 XML 备份为同目录下的 `legacy-AutoCheckin.xml`；原 `F:\documents\software\auto-checkin` 脚本保留。

## 发现与修复

- 原 TRAE 脚本缺少 Python Crypto 依赖；插件改用 Node 内置 AES 与 SHA512。
- 原 WorkBuddy 脚本把新版加密对象当成字符串；插件使用客户端自身组件，兼容旧明文与本次验证的加密格式。
- 初始任务引用逻辑 AppData 路径，Windows 调度进程返回 `0x8007010B` / `0xFFFD0000`，未找到脚本。对照调度进程与调用方的路径存在性，并用 `fs.realpathSync.native` 确认 MSIX 重定向。最终默认共享用户目录、部署物理路径；从 Windows 调度进程执行成功。
- Windows 回读 Principal.UserId 为用户名而非输入 SID；按 SID 归一后重复 init 返回 `reused=true`，不重复替换任务。

调度进程排查使用的临时 `uAgents.CheckinSmoke` 任务已删除，未遗留第二个签到任务。

## 本机安装

更新现有 personal marketplace 的本地发布目录，保留旧发布目录备份，再执行 `codex plugin add uagents@personal --json`。安装返回的新构建目录为：

```text
C:\Users\24590\.codex\plugins\cache\personal\uagents\0.2.0-alpha.1+codex.20261004011147
```

旧发布目录备份：`C:\Users\24590\plugins\uagents-backup-0.2.0-alpha.1+codex.20261001182923`。

执行 `scripts/verify-installed-plugin.mjs <installedPath> .local\installed-checkin-verification`：清洁安装、Skill、MCP 初始化和全部 20 工具通过；OpenCode 仅版本 probe 成功，`version=2.0.21`、`submission=not_sent`。从实际安装目录执行 `init` 返回 `reused=true`，引用相同独立运行目录。

## 边界

未等待下一次日历触发；独立执行通过 Windows 计划任务的手动触发验证。没有替用户刷新、登录或拉起桌面 UI，没有外发飞书等通知。当前只支持两个中国区客户端的上述个人登录文件与验证过的格式；其它客户端版本、海外账号、受管隔离 profile 和注销 Windows 后执行未验证。凭据过期时跳过，依赖客户端自身登录态维护。

实现参考：[Windows 计划任务设置](https://learn.microsoft.com/en-us/powershell/module/scheduledtasks/new-scheduledtasksettingsset?view=windowsserver2025-ps)、[当前用户 Principal](https://learn.microsoft.com/en-us/powershell/module/scheduledtasks/new-scheduledtaskprincipal?view=windowsserver2025-ps)、[Electron Node 模式](https://www.electronjs.org/docs/latest/api/environment-variables)、[官方插件打包与本地安装说明](https://developers.openai.com/plugins/build/plugins)。接口与 TRAE 本地解密格式来自用户提供的 `auto-checkin` 项目，并经本机实测。
