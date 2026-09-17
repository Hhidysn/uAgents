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

## Result

Task result 包含终态、native outcome、model evidence、response、usage、artifacts 和结构化 error。精确字段以 Core schema/CLI 输出为准。

Agent/operator 需要的更细协议说明也随插件发布在 `plugins/uagents/skills/agent-dispatch/references/protocol.md`。
