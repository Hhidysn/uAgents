# Connector / Blob Attachment Input 验证

日期：2026-09-12。

## Provider boundary

本轮验证全部 provider-free，没有发送 WorkBuddy/OpenCode/agy/桌面 Agent prompt。

## 已覆盖

- Core parser 接受 `path` / `source` / `blob` 严格三选一；
- blob filename/base64 contract；
- generic file blob 与 PNG blob 物化；
- stored Task request/payload 不包含 base64 blob payload；
- snapshot 继续记录 PDF/image MIME、SHA-256、尺寸；
- Unified MCP schema 接受 blob；
- Unified MCP handler 实际 submit blob 后归一化到 `.uagents/inputs/...`；
- implementation Council 同一个 blob fan-out 到两个独立 member worktree；
- Council persisted request 只保留 blob identity，`data_base64=null`；
- exact Council resubmit 继续复用成员 Tasks/worktrees；
- 现有 source/path behavior 保持兼容。

## Targeted

```text
Attachment/Council/CLI targeted   56/56
Unified MCP targeted               9/9
```

## 完整门禁

```text
Core                             304/304
Doubao MCP                        11/11
TRAE MCP                           9/9
Unified MCP                        9/9
Total                            333/333
```

## 限制

- Core 不直接解析 opaque connector ID；host/connector 需要先取得 bytes；
- 不支持 URL download；
- CLI stdin 仍有 1 MiB request limit；大 blob 用 request file 或 MCP/host；
- 本轮不执行 provider-billable attachment E2E。
