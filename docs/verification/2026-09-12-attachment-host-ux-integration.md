# Attachment Host UX Integration 验证

日期：2026-09-12。

## Provider 边界

本功能只验证本地 host attachment normalization 与已有 attachment pipeline，没有发送新的 Agent/provider prompt。

## Targeted evidence

Unified MCP 测试覆盖：

- `tools/list` 暴露 `attachments` / `local_path`；
- host attachment 保留原始 display name；
- host temp path 不进入 persisted Task request/payload；
- 内部 base64 不进入 persisted Task request/payload；
- 同一 UUID + 同一 name/bytes 在不同 temp path 上重试仍为 duplicate；
- Council host attachment 在进入 Core 前转换成已有 blob contract；
- `inputs` 与 `attachments` 互斥；
- relative/nonexistent local path 与非法 display name 被拒绝。

Targeted：

```text
Unified MCP   13/13
```

## 实现边界

Core request schema 与 CLI contract 未增加 `attachments`。host-only field 只存在于 Unified MCP tool schema；进入 `UnifiedRuntime` 前已经变成现有 `inputs.blob`，后续行为由现有 Core attachment contract 决定。

## 完整回归

```text
Core           312/312
Doubao MCP      11/11
TRAE MCP         9/9
Unified MCP      13/13
Total          345/345
```

第一轮完整回归只命中既有 `OpenCode recovery discovers a delayed session without replaying the prompt` 的 10 秒 wall-clock timing 抖动；该 durable 文件隔离运行 4/4，未修改 OpenCode runtime 或测试等待窗口。第二轮完整 `npm test` 全绿。
