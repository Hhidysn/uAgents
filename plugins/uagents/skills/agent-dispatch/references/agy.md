# agy：当前为受限预览

本机验证基线：agy 1.1.22、Node 24.13.0、Windows。CLI 由 PATH 发现，插件不内置 CLI、登录凭据或本机安装路径。无 npm 运行依赖。

## 真实验证状态

2026-08-31，无提示词握手的 `init.tools` 返回完整工具集，包括写文件、命令和浏览器操作。自定义 Agent 的空列表和显式 `view_file` 列表均未让 init 报告受限集合；期间还出现账户资格检查 EOF。尚不能确认实际运行期权限，因此不能把此适配器作为已通过验收的只读 Agent 执行器。

脚本保留失败关闭的入口：只在原生 init 明确报告 **零工具**、指定模型、指定 agent、准确工作目录以及受控 permission_mode 时才发送提示词。`plan` 指令和终端 sandbox 不等于这些条件。未来更换 CLI 或权限方案后，仍须重新完成真实能力验证。

## 请求与命令

请求 JSON 仅支持以下字段；未知字段会拒绝，不能默默忽略权限要求：

```json
{
  "request_id": "9de3b16c-f16f-44a0-8c5a-a436a35d6d4f",
  "target": "agy",
  "model": "gemini-3.1-pro-low",
  "mode": "analysis",
  "prompt": "仅依据这段需求，为个人待办页面给出三条布局建议：单列任务列表、添加按钮、已完成分组。",
  "timeout_ms": 120000
}
```

示例模型不是自动默认值。实际使用前核对目标和当前可用模型；每次有意的新任务生成新的 UUID。请求正文不要放进命令行参数，避免 Windows 命令行转义和长度问题。

下列路径占位应替换为实际绝对路径：

```powershell
node "<skill目录>/scripts/agent-call.mjs" capabilities
node "<skill目录>/scripts/agent-call.mjs" submit --request "<请求JSON路径>" --state-dir "<状态目录>"
node "<skill目录>/scripts/agent-call.mjs" status --id "<request_id>" --state-dir "<状态目录>"
node "<skill目录>/scripts/agent-call.mjs" result --id "<request_id>" --state-dir "<状态目录>"
node "<skill目录>/scripts/agent-call.mjs" cancel --id "<request_id>" --state-dir "<状态目录>"
```

仅检查环境时，把动词换成 `probe`，并从请求 JSON 去掉 `prompt`。probe 不发送 user 消息；其成功只表示预检通过。

worker 在每个任务的私有目录创建独立工作目录和自定义 Agent 定义，不改调用方项目或全局配置。该目录本身不是 OS 沙箱；保护依赖执行前的原生能力门禁，而不是目录名。

## 状态和失败处理

| 返回 | 含义与处理 |
| --- | --- |
| `starting` / `preflight` | worker 启动或正在核对 CLI；尚未发送提示词 |
| `running` | 已记录发送意图，可能已发出；不要重复提交 |
| `succeeded` | 本次运行有匹配的原生结果；probe 的范围仍仅为 preflight_only |
| `blocked` | 身份或工具限制不能核实；不放宽参数，不改全局设置 |
| `failed` | 明确失败；查看是否 not_sent，仍不自动重试 |
| `needs_user` | 原生请求需要处理或权限被拒绝；不要自动批准 |
| `cancelled` | 确认发送前停止，或原生返回明确取消结果 |
| `unknown` | 发送后断线、超时/取消未确认、结果不匹配或心跳过期；需人工核对原生会话 |

同一 UUID 和相同有效输入返回已有任务，不重复发送；输入不同返回 `request_conflict`。已有登记不完整时也不启动替代任务。不要通过换 UUID 绕过未知状态。

当前只验证短工具调用退出后的后台存活；未验证关闭 Codex、注销 Windows、重启或系统休眠。15 秒未见 worker 心跳时，查询按未知处理；这不是自动判断远端停止。取消不按保存的 PID 批量杀进程。

## 数据与限制

必要答案保存为 `result.json`，状态保存标识、摘要和错误码；worker 读取后删除自己的短期 `inbox.json`。外部调用方创建的原请求 JSON 不会被自动删除；登记/启动异常也可能留下 inbox。只在任务已经核对结束后处理这些文件。

本版无自动清理、保留期或容量管理，状态目录按本机用户权限使用，不面向不可信本机进程或多用户隔离。插件自身不记录完整原生事件日志，CLI 的账户历史、缓存与其自身记录政策另行适用。

不支持读取项目、owned_paths 限制、修改代码、图像输入/生成、续接、跨供应商回退、远端取消确认。真实 agy 文本任务尚未通过验收，不能用模拟测试替代这一结论。

依据：[Headless CLI](https://antigravity.google/docs/cli/headless/)、[权限规则](https://antigravity.google/docs/cli/permissions/)、[自定义 Agent](https://antigravity.google/docs/subagents)。具体调用字段同时以当前 `agy --help` 为准。
