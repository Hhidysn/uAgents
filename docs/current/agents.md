# 当前 Agent 与能力

uAgents 当前提供 7 个 target。表格表示 uAgents 已经开放的能力，不等于目标产品理论上可能支持的全部功能。

| Target | Modes | File input | Image input | Continue | Fork | Transport |
| --- | --- | ---: | ---: | ---: | ---: | --- |
| `agy` | analysis / implementation | false | false | false | false | CLI |
| `codex` | analysis / implementation | false | false | false | false | CLI JSONL；Windows/Astra 显式 app-server 预览支持 continue/fork |
| `workbuddy` | analysis / implementation | false | model-specific | true | true | CLI |
| `dsh` | analysis / implementation | false | false | false | false | SDK JSON-RPC stdio |
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
- `uagents models agy` 通过 native `agy models` 自动发现本机 catalog；其它 `gemini-*`
  可按现有 pattern admission 使用，但发现到的 Claude/GPT 等模型不会自动放行。

## Codex CLI (`codex`)

- 当前批准 route：`gpt-6-astra` 和 `gpt-5.6-luna`，必须显式选择，没有 default。Luna 已通过本机原生调用和 uAgents 安装版真实任务验收，见 [验证记录](../verification/2026-09-20-codex-luna-installed-e2e.md)。
- 使用本机 Codex npm 安装版 `exec --json`，任务正文走 stdin，返回 native thread ID、最终 assistant 文本和 usage。
- text + workspace、analysis / implementation；原生 file/image input 暂不开放。Windows 上的 `gpt-6-astra` 可在每条 Task 显式设置 `execution.codex_transport="app-server"`，获得跨 Task continuation/fork；默认 exec 路线和 Luna 仍不开放。见 [会话规则](sessions.md)。
- 不覆盖用户 Codex 原生权限设置，不添加默认沙箱或自动授权参数。
- `probe` 只验证 CLI 版本；当前没有 Codex 模型自报证据，所以真实任务成功后 `model_reported=null`、`model_verified=false` 仍属预期，不等于任务失败或模型路线未经真实调用。
- CLI 启动器的 `close` 不证明全部原生子进程或 Provider turn 已终止；取消、超时或传输异常后的不确定状态不可自动重发。

## WorkBuddy

- `model=default` 保留 backend-auto 文本路线。
- 显式 `model=deepseek-v4.1-flash` 是批准的 concrete route，并通过真实图片 E2E。
- generic file attachment 当前关闭。
- 图片只允许在批准的 `deepseek-v4.1-flash` route 上使用；default/auto 不开放图片。
- 支持 `continue_from_task_id` 和 `fork_from_task_id`。

## DeepSeek Harness (`dsh`)

- 使用官方 `dsh --profile sdk` JSON-RPC stdio 接入。
- 当前批准 route：`deepseek-official/deepseek-flash`。
- 支持 text + workspace、analysis、implementation。
- 当前不开放 native file/image attachment。
- 当前不开放 continuation/fork。
- 一次 uAgents Task 使用一个独立 SDK process/root session。

## OpenCode

- 支持 text、file、image。
- file/image 复用 native `--file` mapping。
- 支持 continuation 和 fork。
- 当前只允许静态批准的 provider/model route；本机发现到其它模型不会自动放行。
- Windows 路线支持 durable native process observation 和 verified execution timeout。

## 豆包工作

- 当前只开放 analysis text task。
- 由 uAgents 使用专用 managed desktop profile 启动或复用。
- 当前没有 file/image、continuation/fork 或可靠 model report mapping。

## TRAE CN

- 支持 analysis / implementation text task。
- 使用受管桌面实例与 gateway。
- 当前没有 native file/image attachment 或 continuation/fork mapping。

## 权限边界

uAgents 是调度层，不提供执行沙箱或 Codex 审批代理。`analysis` 也不代表底层 Agent 被硬性限制为只读。命令、文件与网络访问权限由目标 Agent 的原生配置和运行环境控制。
