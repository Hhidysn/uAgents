# 验证证据

本目录保存按日期命名的测试、安装、实机和真实 Provider 调用记录。记录对应当时的构建与环境；当前能力定义见 [当前设计与使用](../current/README.md)。

## 主要入口

- [pi CLI 接入](2026-10-06-pi-cli.md)：原生 JSONL 事件流、模型目录与安装校验、续接/分叉、文件与图片附件的真实调用与 provider 限制。
- [目标修复与登录后实机核对](2026-10-06-target-repair.md)：Claude 重试成功、Codex 账号模型限制、WorkBuddy 新入口与认证边界、豆包及 TRAE 原任务对账成功。
- [全 Target 与默认观察期限](2026-10-06-all-targets-timeout.md)：八项连接尝试、OpenCode/agy 四项真实任务、默认改为 10 分钟及本机安装验证。
- [Worker 初始化与 OpenCode Go](2026-10-06-worker-initialization-opencode-go.md)：初始化并发窗口修复、取消与失去所有权回归、移除本机旧服务商配置、两项真实文件修改/讨论验收。
- [npm 包分发](2026-10-06-npm-package-distribution.md)：包入口与 `files` 白名单、适配器按需加载、`npm pack` 内容核对与基线既有失败。
- [本地 CLI 与完整回归复核](2026-10-06-local-cli.md)：既有全局安装与工作树一致性、完整回归相对基线的额外失败、codex app-server 基线失败的真实原因（测试等待预算 vs 进程检查耗时）、负载 flakiness、trae 构建的 tar/cwd 环境问题与修复。
- [OpenCode V2 回执与时限修复](2026-10-04-opencode-v2-completion.md)：三条实际模型路由、原 Attempt 对账恢复、私有服务执行超时及定向回归。
- [L1 实际分发失败调查](2026-10-04-l1-dispatch-errors.md)：DeepSeek 原生 HTTP400、GLM 流恢复后误报失败、原日志回放与修复边界。
- [自动签到](2026-10-04-auto-checkin.md)：原生登录兼容、独立每日任务、实际安装与签到结果。
- [共享本地服务](2026-10-03-shared-local-service.md)：HTTP/stdio、认证与范围、调度恢复、Council 并发和路径检查。
- [插件安装与 OpenCode V2 兼容](2026-10-02-plugin-release.md)：构建与安装身份、原生版本及已知终态限制。
- [agy 原生自动批准](2026-10-02-agy-native-auto-approval.md)：启动策略与真实审查。
- [原生附件输入](2026-09-26-native-attachment-input.md)：Codex、Claude Code、DSH 等目标的原生映射和送达证据。
- [模型与路由](2026-09-25-model-routing.md)：配置默认值、显式模型与准入行为。
- [Codex app-server](2026-09-23-codex-app-server-spike.md)：Windows/Astra 显式会话路线与原生证据。
- [Claude Code CLI](2026-09-25-claude-code-cli.md)：原生 stream JSON 接入与模型核对。

其它记录按文件日期与主题查找。单次成功不证明其它模型、版本、账号或环境同样可用；失败、跳过与未验证行为应保留在对应记录中。

## 记录要求

记录被测提交或工作树、执行命令、实际结果、构建身份和运行环境。区分测试编写与执行、fixture 与真实 Provider、配置模型与可信原生自报；耗时、数量和原始过程放在记录中。

设计候选、方案争论和实施计划归入 [历史目录](../history/README.md)。仓库检查方法见 [开发与验证](../development.md)。
