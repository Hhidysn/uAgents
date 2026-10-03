# 当前附件能力

Schema 1.0 的 `file` / `image` 输入支持三种 Core 入口：

```json
{"type":"file","path":"requirements.md"}
```

```json
{"type":"file","source":"F:\\Downloads\\brief.pdf"}
```

```json
{"type":"file","blob":{"name":"brief.pdf","data_base64":"..."}}
```

`path`、`source`、`blob` 严格三选一。

## 归一化与路径

- `path` 引用 workspace 内文件，realpath 不能越过 workspace。
- `source` 引用绝对本地文件，`blob` 接受宿主已取得的 bytes；两者在注册前物化到 `.uagents/inputs/`。
- 写入前核对目标目录的 realpath；已有目标必须是内容一致的普通文件，符号链接和多硬链接目标被拒绝。
- 注册后的 Task request 只保留归一化 `{type,path}`，blob 原文不进入 SQLite。
- snapshot 记录类型、路径、MIME、字节数和 SHA-256；图片另记录尺寸，native send 前再次核对。

通过共享服务提交时，源附件还必须在服务配置允许的 workspace roots 内，凭据不能作为附件；见 [服务范围](service.md#运行与恢复边界)。

## Unified MCP 宿主附件

宿主已经把附件物化成本地临时文件时，可使用：

```json
{
  "attachments": [
    {"type":"file","local_path":"C:\\host-temp\\upload.tmp","name":"brief.pdf"}
  ]
}
```

`attachments` 是 MCP 专用字段，与 `inputs` 严格二选一。进入 Core 前转换为 blob；临时 `local_path` 不进入 Task identity 或最终历史记录。

## 原生映射与能力限制

目标矩阵见 [Agent 能力](agents.md)。Ingestion 不会提升 target capability；不支持的 file/image 不能通过换用 blob 绕过。

- Codex 图片通过 `--image <absolute-path>`，显式 app-server 路线使用 `turn/start.localImage`；generic file 关闭。
- Claude Code 有附件时使用 `--input-format stream-json`，同一 user message 包含 `image` / `document` 内容块。文件只接受 PDF 或有效 UTF-8 文本，权限仍由原生 Agent 处理。
- DSH 的 `session/prompt` 映射 `{type:"image",data,mimeType}`；图片端到端成功未确认，普通文件不冒充 DSH 持久化引用。
- OpenCode 文件和图片均使用 `--file`；WorkBuddy 图片只开放给 `deepseek-v4.1-flash`。agy、Doubao 和 TRAE 无原生附件映射。

`models <target>` 的 `input_support.files` / `images` 展示逐路线准入与证据：`allowed` 表示当前策略接收，`verification` 表示证据层级，`observed_on` 是证据日期。映射不保证任意模型都接受输入或正确理解内容；字段解释见 [模型与路由](models.md)。

## 大小与格式

| 输入 | 限制 |
| --- | --- |
| file | 每项 32 MiB |
| image | 每项 20 MiB；PNG/JPEG/GIF/WebP |
| 总字节数 | 64 MiB |
| 图片尺寸 | 最大边 16,384 px；最大总像素 64 Mi |
| CLI stdin 请求 | 1 MiB；大 blob 使用请求文件或 MCP 附件入口 |

送达、模型回复及未确认结果见 [原生附件验证](../verification/2026-09-26-native-attachment-input.md)；WorkBuddy 的 [文件](../verification/2026-09-13-real-workbuddy-file-attachment-e2e.md) 与 [图片](../verification/2026-09-13-real-workbuddy-image-attachment-e2e.md) 验证分别记录。
