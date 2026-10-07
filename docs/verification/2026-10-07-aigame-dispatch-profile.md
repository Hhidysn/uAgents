# 2026-10-07 aiGame 调用配置统一

来源核对：旧任务的 3/5/10 分钟期限来自调用方写入的 request.execution，覆盖 uAgents 的二十分钟默认；native 外部目录 ask 与非交互自动拒绝来自 OpenCode 默认权限。原先 aiGame 仅对一个研究目录 allow/read、deny/edit，隔离 cwd 也不自动继承根配置。`permission="full-access"` 是协议标签，不负责原生权限配置。

用户要求项目扩大预算、完全执行参数，本次落地为：

- aiGame `.uagents/dispatch-profile.json`：60 分钟观察、默认无硬执行期限、full-access 标签。
- OpenCode `opencode.jsonc`：项目和 uagents-executor Agent 全 allow；新请求固定 `--auto --agent uagents-executor`。
- agy：native_args 为空、High effort；既有 driver 使用 `--dangerously-skip-permissions`。
- 主代理 `tools/uagents_dispatch.py prepare`：原 JSON 保留，生成新 prepared JSON 和哈希元数据，把受管原生配置准备到实际 workspace/.opencode/opencode.jsonc。新文件按排他创建，不覆盖其它配置。
- runner 只执行 submit：核验源请求、prepared 请求、配置和 state-dir，一律拒绝已有 UUID；不改旧任务、自动重试或重放。原生 session/server 参数不能夹带，延续只通过结构化 selector。
- AGENTS、Luna XHigh runner、pi 外部 CLI 指引、开发指南、旧 PowerShell 入口同步；旧入口已转为协议 prepare/submit，移除旧版 --attach/--variant 调用方式。

实际 native V2 的 OPENCODE_CONFIG 环境覆盖未加载，故不依赖它。无模型调用验证发现新 Location 的 agents 可能先读缓存；准备和提交都先执行 debug config 再 debug agents，确认配置/Agent 及 external_directory、read、edit、shell、glob、grep、webfetch、websearch 规则为 allow。该检查有 30 秒界限，本地 CLI 检查为 60 秒；submit 返回超时必须按原 UUID 查状态，不能当作未发送。

当前本机插件另有 browser deny，仍由原生端执行；网页读取和搜索使用 webfetch/websearch。本次没有删改全局插件、账号配置、凭据或模型默认。全执行参数不扩大任务写入范围：分析 prompt 仍禁止改文件，实施按分配路径执行。

## uAgents alpha.4

本地部署 `uagents@0.2.0-alpha.4`，普通默认保持20分钟，观察上限提高到60分钟，aiGame显式使用60。`status/result.native_execution` 增加持久进程状态、guard状态、退出码、观察/退出时间，不自动刷新或释放guard。

OpenCode result 对同一已接受 session 的 stdout 做至多1MiB诊断读取，补充超时前的工具失败/provider错误及读取覆盖范围。外层/part session不匹配或身份未知时不归因；错误脱敏，不复制参数/body，不更改回复、model_verified或生命周期，不调用provider。

只读查询旧 contract-oracle 任务，现可看到 process_state=exited、workspace_guard_state=released，以及 provider.internal 的 Streaming response failed/server_error。原 Task 仍 indeterminate，没有改成成功。其它旧 UUID 未重放。

## 验证

- Python项目入口10项测试通过：旧预算规范化、原请求不变、已有UUID/未知状态拒绝、单次提交、防配置/请求漂移、未覆盖其它配置、非法native参数、agy参数、检查超时。
- Node协议/CLI/诊断/OpenCode完成验证43项通过；native process/workspace guard/history另24项通过。
- unified MCP28项通过；bundle重新构建；npm pack162个文件/23个必需路径通过。
- 真实prepare/dry-run：UUID `25919e5c-1702-4707-9d54-0e30321d0949`，原3/5分钟输入生成60分钟/无硬期限/full-access请求；隔离cwd已加载Agent和八项allow，未注册该模型Task。兼容PowerShell入口DryRun也显示相同参数。
- 真实旧UUID入口检查拒绝提交，原 request.json 字节不变。项目配置/TOML/Python语法及git whitespace核验。

本地证据：`.local/verification/project-profile-20261007/`。未额外发送provider测试，不声称配置能消除provider流式故障。未提交推送；aiGame同期worldgen生产改动不属于本次调用配置修改。
