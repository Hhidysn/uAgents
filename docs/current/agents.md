# 当前 Agent 与能力

uAgents 当前提供 6 个 target。表格表示 uAgents 已经开放的能力，不等于目标产品理论上可能支持的全部功能。

| Target | Modes | File input | Image input | Continue | Fork | Transport |
| --- | --- | ---: | ---: | ---: | ---: | --- |
| `agy` | analysis / implementation | false | false | false | false | CLI |
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
- 模型必须使用静态批准路线显式选择。

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

uAgents 是 orchestration 层，不提供执行沙箱。`analysis` 也不代表底层 Agent 被硬性限制为只读。目标自身的原生参数和审批行为应通过对应 native contract 控制。
