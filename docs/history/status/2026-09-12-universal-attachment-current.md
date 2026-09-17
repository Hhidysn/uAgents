# Universal Attachment Input 当前状态

日期：2026-09-12。本文是当前附件能力的权威状态入口。

## 当前 contract

Schema 1.0 的 `file` / `image` 输入支持三种等价入口：

```text
workspace-relative path
absolute local source
inline blob { name, data_base64 }
```

三者严格三选一，最终都归一化成 workspace 内 `.uagents/inputs/...`（外部 source/blob）或原有 workspace-relative path，再进入同一 snapshot / capability / target transport 链路。

这意味着聊天、connector 或其它宿主只要已经能取得附件 bytes，就可以直接把附件交给 uAgents，不再需要先暴露一个用户可管理的本地路径。uAgents 不解析 connector 厂商 ID；connector/宿主负责取得 bytes，uAgents 接收通用 blob。

Unified MCP 另外提供 host-facing `attachments:[{type,local_path,name?}]` 便捷入口。它只存在于 MCP tool schema：宿主给出已经物化的绝对临时路径和可选原始文件名，MCP 层在进入 Core 前把文件转换为现有 blob input。Core request schema、CLI 和 target adapter 没有新增第四种 attachment 类型。

## Target mapping

| Target | workspace readable | native file | native image | Mapping |
| --- | ---: | ---: | ---: | --- |
| agy 1.1.27 | true | false | false | 无已验证 native attachment mapping，继续 fail-closed |
| WorkBuddy 2.132.0 | true | false | model-specific | `default/auto` 拒绝 image；显式 `deepseek-v4.1-flash` 真实 E2E 成功；generic file 仍拒绝 |
| OpenCode | true | true | true | repeated native `--file` |
| Doubao Work | false | false | false | text-only current path |
| TRAE CN | true | false | false | no verified attachment mapping |

blob/source 只解决 ingestion，不提升 target capability。一个 target 原本不支持 native file/image attachment，换成 blob 也不会绕过能力检查。

## Blob behavior

- `blob.name` 是附件显示/物化文件名，不是路径。
- `blob.data_base64` 是原始文件 bytes 的 base64 representation。
- 注册前沿用现有文件/图片类型、大小、MIME、图片尺寸验证。
- 注册后 Task request 只保存 `{type,path}`；snapshot 保存 type/path/media type/bytes/SHA-256，图片再保存尺寸。
- blob bytes 不进入 SQLite，也不传到 target-specific schema。
- implementation Council 会把同一个 blob 分别物化到各 member worktree；Council 历史 request 只保留 blob identity evidence，不保存 base64 原文。

## Connector boundary

当前 Core 不接受 opaque connector file ID 并自行联网解析。推荐宿主流程是：

```text
chat / Drive / Slack / mail attachment
  -> host connector obtains bytes
  -> uAgents blob input
  -> normal attachment snapshot
  -> target capability gate
  -> OpenCode file+image native mapping / WorkBuddy deepseek-v4.1-flash image mapping
```

如果宿主已经把 conversation attachment 物化成临时本地文件，则 Unified MCP 可以直接使用：

```text
host temp file + original display name
  -> MCP attachments[{ type, local_path, name }]
  -> existing blob input
  -> normal attachment pipeline
```

host temp path 不进入 request identity 或持久化历史；相同 request UUID 以相同 display name + bytes 从另一个 temp path 重试仍保持幂等。只有 bytes、没有可用本地路径的宿主继续使用现有 `inputs.blob`。

因此 connector integration 不需要进入 uAgents target registry，也不会给 Core 增加特定厂商依赖。

## Limits

- file：32 MiB/item；
- image：20 MiB/item；
- inputs total：64 MiB；
- image：PNG/JPEG/GIF/WebP，最大边 16,384 px，总像素 64 Mi；
- CLI `--request-stdin` 仍最多 1 MiB，因此较大 blob 用 request file 或 MCP/host entrypoint。

## Provider boundary

blob ingestion 本身可完全 provider-free 验证。真实 WorkBuddy 2.132.0 E2E 已在 2026-09-13 验证出两层边界：generic `document -> input_file` 在 backend/default route 返回 `400 Parse message failed: unsupported content type ... file`，因此 WorkBuddy `files=false`；backend-selected `auto` 也拒绝 image-bearing request。但显式 native `--model deepseek-v4.1-flash` 对一张 512×512 RGB PNG 成功返回 `RED_OK`，因此 target transport 恢复 `images=true`，同时 `workbuddy-default` route 以 model-specific input policy 收紧为 `images=false`，只有批准的 `deepseek-v4.1-flash` route 保持 `images=true`。

验证证据见 [Connector / Blob Attachment Input 验证](../../verification/2026-09-12-connector-blob-attachment-input.md)、[Attachment Host UX Integration 验证](../../verification/2026-09-12-attachment-host-ux-integration.md)、[WorkBuddy generic file 真实 E2E](../../verification/2026-09-13-real-workbuddy-file-attachment-e2e.md) 与 [WorkBuddy image 真实 E2E](../../verification/2026-09-13-real-workbuddy-image-attachment-e2e.md)。

## 当前验证

```text
Unified MCP targeted              13/13

Core                             316/316
Doubao MCP                        11/11
TRAE MCP                           9/9
Unified MCP                       13/13
Total                            349/349
```

WorkBuddy generic-file capability correction 后的第一轮完整回归只命中既有 OpenCode durable delayed-session 10 秒 wall-clock timing 抖动；该 durable 文件隔离重跑 4/4，第二轮完整 `npm test` 得到上面的 346/346。随后 image capability correction 的完整 `npm test` 一次直接得到 346/346。2026-09-13 的真实 WorkBuddy attachment 验证先确认 backend/default `auto` 不支持 generic file 且拒绝 image-bearing request，随后在用户将目标明确到 `deepseek-v4.1-flash` 后，用 native `--model deepseek-v4.1-flash` + 512×512 RGB PNG 得到 `success / RED_OK`，证明图片能力属于具体模型路线而非整个 backend-default route。
