# CLI Schema Discovery 当前状态

日期：2026-09-10。本文以当前仓库源码为准。

## 当前结论

uAgents CLI 已提供 provider-free、machine-readable discovery：

```text
node <plugin-root>/bin/uagents.mjs describe
node <plugin-root>/bin/uagents.mjs describe <command>
node <plugin-root>/bin/uagents.mjs schema request
```

`describe` 返回 CLI command contract，包括 usage、positionals、options、互斥约束和 effect。
`schema request` 返回统一请求的 Draft 2020-12 JSON Schema。

这两个命令在 Runtime 模块加载前处理，因此不会打开 Task DB，也不会因为 `node:sqlite` 加载产生 discovery-only warning；
不会启动 Agent 或联系 Provider。

## Source of truth

CLI flags 的 Node `parseArgs` 定义与 discovery 共用：

```text
src/cli/discovery.mjs -> CLI_PARSE_OPTIONS
```

统一请求的字段名、枚举和主要限制由：

```text
src/protocol/schema.mjs
```

导出，Core parser 与：

```text
src/protocol/request-json-schema.mjs
```

共同使用。Core parser 仍是最终 admission authority。

## 请求 Schema 范围

当前 machine-readable request schema 包含：

- Schema 1.0 required fields；
- target/model/mode/prompt/workspace；
- file/image attachment 与 path/source；
- expected outputs；
- execution timeout/effort/permission/native args；
- policy；
- session continuation。

标准 JSON Schema 无法精确表达 byte-length 与跨平台 absolute/local path 语义，因此使用
`x-uagents-max-bytes` 与 `x-uagents-path` 扩展元数据；真正校验仍由 Core 执行。

## MCP 边界

Unified MCP 本来就通过 `tools/list` 暴露 `uagents_submit` input schema，因此没有增加重复 MCP discovery tool。
当前测试比较 CLI/Core discovery schema 与 MCP submit schema 的顶层 required/properties、mode、effort、permission、
attachment type 和 session field，降低两条入口的明显 schema drift。

## 验证

```text
Core            280/280
Doubao MCP       11/11
TRAE MCP          9/9
Unified MCP       6/6
Total           306/306
```

本功能不发送 provider prompt，不修改 target-native CLI mapping，也不增加权限、sandbox 或 fallback 行为。
