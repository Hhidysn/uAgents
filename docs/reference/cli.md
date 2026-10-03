# CLI Reference

插件根目录中的统一入口：

```text
node <plugin-root>/bin/uagents.mjs <command>
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
status <task-id>
result <task-id>
cancel <task-id>
list
reconcile <task-id>
resume <task-id>
```

`submit` 的 `--request` 和 `--request-stdin` 严格二选一。

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
