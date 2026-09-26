# 当前 Agent 与能力

uAgents 当前提供 8 个 target。表格表示 uAgents 已经开放的能力，不等于目标产品理论上可能支持的全部功能。

| Target | Modes | File input | Image input | Continue | Fork | Transport |
| --- | --- | ---: | ---: | ---: | ---: | --- |
| `agy` | analysis / implementation | false | false | false | false | CLI |
| `codex` | analysis / implementation | false | true | false | false | CLI JSONL；Windows/Astra 显式 app-server 预览支持 continue/fork |
| `claudeCode` | analysis / implementation | PDF / UTF-8 text | true | false | false | Claude Code CLI stream JSON |
| `workbuddy` | analysis / implementation | false | model-specific | true | true | CLI |
| `dsh` | analysis / implementation | false | true（真实 Task 未确认） | false | false | SDK JSON-RPC stdio |
| `opencode` | analysis / implementation | true | true | true | true | CLI |
| `doubao` | analysis | false | false | false | false | managed desktop/CDP |
| `trae` | analysis / implementation | false | false | false | false | managed desktop/gateway |

所有 target 的真实机器可读能力以：

```text
uagents capabilities <target>
```

为准。

## agy

- 支持 text、analysis、implementation。
- Agent 可以读取初始化 workspace。
- 当前没有经过 uAgents 验证的 native file/image attachment mapping。
- 当前没有 continuation/fork mapping。
- 模型必须显式选择；没有 default model。
- `gemini-3.8-flash-medium` 是已真实验证的 configured route。
- `uagents models agy` 通过 native `agy models` 发现本机 catalog；发现到的其它模型可直接用原生 ID 提交。

## Codex CLI (`codex`)

- 当前内置 route：`gpt-6-astra` 和 `gpt-5.6-luna`；没有内置 default，用户可配置 target 默认值。Luna 已通过本机原生调用和 uAgents 安装版真实任务验收，见 [验证记录](../verification/2026-09-20-codex-luna-installed-e2e.md)。
- 使用本机 Codex npm 安装版 `exec --json`，任务正文走 stdin，返回 native thread ID、最终 assistant 文本和 usage。
- text + workspace、analysis / implementation；图片经 `--image` 原生传入，generic file input 暂不开放。Windows 上的 `gpt-6-astra` 可在每条 Task 显式设置 `execution.codex_transport="app-server"`，其图片使用 `localImage`，并获得跨 Task continuation/fork；默认 exec 路线和 Luna 仍不开放会话续接。见 [附件规则](attachments.md)和[会话规则](sessions.md)。
- 不覆盖用户 Codex 原生权限设置，不添加默认沙箱或自动授权参数。
- `probe` 只验证 CLI 版本；当前没有 Codex 模型自报证据，所以真实任务成功后 `model_reported=null`、`model_verified=false` 仍属预期，不等于任务失败或模型路线未经真实调用。
- CLI 启动器的 `close` 不证明全部原生子进程或 Provider turn 已终止；取消、超时或传输异常后的不确定状态不可自动重发。

## Claude Code CLI (`claudeCode`)

- 内置路线包括 `claudeCode/deepseek-v4-pro[1m]`、`claudeCode/deepseek-v4-pro`、`claudeCode/deepseek-v4-flash` 和 `claude-sonnet-4-6`。没有内置 `default` 或 `sonnet` alias。其它显式模型 ID 也可交给 Claude Code `--model`，并以原生 `init.model` 核对。模型不一致会使 Task 失败。
- 本机 Claude Code 用户设置将请求指向 DeepSeek 网关并配置这些 DeepSeek 模型；`claude plugin list` 未显示独立的 DeepSeek 插件。`models claudeCode` 只展示已配置路线，不枚举网关完整模型目录。
- `--print --output-format stream-json --verbose` 运行一轮；Prompt 走 stdin，`workspace` 固定为进程 cwd。原生 `result` 提供最终文本、usage 和 session ID；uAgents 将其记录到 Task 的状态与结果中。
- analysis / implementation 都沿用 Claude Code 原生权限配置。uAgents 不传入 `--permission-mode`、`--allowedTools` 或跳过权限的参数；analysis 不保证底层只读。原生权限拒绝会记录为需要用户处理，不由 uAgents 代答。
- native stream-json 接受图片、PDF 和 UTF-8 文本附件；不支持的二进制文件在发送前拒绝。原生权限仍由 Claude Code 处理。跨 Task continuation/fork 暂不开放。`uagents resume <task-id>` 仅按通用 Task 生命周期规则恢复或观察同一个 Attempt，不发送 follow-up Prompt。取消、超时及流证据不足时沿用不确定状态规则，不自动重发。
- `probe` 只检查本机 CLI 版本；`models claudeCode` 只展示 configured route，不声称有 native catalog 或 Provider 可用性。真实调用见 [验证记录](../verification/2026-09-25-claude-code-cli.md)。

