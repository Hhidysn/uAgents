# 2026-10-07 默认观察预算调整

按用户要求把新 Task 默认观察预算从十分钟提高为二十分钟（1200000ms），本地部署版本 `uagents@0.2.0-alpha.3`。此前 alpha.2 Flash 实机记录保留其当时的十分钟默认配置；那三项 Task 本身显式设置了二十分钟。

`run` 在省略观察参数时也使用二十分钟默认预算计算等待时间，额外留一分钟收尾（21 分钟）；修复了仅修改 Task 默认值会让 CLI 仍在十五分钟提前返回的问题。显式较短观察预算、显式 CLI 等待预算继续有效，已有持久 Task 的执行参数不变。

代码中的协议默认、JSON Schema/CLI discovery、Skill、协议示例和当前文档同步。观察上限仍为二十分钟；该设置是观察预算，支持目标的硬执行期限仍单独配置。

`node --test tests/protocol.test.mjs tests/cli-convenience.test.mjs`：24/24 通过，验证省略字段、显式覆盖、JSON Schema、CLI 参数说明及默认等待计算。部署前重新构建 bundle，并通过 npm pack 内容检查。安装后以 `uagents schema request` 和 `uagents describe run` 核验二十分钟默认值，不发送模型任务。
