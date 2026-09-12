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
| WorkBuddy | true | true | true | stream-json document/image blocks |
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
  -> WorkBuddy / OpenCode native mapping
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

blob ingestion 本身可完全 provider-free 验证。它不会新增 provider 调用，也不会改变 WorkBuddy/OpenCode 已有 transport。真实 provider attachment E2E 仍需要用户单独明确授权。

验证证据见 [Connector / Blob Attachment Input 验证](../verification/2026-09-12-connector-blob-attachment-input.md) 与 [Attachment Host UX Integration 验证](../verification/2026-09-12-attachment-host-ux-integration.md)。

## 当前验证

```text
Unified MCP targeted              13/13

Core                             312/312
Doubao MCP                        11/11
TRAE MCP                           9/9
Unified MCP                       13/13
Total                            345/345
```

Attachment Host UX Integration 的第一轮完整回归只命中既有 OpenCode durable delayed-session 10 秒 wall-clock timing 抖动；该 durable 文件隔离重跑 4/4，第二轮完整 `npm test` 得到上面的 345/345。本轮没有发送新的 provider prompt。
