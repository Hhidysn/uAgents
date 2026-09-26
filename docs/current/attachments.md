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
| Codex CLI | true | false | true |
| Claude Code CLI | true | PDF / UTF-8 text | true |
| WorkBuddy default | true | false | false |
| WorkBuddy `deepseek-v4.1-flash` | true | false | true |
| DSH | true | false | true (SDK 映射；真实 Task 未确认) |
| OpenCode | true | true | true |
| Doubao | false | false | false |
| TRAE | true | false | false |

Ingestion 能力不会提升 target capability。一个 target 不支持 native file/image 时，改用 `blob` 也不会绕过能力检查。

## 原生映射与验证边界

- Codex CLI `exec` / `resume` / `fork` 使用 `--image <absolute-path>`；显式 app-server 路线使用 `turn/start` 的 `localImage`。注册快照在 native send 前再次核对。本机 Luna 真实 Task 的原生会话记录含与输入 PNG SHA-256 相同的图片；该次模型颜色回答不正确，不能据此声称视觉判断质量已验证。
- Claude Code CLI 有附件时改用 `--input-format stream-json`，发送同一条 user message 中的 `image`、`document` 内容块。文件仅接受 PDF 或有效 UTF-8 文本；其它二进制文件在 native send 前拒绝。真实 DeepSeek Flash Task 的原生会话记录含图片、文本和 PDF 三个内容块，回复识别了文本/PDF token 和图片主色；原生权限拒绝使该 Task 状态为 `waiting_user`，uAgents 不代为批准。
- DSH SDK `session/prompt` 支持内联图片 `{type:"image",data,mimeType}`；当前文件块需要 DSH 自己的持久化附件引用，uAgents 不把普通文件路径冒充该引用。图片映射有协议/fixture 测试，真实 Task 在首次发送后原生进程退出，结果为 `indeterminate`，没有自动重发。
- OpenCode 继续使用原生 `--file`；WorkBuddy generic file 和 default/auto image 仍按既有负面真实验证关闭。agy、Doubao、TRAE 尚无经核实的原生附件映射。

能力布尔值表示 uAgents 有 native transport 映射，不保证每个用户选择的 Provider/model 都接受该附件。未知或自定义模型 ID 可交给原生 target 判定；实际失败仍按 Task 状态记录。详情见 [2026-09-26 验证记录](../verification/2026-09-26-native-attachment-input.md)。

## Limits

- file：32 MiB/item
- image：20 MiB/item
- total：64 MiB
- image：PNG/JPEG/GIF/WebP
- 最大边：16,384 px
- 最大总像素：64 Mi
- CLI `--request-stdin`：最多 1 MiB，因此大 blob 应使用 request file 或 MCP host entrypoint

真实附件 E2E 证据见 `docs/verification/2026-09-13-real-workbuddy-file-attachment-e2e.md` 和 `docs/verification/2026-09-13-real-workbuddy-image-attachment-e2e.md`。
