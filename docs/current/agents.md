# 当前 Agent 与能力

uAgents 提供 9 个 target。以下是 uAgents 开放的映射与模式；具体平台、模型和原生版本限制以 `uagents capabilities <target>` 及对应规则为准。

| Target | Modes | File input | Image input | Continue | Fork | Transport |
| --- | --- | ---: | ---: | ---: | ---: | --- |
| `agy` | analysis / implementation | false | false | false | false | CLI |
| `codex` | analysis / implementation | false | true | false | false | CLI JSONL；Windows/Astra 显式 app-server 预览支持 continue/fork |
| `claudeCode` | analysis / implementation | PDF / UTF-8 text | true | false | false | CLI stream JSON |
| `workbuddy` | analysis / implementation | false | model-specific | true | true | CLI |
| `dsh` | analysis / implementation | false | true（端到端成功未确认） | false | false | SDK JSON-RPC stdio |
| `opencode` | analysis / implementation | true | true | true | true | CLI |
| `pi` | analysis / implementation | true | true | true | true | CLI JSONL |
| `doubao` | analysis | false | false | false | false | managed desktop/CDP |
| `trae` | analysis / implementation | false | false | false | false | managed desktop/gateway |

能力映射不保证任意 Provider/model 都接受输入或已通过真实验收。附件细节见 [附件](attachments.md)，模型来源与默认值见 [模型与路由](models.md)。

## agy

- 支持 text、analysis、implementation，Agent 可读取初始化 workspace。
- 无 native file/image 或 continuation/fork mapping。
- 内置 `gemini-3.8-flash-medium` 路线，无内置默认模型；`models agy` 使用原生 catalog，其它原生模型 ID 也可显式提交。
- analysis / implementation 均传入 `--dangerously-skip-permissions`，由原生 CLI 自动批准工具；不注入 `--sandbox`。原生配置仍可启用 sandbox；只读审查依赖任务提示与原生约束。

## Codex CLI (`codex`)

- 内置 `gpt-6-astra` 和 `gpt-5.6-luna`，无内置默认模型。
- 默认使用 `exec --json`，Prompt 走 stdin，记录 native thread ID、最终文本与 usage；支持 text + workspace、analysis / implementation 和原生图片，generic file 关闭。
- Windows / `gpt-6-astra` 可在每条 Task 显式设置 `execution.codex_transport="app-server"`，获得预览版 continuation/fork；默认 exec 和 Luna 不开放会话续接。见 [会话](sessions.md)。
- 沿用 Codex 原生权限；`probe` 仅验证 CLI 版本。没有可信模型自报时记录 `model_reported=null`、`model_verified=false`。
- CLI 关闭不证明全部原生子进程或 Provider turn 已终止，取消或超时后的不确定状态不能自动重发。

## Claude Code CLI (`claudeCode`)

