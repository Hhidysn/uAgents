# 当前设计与使用

本目录描述当前仓库已实现的设计、功能和运行边界。设计讨论与旧方案见 [历史归档](../history/README.md)，测试与实机结果见 [验证证据](../verification/README.md)。

| 主题 | 阅读内容 |
| --- | --- |
| [快速开始](quick-start.md) | 插件入口、提交请求、查询结果与配置 |
| [当前架构](architecture.md) | Core、入口、执行进程、持久化与可靠性边界 |
| [Agent 与能力矩阵](agents.md) | 八个 target 的模式、输入、会话和权限 |
| [附件](attachments.md) | path/source/blob、宿主附件与原生映射 |
| [会话](sessions.md) | continuation/fork 与同 Task 恢复的区别 |
| [Council](council.md) | 并行候选、diff、validation、adopt 与 cleanup |
| [模型与路由](models.md) | 默认模型、单次选择、目录缓存与附件证据 |
| [Runtime 与生命周期](runtime.md) | 幂等、租约、恢复与受管实例 |
| [共享本地服务](service.md) | loopback HTTP MCP、stdio 桥接与服务范围 |

精确字段见 [协议与命令](../reference/README.md)，仓库构建和测试见 [开发与验证](../development.md)。
