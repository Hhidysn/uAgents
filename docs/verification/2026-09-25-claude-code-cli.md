# Claude Code CLI 接入验证（2026-09-25）

## 接口依据

- 本机 Windows CLI：`claude --version` 返回 `2.1.251 (Claude Code)`；`claude --help` 提供 `--print`、`--output-format stream-json`、`--model`、`--resume`、`--fork-session` 等参数。
- [官方 CLI reference](https://code.claude.com/docs/en/cli-reference)：非交互 `-p`、输出格式、完整模型名、原生权限选项和会话参数。
- [官方 headless 指南](https://code.claude.com/docs/en/headless)：stream JSON 的 session ID、JSON 结果与按 ID 续接。
- [官方模型配置](https://code.claude.com/docs/en/model-config)：alias 可由用户设置映射到其他 Provider 的模型 ID。最初本机实测 `--model sonnet` 自报 `deepseek-v4-pro[1M]`，而 `--model claude-sonnet-4-6` 自报同名模型；后续检查确认本机 Claude Code 用户设置的网关主机为 `api.deepseek.com`，Sonnet/Opus 映射到 DeepSeek。CLI 自报同名模型不构成上游 Provider 身份证明。

## Provider-free 检查

执行：

```text
node --test tests/claude-code.test.mjs
node --test tests/registry-policy.test.mjs tests/cli-transports.test.mjs tests/agent-locator.test.mjs tests/unified-cli-adapters.test.mjs
node --test tests/adapter-contract.test.mjs tests/unified-cli.test.mjs tests/plugin-package.test.mjs
node --test tests/model-discovery.test.mjs
```

DeepSeek 路由修正后将上述测试合并执行，114/114 通过（Claude Code 专项 6 项）。覆盖显式 route、附件和会话拒绝、原生参数/权限继承、session/cwd/model/result 解析、Task 幂等与持久化、已发送超时和取消保持不确定。安装发现还经过 `ensure claudeCode` 的真实本机验证。

## 真实 CLI 与 Task

在 `.local/claude-code-live-2026-09-25` 隔离工作区及状态目录执行，使用仓库 `plugins/uagents/bin/uagents.mjs`：

- `probe claudeCode --model claude-sonnet-4-6`：`succeeded`、`version_only`、版本 `2.1.251`。这不证明 Provider 可用。
- `ensure claudeCode`：发现受信任的 npm 安装 `claude.exe`，版本 `2.1.251.0`，产品 `Claude Code`、发布者 `Anthropic PBC`。
- `models claudeCode`：返回四条 configured-only route，包括三条 DeepSeek 路线和 `claude-sonnet-4-6`；无 native catalog 断言。
- 直接原生 CLI `--print --output-format stream-json --verbose --model claude-sonnet-4-6`：stdin Prompt 得到 `init.model=claude-sonnet-4-6`、最终 `result` 和 session ID。
- analysis Task `39b4292c-072b-4e3d-90d1-376097fc421f`：`submit → status → result` 为 `succeeded`，响应 `UAGENTS_CLAUDE_TASK_OK`；`model_reported=claude-sonnet-4-6`、`model_verified=true`、usage 与 native session ID 已记录。同一请求再次 `submit` 返回同一 Task 且 `duplicate=true`，未创建新 Attempt。
- implementation 纯文本 Task `7b752ccb-9f30-4ab3-bbf0-d4c061ee2280`：`succeeded`，响应 `UAGENTS_CLAUDE_IMPL_TEXT_OK`，模型自报匹配。
- implementation 文件任务 `5e8439e8-b902-4306-9a3d-29b2efabef24`：Claude Code 原生权限拒绝 `marker.txt` 写入；uAgents 记录 `waiting_user`、`native_approval_required`、`submission=sent`，未产出文件或宣称成功。未改变 Claude Code 权限设置，也未代答审批。

## DeepSeek 路由修正

用户指出本机 Claude Code 实际使用 DeepSeek 后，检查了设置中的模型字段与网关主机（未读取或记录密钥），并核对 `claude plugin list`。设置将默认模型指向 `deepseek-v4-pro`，将 Sonnet/Opus 指向 `deepseek-v4-pro[1M]`，Haiku 指向 `deepseek-v4-flash`；CLI 插件列表未显示独立 DeepSeek 插件。这里的可确认接入方式是 Claude Code 用户设置中的 DeepSeek 网关与模型映射。

直接 CLI 无工具文本调用分别以 `--model deepseek-v4-pro[1M]`、`deepseek-v4-pro`、`deepseek-v4-flash` 成功返回。CLI 将 `[1M]` 规范化为 `[1m]`，再次用规范化 ID `deepseek-v4-pro[1m]` 调用也成功。uAgents 因而批准 `claudeCode/deepseek-v4-pro[1m]`、`claudeCode/deepseek-v4-pro`、`claudeCode/deepseek-v4-flash`，并移除 driver 对 `claude-` 前缀的错误限制。

真实 uAgents Task `b4fdd316-deb2-420d-9872-3d994d6dc13b` 使用 `claudeCode/deepseek-v4-pro[1m]`：`submit → status → result` 为 `succeeded`，响应 `UAGENTS_DEEPSEEK_TASK_OK`，`model_resolved=model_reported=deepseek-v4-pro[1m]`，`model_verified=true`。其余两条 DeepSeek 路线已通过直接 CLI 调用与路由测试，但未各自执行完整 uAgents Task。

## 尚未验证或开放

- 当前本机权限下的 implementation 文件写入未成功；实现模式的编辑能力取决于 Claude Code 原生配置。
- 跨 Task continuation/fork 未开放。虽然 CLI 公开 `--resume`、`--fork-session`，接入尚未验证来源 Task、workspace、安装身份和原生会话边界。native session ID 只作当前 Task 证据。
- 真实取消、进程崩溃、网络中断后的远端终态不可从本轮实测得知；代码沿用通用 Task 的不确定状态和不自动重发规则。Provider-free 测试覆盖已发送超时与取消。
- `model_verified=true` 表示 CLI `init.model` 与请求完整 ID 相符，不是 Provider 侧独立证明。
- Claude Code 没有在当前接入中提供可用的无 Prompt 原生模型目录；`models claudeCode` 只表示 uAgents 的批准路线。DeepSeek 网关未来新增模型不会自动进入 uAgents allowlist。
