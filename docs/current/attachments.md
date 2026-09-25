# 当前附件能力

Schema 1.0 的 `file` / `image` 输入支持三种 Core 入口：

```json
{"type":"file","path":"requirements.md"}
{"type":"file","source":"F:\\Downloads\\brief.pdf"}
{"type":"file","blob":{"name":"brief.pdf","data_base64":"..."}}
```

`path`、`source`、`blob` 严格三选一。

## 归一化

- `path` 直接引用 workspace 内文件。
- `source` 引用绝对本地文件，注册前物化到 workspace 的 `.uagents/inputs/`。
- `blob` 接受宿主已经取得的 bytes，也会物化到 `.uagents/inputs/`。
- 注册后的 Task request 只保留归一化后的 `{type,path}`；blob 原文不进入 SQLite。
- snapshot 记录类型、路径、MIME、字节数和 SHA-256；图片再记录尺寸。

## Unified MCP host attachment

聊天或 connector 宿主已经把附件写成本地临时文件时，可以使用：

```json
{
  "attachments": [
    {
      "type": "file",
      "local_path": "C:\\host-temp\\upload.tmp",
      "name": "brief.pdf"
    }
  ]
}
```

该字段只存在于 MCP host schema。进入 Core 前会被转换为已有 blob contract；临时 `local_path` 不进入最终 Task identity 或历史记录。

## Target capability

| Target | Workspace readable | File | Image |
| --- | ---: | ---: | ---: |
| agy | true | false | false |
| Codex CLI | true | false | false |
| Claude Code CLI | true | false | false |
| WorkBuddy default | true | false | false |
| WorkBuddy `deepseek-v4.1-flash` | true | false | true |
| DSH | true | false | false |
| OpenCode | true | true | true |
| Doubao | false | false | false |
| TRAE | true | false | false |

Ingestion 能力不会提升 target capability。一个 target 不支持 native file/image 时，改用 `blob` 也不会绕过能力检查。

## Limits

- file：32 MiB/item
- image：20 MiB/item
- total：64 MiB
- image：PNG/JPEG/GIF/WebP
- 最大边：16,384 px
- 最大总像素：64 Mi
- CLI `--request-stdin`：最多 1 MiB，因此大 blob 应使用 request file 或 MCP host entrypoint

真实附件 E2E 证据见 `docs/verification/2026-09-13-real-workbuddy-file-attachment-e2e.md` 和 `docs/verification/2026-09-13-real-workbuddy-image-attachment-e2e.md`。
