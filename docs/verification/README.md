# 验证证据

本目录保存按日期命名的测试、安装、实机和真实 Provider 调用记录。记录对应当时的构建与环境；当前能力定义见 [当前设计与使用](../current/README.md)。

## 主要入口

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
