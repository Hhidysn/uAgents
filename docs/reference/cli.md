# CLI Reference

插件根目录中的统一入口：

```text
uagents <command>
```

从开发仓库直接运行同一入口：

```text
node plugins/uagents/bin/uagents.mjs <command>
```

## 公共配置

- `--config <绝对文件路径>` / `UAGENTS_CONFIG`：用户模型路线与默认值。
- `--state-dir <绝对目录路径>` / `UAGENTS_STATE_DIR`：Task 状态根目录；Windows 默认 `%LOCALAPPDATA%\uAgents\v1`。
- `config validate --config <绝对文件路径>`：校验配置路线与默认值。

安装与提交示例见 [快速开始](../current/quick-start.md)，独立服务及桥接命令见 [Local Service](service.md)。

## Discovery

```text
targets
capabilities <target>
models <target> [--refresh]
describe
describe <command>
schema request
schema council
schema council-validation
schema council-validation-profiles
```

这些命令不创建 Provider task。

`models --refresh` 仅绕过 uAgents 的 model discovery cache；它不会提交 Prompt，也不会改变静态/pattern admission policy。

## Task

```text
submit (--request <file> | --request-stdin)
run <target> [--model <model>] [--mode <mode>] [--workspace <dir>] (-p <prompt> | --prompt-file <file> | --prompt-stdin) [--no-wait] [--timeout-ms <ms>]
status <task-id>
result <task-id>
cancel <task-id>
list [--target <target> ...] [--has-response] [--cursor <cursor>] [--limit <n>]
sessions [--target <target> ...] [--cursor <cursor>] [--limit <n>]
reconcile <task-id>
resume <task-id>
```

`submit` 的 `--request` 和 `--request-stdin` 严格二选一。

`run` 是 `submit` + 等待 + `result` 的便捷入口：用新 UUID 登记一个任务，等待终态后返回与 `result` 相同的载荷。`--mode` 默认 `analysis`，`--workspace` 默认当前目录，`--model` 省略时使用该目标的默认路线。等待超时或停在 `waiting_user` 时返回最后一次持久化状态并追加 warning `run_wait_timeout` / `run_waiting_user`，不猜测结果、不自动重发。本地 Worker 无法启动目标（例如缺少桌面组件）时，任务会被记为可恢复的 `queued` + `submission: not_sent`，`error.code = worker_start_failed`，并立即返回 warning `run_not_started` 而不再空等（修好本地安装后用 `resume` 重试同一任务）。退出码 0 仅表示最后状态为 `succeeded`（`--no-wait` 时为已登记）。`-p/--prompt` 会把 Prompt 放进进程参数，长内容或敏感内容请用 `--prompt-file` / `--prompt-stdin`。

`--timeout-ms` 只约束**本地等待**，它不控制 native 进程。真正影响 native 的是请求里的两个期限，含义不同：

- `--observation-timeout-ms <ms>`（1000–1200000，默认 600000，即 10 分钟）转发 `observation_timeout_ms`：**观察期限**，超过就不再继续观察，任务以 `indeterminate` 结束且可能没有回复文本。对**每任务一个进程**的目标（agy 等）到点会停掉该进程；对**持久 native 进程**的目标（OpenCode V2）**不会**停止原生进程，它可能继续运行并继续改文件，只是结果不再被观测到。默认 10 分钟适用于常规任务；长任务可显式设为 1200000（20 分钟）。未显式给 `--timeout-ms` 时本地等待自动跟随（取 `max(900000, observation + 60000)`）。
- `--execution-timeout-ms <ms>`（1000–86400000）转发 `execution_timeout_ms`：**执行期限**，到点由 guardian 终止本次执行所拥有的进程树（证据不足时记为 `execution_timeout_termination_unconfirmed`）。仅对能强制该预算的目标有效，其余目标直接 `unsupported_capability` 拒绝而不是静默忽略。

两者可以同时给：观察期限决定你等多久，执行期限决定进程活多久。

`list` 与 `sessions` 是只读的本地历史查询，都不联系 Provider、不重发 Prompt：

- `list` 的行就是 `status` 载荷（不含正文），可用 `--target` 过滤目标（可重复）、`--has-response` 只看已持久化非空 response 的任务。由于 response 存在任务目录而不是数据库里，过滤后一页可能少于 `--limit`；此时 `next_cursor` 仍指向最后一个被扫描到的行，继续翻页不会漏项。
- `sessions` 按原生会话聚合已登记任务，每行给出 `target`、`native_session_id`、`task_count`、`first_task_id`/`latest_task_id`、`latest_status`、`started_at_ms`/`updated_at_ms`、`lineage`（该会话首条任务是 `continue` 还是 `fork`、来源 task）与按时间正序的 `tasks` 窗口（默认最多 20 条，超出时 `tasks_truncated=true`）。没有原生会话身份的未派发任务不属于任何会话，不出现在结果里。

两者都**看不到原生 CLI 自己的历史**：uAgents 只能列出自己登记过的任务，而且只有共用同一状态目录（`--state-dir`）的入口互相可见。续接旧会话不是查询动作，需要新 UUID 并在请求里给出 `session.continue_from_task_id` 或 `session.fork_from_task_id`（仅注册表声明 `resume`/`fork` 的目标支持）。

## Host lifecycle

```text
ensure <target> [--refresh]
probe <target>
stop <target>
```

## Check-in

```text
init
checkin [run] [--target trae|workbuddy ...] [--check-only]
checkin status
checkin enable [--target trae|workbuddy ...] [--time HH:mm]
checkin disable
```

`init` 按登录态注册 Windows 每日任务，尊重停用偏好；`enable` 显式重新启用，默认时间 `00:30`。`status` 只读本机任务及报告；`run` 的 `--check-only` 只查询 Provider 状态。`--time` 只适用于 enable，target 必须为 registry 启用的 TRAE 或 WorkBuddy。

返回单独的 check-in report，不创建 Task / Attempt。单目标状态见 [自动签到](../current/checkin.md)。手动执行出现 `failed` 或 `unconfirmed` 时 CLI 退出码为 1。

## Council

```text
council-submit (--request <file> | --request-stdin)
council-status <council-id>
council-result <council-id>
council-diff <council-id>
council-validate <council-id> (--member <member-id> | --all) (--validation <file> | --profile <name>)
council-adopt <council-id> --member <member-id> --workspace <absolute-dir>
council-cleanup <council-id> (--member <member-id> | --all) [--force]
```

精确参数、exclusive groups 和 machine-readable description 始终以 `describe <command>` 为准。

## Skills

```text
skills path
skills install --dir <absolute-dir> [--force] [--dry-run]
```

`skills install` 把包内 `skills/agent-dispatch` 复制到 `<dir>/agent-dispatch`，让宿主 Agent 读到与包一致的操作说明；`--dry-run` 只列出将写入的文件，目标已存在时必须显式 `--force`。该命令不修改宿主配置，也不写 Task 状态；具体宿主的技能目录由调用方决定，常见位置见包内 [AGENTS.md](../../plugins/uagents/AGENTS.md)。
