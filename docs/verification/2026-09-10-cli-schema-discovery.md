# CLI Schema Discovery 验证

日期：2026-09-10。

## 验证目标

1. `describe` / `describe submit` 能返回 machine-readable CLI contract。
2. `schema request` 能返回当前 Schema 1.0 Draft 2020-12 JSON Schema。
3. discovery 不需要 Task state root，不加载 Runtime 才能工作。
4. CLI `parseArgs` option names 与 discovery 使用同一导出定义。
5. request discovery schema 复用 Core parser 的字段/枚举/限制常量。
6. Unified MCP submit schema 与 Core discovery schema 的主要结构保持一致。
7. 现有 runtime / attachments / session continuation 回归不受影响。

## Provider-free 命令

```text
node plugins/uagents/bin/uagents.mjs describe submit
node plugins/uagents/bin/uagents.mjs schema request
node --test tests/unified-cli.test.mjs
npm --prefix plugins/uagents/mcp/unified test
npm test
```

实际 discovery 命令只输出 JSON envelope，没有 discovery-only SQLite warning，也没有创建 Task 或发送 Prompt。

## 结果

Targeted：

```text
Unified CLI      14/14
Unified MCP       6/6
```

Full gate：

```text
Core            280/280
Doubao MCP       11/11
TRAE MCP          9/9
Unified MCP       6/6
Total           306/306
```

## 边界

- JSON Schema 是 discovery contract，Core `parseRequest` 仍是运行时权威 validator。
- byte length / local path 规则通过 `x-uagents-*` metadata 表达，而不是错误地冒充标准 JSON Schema `maxLength` 语义。
- 没有新增 MCP schema tool；MCP 继续依赖标准 `tools/list`。
- 没有进行 provider-billable 调用。
