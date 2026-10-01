# Request / Task Protocol

当前请求 schema version 为 `1.0`。完整 JSON Schema 通过：

```text
uagents schema request
```

获取。

最小结构：

```json
{
  "schema_version": "1.0",
  "request_id": "<uuid>",
  "target": "opencode",
  "model": "commandcode-goat/deepseek/deepseek-v4-flash",
  "mode": "analysis",
  "workspace": "F:\\project",
  "prompt": "Review this repository."
}
```

`model` 可省略；Core 将它按 `"default"` 解析到该 target 当前配置的路线。请求中的具体模型 `selector`
只覆盖本次 Task。若 target 没有默认路线，省略模型会在发送前返回 `model_unavailable`。

## Model identity

任务状态会区分：

```text
model_requested
model_resolved
model_reported
model_verified
provider
route_id
```

配置选择不会自动被当成运行期模型验证。

## Session selector

```json
"session": { "continue_from_task_id": "<task-uuid>" }
```

或：

```json
"session": { "fork_from_task_id": "<task-uuid>" }
```

两者严格二选一，并且只有 target capability 已开放时才允许。

## Inputs

File/image input 可以使用 workspace `path`、绝对 `source` 或 inline `blob`。精确规则见 [当前附件能力](../current/attachments.md)。

## Execution

`analysis` 与 `execution.permission="advisory-read-only"` 是任务意图和提示指导，不提供强制只读权限。原生配置及启动策略见 [当前权限边界](../current/agents.md#权限边界)。agy 使用原生工具自动批准；uAgents 不为其它 target 推断同样的授权。

`execution.native_args` 当前仅对 OpenCode 开放，并保持顺序透传非冲突选项。调用方不能覆盖 dispatcher 管理的模型、格式、workspace、title 或结构化 session 参数。原生选项是否存在由已安装 CLI 判定；V2 的 run 不添加 `--dir`，使用进程 cwd，并用 `provider/model#variant` 表示 variant。完整参数规则见随插件发布的协议参考。

## Result

Task result 包含终态、native outcome、model evidence、response、usage、artifacts 和结构化 error。精确字段以 Core schema/CLI 输出为准。

Agent/operator 需要的更细协议说明也随插件发布在 `plugins/uagents/skills/agent-dispatch/references/protocol.md`。
