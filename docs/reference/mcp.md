# Unified MCP Reference

插件提供一个统一 stdio MCP Server：`uagents-unified`。它和 CLI 使用同一 Node.js Core。

当前工具包括：

```text
uagents_list_targets
uagents_get_capabilities
uagents_list_models
uagents_probe
uagents_submit
uagents_status
uagents_result
uagents_cancel
uagents_list_tasks
uagents_reconcile
uagents_ensure
uagents_resume
uagents_stop

uagents_council_submit
uagents_council_status
uagents_council_result
uagents_council_diff
uagents_council_validate
uagents_council_adopt
uagents_council_cleanup
```

具体 input schema 通过 MCP `tools/list` 提供。

`uagents_list_models` 接受：

```json
{ "target": "agy", "refresh": true }
```

`refresh=true` 与 CLI `models <target> --refresh` 语义相同：仅刷新本机 native model catalog cache，不创建 Provider task。
MCP Server 在启动时从绝对路径环境变量 `UAGENTS_CONFIG` 载入用户路线与默认值；Task 的 `model` 可省略以使用 target 默认值。

## Host attachments

`uagents_submit` / `uagents_council_submit` 可以使用 Core `inputs`，也可以使用 host-only：

```json
{
  "attachments": [
    { "type": "file", "local_path": "C:\\host-temp\\upload.tmp", "name": "brief.pdf" }
  ]
}
```

`inputs` 与 `attachments` 严格二选一。Host attachment 在进入 Core 前会转换为已有 blob input。

## State

CLI 与 MCP 只有在使用同一 state directory 时才共享 Task/Attempt。切换入口不能用新 UUID 重放一个已经发送或处于 indeterminate 的任务。