## WorkBuddy

- `model=default` 保留 backend-auto 文本路线。
- 显式 `model=deepseek-v4.1-flash` 是批准的 concrete route，并通过真实图片 E2E。
- `models workbuddy` 解析本机 CLI 帮助中的其它 supported labels；这些名称可直接作为文本 Task 模型传入，原生 CLI 判定是否接受。
- generic file attachment 当前关闭。
- 图片只允许在批准的 `deepseek-v4.1-flash` route 上使用；default/auto 不开放图片。
- 支持 `continue_from_task_id` 和 `fork_from_task_id`。

## DeepSeek Harness (`dsh`)

- 使用官方 `dsh --profile sdk` JSON-RPC stdio 接入。
- 当前批准 route：`deepseek-official/deepseek-flash`。
- 支持 text + workspace、analysis、implementation。
- SDK `session/prompt` 映射内联图片；真实 CLI Task 首次发送后原生进程退出，状态为 `indeterminate`，因此尚未确认端到端成功。普通文件所需的 DSH 持久化附件引用未接入。
- 当前不开放 continuation/fork。
- 一次 uAgents Task 使用一个独立 SDK process/root session。

## OpenCode

- 支持 text、file、image。
- file/image 复用 native `--file` mapping。
- 支持 continuation 和 fork。
- `models opencode` 发现到的其它 provider/model route 可直接提交；没有在当前发现范围内的原生 ID 也可显式交给 OpenCode 判定。
- Windows 路线支持 durable native process observation 和 verified execution timeout。

## 豆包工作

- 当前只开放 analysis text task。
- 由 uAgents 使用专用 managed desktop profile 启动或复用。
- 当前没有 file/image、continuation/fork 或可靠 model report mapping。

## TRAE CN

- 支持 analysis / implementation text task。
- 使用受管桌面实例与 gateway。
- 网关 `/api/models` 读取当前模型选择器；显式 Task 模型会随 `/api/tasks/submit` 传入，由网关在任务发送前切换。默认路线仍沿用界面当前模型。
- `models trae` 不启动新桌面实例；无可用受管窗口时仅列出个人配置缓存中的候选模型，执行可用性未确认。默认 Task 使用独立受管配置。关闭原有 TRAE 窗口后，`ensure trae --profile personal` 可用原个人配置和 CDP 参数启动受管窗口；已验证登录状态、实时模型列表、`GLM-5.3` 界面切换、analysis 与 implementation 的真实 Task、必需文件捕获、同 ID 幂等，以及 backend default 的准确回复。当前网关对这版 TRAE 仍自报 `compatibility=degraded`，其它模型和原生取消尚未逐项验证。
- 如果受管桌面退出，下一次 `ensure` 会检查旧网关进程、监听端口、启动时间、能力 token、实例 nonce、原生队列和当前 Task 存储的未决状态。仅全部通过时回收旧网关；否则保留并在旧实例记录 `gateway_cleanup` 原因。旧网关可能仍运行时新实例启动会延后。`stop trae` 也只会终止身份已验证的伴随网关。
- 网关结果尚未提供可核对的逐 Task 模型自报，因此 `model_verified=false`；模型切换或额度失败按原生任务结果记录。
- 当前没有 native file/image attachment 或 continuation/fork mapping。

## 权限边界

uAgents 是调度层，不提供执行沙箱或 Codex 审批代理。`analysis` 也不代表底层 Agent 被硬性限制为只读。命令、文件与网络访问权限由目标 Agent 的原生配置和运行环境控制。
