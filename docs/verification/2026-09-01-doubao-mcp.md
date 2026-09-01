# 豆包工作 MCP 实施与验证

日期：2026-09-01。环境：Windows、Node 24.13.0、DoubaoWork 2.27.6、Chromium 147.0.7727.149、CDP 1.3。插件版本 `0.1.0-alpha.4`，未安装。

## 真实闭环

豆包最初未运行。直接以 `--remote-debugging-address=127.0.0.1 --remote-debugging-port=9222` 启动现有安装后，`/json/list` 只发现一个主聊天 page，排除了 cross-site-support、background 与云盘 iframe。未读取登录或认证文件。

第一次协议验证请求 ID `fd5055b8-62bd-4448-af4d-daf61ceee897`，目标 ID `D3B2D019E4254745A45C2E6B9C39C05E`。输入通过原生键盘事件发送后，页面从空白路由切换到原生会话 `38439807849723394`；用户气泡是边界第 0 项，唯一新增回复精确返回请求标识。初版观察器把终态的 `message_action_regenerate` 误匹配为 generating，导致等待 90 秒后错误报告 unknown；修正为排除 regenerate 后，同一真实会话连续三次稳定观察通过。没有重发模型请求。

正式生产控制核心随后以新请求 `a154aba4-d808-4152-b7c2-cd2b8f88cf06` 验证。它先使用 `Page.navigate` 返回空白任务路由，确认消息数 0、输入框唯一和 guidance 页面，再登记可能已发送状态、发送任务并回收原生会话 `38439708278565890`。最终回复精确为 `UAGENTS-DOUBAO-PRODUCTION-a154aba4-d808-4152-b7c2-cd2b8f88cf06`；消息总数 2、新回复 1、完成控件存在、300 ms 二次采样稳定。完整请求、状态和结果保存在 Git 忽略的 `.local/verification/`，不是插件发行内容。

这两次真实调用没有使用工具或访问文件，但会使用豆包工作的既有账户服务。未验证每日积分、余额或底层模型，不宣称免费。没有自动切换路线。

## 实现边界

MCP 使用官方 `@modelcontextprotocol/server` 2.0.0 与 zod 4.5.4，构建为压缩空白的单文件 ESM；安装时不需要 npm 下载。esbuild 0.28.2 仅用于构建。确切解析版本和 integrity 记录在子目录 `package-lock.json`，随包保留许可证。

公开工具只有：

- `doubao_probe`：连接与目标检查，不启动应用、不发送任务。
- `doubao_submit`：UUID 去重、跨进程窗口锁、空白会话、发送意图落盘和原生会话确认。
- `doubao_status`：只检查持有的 target/conversation 和用户边界后的回复；审批返回 needs_user。
- `doubao_result`：成功后返回回复与完成证据。

未公开 `cancel`。本轮没有在真实生成期间验证停止控件和远端确认，因此关闭进程、导航离开或断开 CDP 都不能冒充已取消。未知/超时会保留窗口锁并禁止下一任务覆盖，当前 alpha 没有自动强制解锁或数据清理。

插件不启动或结束豆包进程。CDP 只绑定回环，但同机其他进程仍可控制登录窗口；这是安装和使用说明中的显式准备条件。

## 自动验证与分发

豆包子包 8 项测试通过：MCP stdio 初始化和工具列表、纯 probe、去重与摘要冲突、窗口锁、running→succeeded、审批恢复检查、断线 unknown 且不重放。根测试同时检查 Agent Plugins v1 `.mcp.json` 使用 `node`、插件相对 cwd 和发行 bundle。最终预构建 bundle 还通过 stdio `tools/call` 执行了一次连接型 `doubao_probe`，识别到同一 Chrome 147 / CDP 1.3 页面且明确返回 `submission: not_sent`。

当前 OpenAI Codex 源码的 Agent Plugins 解析器会把 `cwd: "./"` 解析到插件根，并注入 `PLUGIN_ROOT` / `PLUGIN_DATA`；服务将任务数据放到后者。`.mcp.json` 使用发布的 Agent Plugins v1 `$schema`。本机 plugin-creator 校验器仍只允许旧 companion 顶层字段，可能对标准 `$schema` 报过时错误；运行时协议与打包结构分别验证，不删除标准 schema 来迁就旧校验器。

本轮没有注册 marketplace、安装插件、修改全局 Codex 配置或全局 `AGENTS.md`。TRAE 的本地调研已证明独立 CLI 不适用于复用 TRAE CN Solo 免费账号积分；后续接入应整理已端到端跑通的 TRAECNclaw CDP/MCP 路线。

来源：[OpenAI Agent Plugins MCP 解析器](https://github.com/openai/codex/blob/main/codex-rs/codex-mcp/src/agent_plugin_config.rs)、[MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk)、[TRAE CLI 参数](https://docs.trae.cn/cli_command-line-parameters)。
