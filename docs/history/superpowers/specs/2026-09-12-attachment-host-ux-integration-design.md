# Attachment Host UX Integration 设计

日期：2026-09-12。

## 目标

让能把聊天/connector 附件物化成本机临时文件的宿主直接调用 Unified MCP，而不要求调用方理解 `source` / `blob`、手工读取文件或拼 base64。

目标体验：

```text
conversation attachment
  -> host gives local temp path + original display name
  -> uagents_submit / uagents_council_submit
  -> existing blob/source ingestion
  -> snapshot / capability / target mapping
```

Core request schema、CLI 和 target adapter 不新增第二套 attachment contract。

## Host-facing contract

Unified MCP 的 `uagents_submit` / `uagents_council_submit` 在原有 `inputs` 之外接受：

```json
{
  "attachments": [
    {
      "type": "file",
      "local_path": "C:\\host-temp\\upload-42.tmp",
      "name": "requirements.pdf"
    }
  ]
}
```

字段：

- `type`: `file | image`；
- `local_path`: 宿主已经物化的绝对本地文件路径；
- `name`: 可选，用户看到的原始文件名；省略时使用本地文件 basename。

`inputs` 与 `attachments` 严格二选一。CLI/Core 继续只公开既有 `inputs: path/source/blob`。

## 归一化语义

MCP host adapter 在进入 Runtime 前读取 `local_path`，转换为现有：

```json
{
  "type": "file",
  "blob": {
    "name": "requirements.pdf",
    "data_base64": "..."
  }
}
```

之后完全复用现有 Core parser、attachment ingestion、snapshot、Council fan-out 和 target mapping。

选择内部 blob 而不是把临时路径直接作为 Core `source` 的原因：

- request identity 由文件内容 + display name 决定，不由宿主临时路径决定；
- 同一个 request UUID 重试时即使 temp path 改变，只要 bytes/name 相同仍保持幂等；
- 临时宿主路径不会进入 Task/Council 持久化历史；
- Council 继续复用已有 blob fan-out 到各 member worktree 的能力。

## 边界

- host adapter 只读取调用方显式提供的本地文件；
- `local_path` 必须绝对路径且指向 regular file；
- 继续沿用 file 32 MiB、image 20 MiB、总计 64 MiB 限制；
- `name` 必须是 filename，不允许目录分隔符或控制字符；
- 图片 MIME/尺寸仍由现有 Core attachment pipeline 最终验证；
- opaque Drive/Slack/mail connector ID 仍不由 uAgents 解析；
- bytes-only host 仍可直接使用既有 `inputs.blob`；
- 不新增 URL download、connector SDK、provider fallback、permission flag 或 provider 调用。

## 明确不做

- 不改变 Schema 1.0 Core request；
- 不给 CLI 新增 host-only 字段；
- 不持久化 `local_path`；
- 不把附件路径降级拼进 prompt；
- 不根据文件扩展名绕过图片 header 校验；
- 不自动获取宿主未明确提供的 conversation files。
