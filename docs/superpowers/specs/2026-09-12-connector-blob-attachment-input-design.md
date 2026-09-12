# Connector / Blob Attachment Input 设计

日期：2026-09-12。

## 目标

让聊天附件、connector 文件、内存文件等已经由宿主取得 bytes 的输入，可以直接进入现有 uAgents attachment pipeline，而不要求用户先知道或管理一个本地绝对路径。

uAgents 继续保持薄 orchestration：Core 不绑定 Google Drive、Slack、邮件等 connector SDK，也不解析厂商 opaque file ID。connector/宿主负责取得文件 bytes；uAgents 负责统一验证、物化、snapshot 和 target mapping。

## Public contract

Schema 1.0 attachment 保持 `type:"file"|"image"`，位置来源扩展为三选一：

```json
{ "type": "file", "path": "requirements.md" }
{ "type": "file", "source": "F:\\Downloads\\requirements.pdf" }
{
  "type": "file",
  "blob": {
    "name": "requirements.pdf",
    "data_base64": "JVBERi0xLjc..."
  }
}
```

`path`、`source`、`blob` 严格三选一。既有请求无需修改。

## 功能语义

- `path`：workspace 内已有文件。
- `source`：宿主已经有绝对本地文件路径。
- `blob`：宿主只有文件 bytes，不需要先创建一个用户可见本地路径。
- connector 宿主若拿到 opaque file reference，应先通过自己的 connector API 获取 bytes，再把 bytes 作为 blob 提交。
- blob 注册后立即归一化为现有 `.uagents/inputs/<sha256>-<name>` workspace-relative attachment；target adapter 仍只消费 `{type,path}`。
- WorkBuddy/OpenCode 不需要新增 blob-specific transport。

## Identity / persistence

- blob bytes 不进入 SQLite。
- 普通 Task 的持久化 request/payload 只保存归一化后的 `{type,path}` 与 attachment snapshot，不保存 `data_base64`。
- Council fan-out 可以共享同一个 blob input；每个 implementation member 在自己的 worktree 中得到独立 materialized attachment。
- Council `request.json` 只保留 blob 名称、MIME、size、SHA-256、图片尺寸等 identity evidence，`data_base64` 写为 null，不保存原始 blob payload。
- idempotency 仍把原始 blob 内容纳入原始请求 identity，因此同 UUID 换 blob 内容会 conflict。

## Limits

现有附件限制不改变：

- generic file：32 MiB/item；
- image：20 MiB/item；
- total inputs：64 MiB；
- image whitelist/dimensions/pixels 限制保持不变。

base64 只是一种 ingestion representation，不改变实际附件 byte limit。CLI `--request-stdin` 仍有 1 MiB request 上限；较大的 inline blob 应使用 `--request <file>` 或 Unified MCP/宿主调用。

## 非目标

- 不让 Core 直接联网下载 URL；
- 不在 Core 内解析 Google Drive/Slack/邮件等 opaque connector ID；
- 不新增 provider 权限或 native permission flags；
- 不改变 target attachment capability；
- 不把 blob bytes 存入 SQLite。
