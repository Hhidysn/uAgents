# Local Service Reference

入口：`bin/uagents-service.mjs` / `bin/uagents-mcp-bridge.mjs`。服务配置版本 `1.0`，Task / Council schema 与[协议](protocol.md)一致。安装与示例见[当前服务](../current/service.md)。

| 命令 | 行为 |
| --- | --- |
| `describe` / `--help` | 输出命令与配置 schema，不启动 Core |
| `schema config` | 输出 JSON Schema |
| `init --config FILE` | 初始化私有配置和 token，拒绝覆盖 |
| `serve --config FILE` | 启动 loopback MCP 与调度进程 |
| `health --config FILE` | 查询认证健康接口 |

init 支持可重复的 `--workspace ROOT` / `--target TARGET`，以及 `--port` / `--state-dir` / `--registry-config`。文件和目录参数须为绝对路径。

| 配置字段 | 默认 / 要求 |
| --- | --- |
| `schema_version` | 必须 `"1.0"` |
| `host` | 仅 `"127.0.0.1"` |
| `port` | `4319`，0–65535；0 供程序化临时测试，宿主使用固定端口 |
| `state_dir` | 必填，绝对路径；init 默认本机 Core v1 目录 |
| `token_file` | 必填，绝对路径；init 默认配置旁 `service-token` |
| `registry_config` | `null`；绝对 Core registry 配置路径 |
| `workspace_roots` | 非空、绝对、现存目录数组；realpath 范围 |
| `targets` | 非空内置 target 数组；init 默认九个目标 |
| `tools` | 默认 20 个工具；非空已知工具子集 |
| `poll_interval_ms` | `1000`，100–60000 |
| `max_workers` | `4`，1–32；调度 worker 容量 |
| `max_tool_children` | `4`，1–32；并发工具子进程容量 |
| `tool_timeout_ms` | `300000`，1000–3600000；请求确认期限 |
| `max_request_bytes` | 16 MiB，1 KiB–128 MiB；HTTP 请求体上限 |

不接受未知字段。服务 child environment 剔除 `UAGENTS_SERVICE_*` / `UAGENTS_TOKEN*` / `UAGENTS_ENDPOINT*`，固定 state/registry 路径。Provider 环境来自独立服务的启动环境；调用方环境不会改变它。

`/mcp` 与 `GET /health` 都要求 Bearer。Host 仅接受 `127.0.0.1` / `localhost`，Origin 若存在须对应本服务端口。认证失败 `401`，Host/Origin 被拒 `403`，请求体超限 `413`。工具结果使用现有 uAgents envelope。

bridge 使用 `--config FILE`，或 `--endpoint http://127.0.0.1:<port>/mcp --token-file FILE`；拒绝其它 host、TLS、用户名、query、fragment 和 redirect。init/serve/health 不输出 token 内容。

桥接无法确认工具响应时返回 `service_tool_response_unconfirmed`、`category=transport`、`submission=may_have_been_sent`。工具子进程未启动时可返回 `not_sent`，启动后 timeout/响应损坏保留不确定性。Core 明确失败则保留原 code/category/submission。

`service_busy` 表示工具容量已满；先查询原任务，再决定是否重试。HTTP 会话不是 Task 生命周期，断开不等于取消；取消使用 `uagents_cancel`。