- 内置 DeepSeek 和 Sonnet 路线见 [模型与路由](models.md#目标模型来源)，无内置默认模型。其它显式 ID 可传给 `--model`，以原生 `init.model` 核对；模型不一致会使 Task 失败。
- 使用 `--print --output-format stream-json --verbose`，Prompt 走 stdin，workspace 为进程 cwd；记录最终文本、usage 和 session ID。
- 支持 text、analysis / implementation、图片、PDF 与 UTF-8 文本；其它二进制文件在发送前拒绝。
- 沿用原生权限配置，权限拒绝记录为需要用户处理。跨 Task continuation/fork 关闭，session ID 只作为执行证据；`resume` 仍按通用生命周期规则恢复同一 Task。
- `probe` 只验证版本，`models` 只列配置路线，不枚举网关或账号的完整模型目录。

## WorkBuddy

- 自动发现已安装的 `cli/bin/codebuddy`，兼容旧 `cli/dist/codebuddy.js`，无需把 GUI exe 加入 PATH 或另行下载。2.156.0 的独立 CLI 未恢复桌面加密凭据时仍可能认证失败；安装发现不代表登录可用。
- backend-default 为文本路线；`deepseek-v4.1-flash` 是开放图片输入的显式路线。
- `models workbuddy` 解析 CLI help 的 supported labels，其它模型可显式提交文本 Task。
- generic file 关闭；default/auto 与其它模型不自动获得图片能力。
- 支持 continuation/fork，见 [会话](sessions.md)。

## DeepSeek Harness (`dsh`)

- 使用 `dsh --profile sdk` JSON-RPC stdio，每个 Task 使用独立 SDK process/root session。
- 内置 `deepseek-official/deepseek-flash`，支持 text + workspace 和 analysis / implementation。
- SDK 已映射内联图片，端到端成功尚未确认；证据不足时 Task 保持 `indeterminate`。普通文件所需的 DSH 持久化附件引用未接入。
- continuation/fork 关闭。

## OpenCode

- 原生 `--file` 映射文件和图片；支持 continuation/fork，Windows 上支持 durable process observation 与 verified execution timeout。
- 自动核对原生版本：V1 使用 `run --dir <workspace>`，V2 使用进程 cwd。模型目录按版本获取；显式 `provider/model` 最终由原生 CLI 判定。
- `execution.native_args` 保持顺序透传非冲突参数；V2 的 variant 使用 `provider/model#variant`，不接受已移除的 `--pure` / `--variant`。
- 完成状态需要原生终态证据。V2 缺少 `step_finish` 时，只读导出同一 session，核对 workspace、最终 message ID、完成及 idle 时刻、provider/model 和与 stdout 一致的答案；核查失败保持 `indeterminate / native_completion_unconfirmed` 并保留部分文本。核对成功时记录原生模型自报。V2 文本与同 Attempt 恢复已实测，续接/fork 和附件仍需各自真实 E2E，见 [V2 回执修复](../verification/2026-10-04-opencode-v2-completion.md)。
- V2 设置 `execution_timeout_ms` 时自动使用 `--standalone` 私有服务，拒绝同时指定 `--server`，使时限覆盖拥有的执行进程树；本地停止仍不代表 Provider 已确认取消。
- V2 在中途 Provider 错误后可能自行恢复，并仍退出 1。若出现新的最终消息，uAgents 只读核对同 session 的成功终态及上述身份／正文证据后才确认恢复；无证明仍失败，不覆盖最终错误或审批等待。见 [L1 分发调查](../verification/2026-10-04-l1-dispatch-errors.md)。旧任务的 terminal 状态不自动改写。

## pi

- 每次执行显式加载会话守卫，保留用户扩展与权限配置；执行中通过扩展上下文新建、切换、分叉或改选会话树会被阻止并保持不确定。结束时再次核对 session/cwd，扩展重载后需重新确认守卫。它不隔离同进程的任意 JavaScript 扩展。
- 原生模型自报同时核对 provider 和 model；不匹配时失败，不标记 `model_verified=true`。
- 启动已安装的 `@earendil-works/pi-coding-agent` bundle（`dist/bundle/cli.js`，由当前 Node 运行），使用 `--mode json` JSONL 事件流；Prompt 走 stdin，workspace 为进程 cwd。
- 原生 `@path` 映射文件与图片；支持 analysis / implementation 和 continuation/fork（`--session` / `--fork`）。
- 模型使用原生 `provider/model` selector，随 Task 传 `--provider` / `--model`；`execution.effort` 映射为 `--thinking`。`models pi` 读取 `--list-models` 原生目录。
- 模型自报来自最终 assistant `message_end` 的 `model`。只在该消息 `stopReason` 为 `stop`/`length`、进程正常退出且收到 `agent_settled` 时才确认成功；仅存在最终文本但不 settle 时保持 `indeterminate / native_completion_unconfirmed`。
- 沿用 pi 原生权限与 project trust 默认；不注入工具白名单或 `--approve`。`native_args` 暂不开放。`execution_timeout_ms` 不支持（无持久进程观察）。
- 本机安装发现不读取登录或凭据；未登录或模型不可用由原生进程执行时确认。
- 文本、续接/分叉、文件与图片已按 [真实调用记录](../verification/2026-10-06-pi-cli.md) 验证；附件是否可用还取决于 provider（antigravity bridge 在附件上会崩溃）。

## 豆包工作

- 使用原生输入事件，并按编辑器逻辑段落核对完整提示后发送；可见模态弹窗先等待用户处理。
- 仅开放 analysis text task，使用专用受管桌面 profile。
- 无 file/image、continuation/fork 或可靠 model report mapping。

## TRAE CN

- 工作区打开绑定受管 profile；原生任务先持久化回执，再准备工作区。结果只采集匹配提示的当前轮最终摘要，非阻塞性能通知不会作为命令审批。
- 支持 analysis / implementation text task，使用受管桌面与 gateway。
- 网关读取当前模型选择器；显式模型随 Task 提交，由网关在发送前切换。backend-default 沿用界面当前模型。
- `models trae` 不启动窗口；没有身份可验证的受管实例时，只读个人配置缓存候选并标记执行可用性未确认。
- 默认使用隔离配置。关闭原有 TRAE 窗口后，可显式使用 `ensure trae --profile personal`；实例与网关回收规则见 [Runtime](runtime.md#desktop-target)。
- 网关当前报告 `compatibility=degraded`；逐 Task 模型自报尚不可核对，记录 `model_verified=false`。原生取消及其它模型接受度未逐项验证，无 native file/image 或 continuation/fork mapping。

## 权限边界

uAgents 管理调度和记录；命令、文件及网络访问权限由目标原生配置、启动策略和运行环境控制。`analysis` 和 `advisory-read-only` 不提供强制只读沙箱。agy 的原生工具自动批准策略只适用于 agy；原生审批、取消和发送后的不确定状态按各目标 Task 规则处理。

各目标的实机结果与未验证行为见 [验证证据](../verification/README.md)。
