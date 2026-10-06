# 目标修复与登录后实机核对

被测版本：`f254fb8` 后本修复提交的工作树；Windows，2026-10-06。CLI 使用仓库 `plugins/uagents/bin/uagents.mjs`，固定状态目录 `.local/verification/target-repair-20261006/state`，关闭本次进程自动签到。以下为真实原生调用，回归测试另列。

| Target | 原生证据与结果 |
| --- | --- |
| Claude Code | `12c53c5e-5314-4865-bb13-3e7cdd016963` 成功，正文 `CONNECT_OK_claudeCode`，原生自报并核对 `deepseek-v4-flash`。 |
| Codex | `5f0c889f-58e3-446b-836e-70252ebf06fa`：原生 HTTP 400，当前 ChatGPT 账号不支持请求的 `gpt-6.1-sol`；CLI 已登录。新增安全分类 `model_unavailable`，不输出原始错误中的敏感内容。目录候选不是账号可用性证明，未改模型重试。 |
| WorkBuddy | 新入口 `cli/bin/codebuddy` 已发现并运行，版本 2.156.0；`2e868cf4-9e8c-4fc5-9fb6-a3b2a483990f` 及诊断任务 `e93769a1-119b-4aae-981e-799092e0921a` 认证失败。桌面账户采用加密凭据，独立 CLI 未配置凭据解码启动过程；未实现私有凭据桥接，不能声称任务连通。没有下载另一份应用，也无需 GUI PATH 配置。 |
| 豆包 | 用户处理欢迎弹窗后，`fae67aed-a1b8-4cb3-b9c9-0409bd02badf` 已实际发送到原生会话 `38445694660929538`。语义段落序列化修复后，通过原实例/页面/完整提示/空编辑器/稳定回复证据恢复原回执，再正常对账成功，正文 `CONNECT_OK_doubao_ready`。未重发。 |
| TRAE | 用户登录并信任专用测试目录。恢复原 generation 9 登录重启后的进程身份；用户授权后只重启身份核验通过的网关，桌面 PID 33644、profile、nonce 与 capability 保留。最终任务 `db3b512c-f091-4255-8db3-cc1e012bcc3a`、原生 ID `task_1_muwmi64a_8pxnp3gi2w` 通过正常 `reconcile` 成功，正文严格为 `CONNECT_OK_trae_clean`。非阻塞性能通知误判已修复，未点击优化按钮、批准弹窗或重发提示。 |

TRAE 中间任务 `70eb02af-10f8-4db1-924e-df3515543837` 的发送结果不确定，保留记录及取消意图；工作区信任前任务失败，摘要采集修复前任务正文污染，均保留原结果。豆包此前提示插入/弹窗阶段的不确定任务也保留，未自动重试。

实现包含：WorkBuddy 新旧安装入口、Codex 账号模型限制分类、豆包原生输入及逻辑段落确认和弹窗等待、TRAE 严格进程身份恢复、受管 profile 工作区命令、先持久化再后台准备、当前轮摘要采集。旧审批自动恢复候选经审查发现会话索引不稳定而移除，保留保守等待边界。豆包和 TRAE 为 backend-default，`model_reported=null/model_verified=false`。

执行并通过：

- `node --test tests/cli-transports.test.mjs tests/codex-cli.test.mjs tests/queue-recovery.test.mjs tests/trae-launcher.test.mjs tests/target-supervisor.test.mjs tests/desktop-adapters.test.mjs tests/managed-reconcile.test.mjs tests/doubao-launcher.test.mjs`：128/128。
- `npm --prefix plugins/uagents/mcp/trae test`：重建 bundle，15/15。
- `npm --prefix plugins/uagents/mcp/doubao test`：重建 bundle，17/17。

最终正常新任务 `76c90f41-8636-481f-8c8b-aa2e20b21984` 成功，正文 `CONNECT_OK_trae_final`。原 `db3b512c` 的对账是在具备唯一测试提示、实际原轮及精确回复人工核验的中间构建完成；最终代码不泛化这条旧审批恢复路径。

`npm run test:pack` 检查通过（157 文件、20 必需入口），`git diff --check` 通过。既有全局 uagents 安装通过离线本地 tarball 更新，旧包保存在本机验证目录；未下载 WorkBuddy。一次误启动的全仓测试提前停止，不计入完成证据。

实机成功只证明上述任务和当前环境，不覆盖其它模型、原生取消或 WorkBuddy 凭据恢复。
